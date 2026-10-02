import assert from "node:assert/strict";
import { createHandler as createUpload } from "../admin-create-upload/handler.ts";
import { createHandler as createSync } from "../admin-sync-video/handler.ts";
import { createHandler as createDelete } from "../admin-delete-class/handler.ts";
import { createHandler as createPlayback } from "../playback/handler.ts";
import { HttpError, readJson } from "../_shared/http.ts";
import { enforceRateLimit, LIMITS } from "../_shared/rate-limit.ts";
import { MAX_DURATION_SECONDS, parseDurationSeconds } from "../_shared/validate.ts";
import { isUsableVideo, MAX_VIDEO_BYTES } from "../_shared/video-state.ts";
import { makeDeps, post, USER_ID } from "./fakes.ts";

const errCode = async (r: Response) => (await r.json()).error?.code;

// =============================================================== duración estricta
Deno.test("parseDurationSeconds: solo números finitos entre 1 s y 24 h (null/undefined = no informada)", () => {
  assert.equal(parseDurationSeconds(undefined), null);
  assert.equal(parseDurationSeconds(null), null);
  assert.equal(parseDurationSeconds(1), 1);
  assert.equal(parseDurationSeconds(2700.4), 2700.4);
  assert.equal(parseDurationSeconds(MAX_DURATION_SECONDS), MAX_DURATION_SECONDS);

  // Antes, Number(valor) dejaba pasar casi todo esto (o desbordaba el integer de la base y daba 500).
  for (
    const bad of [
      "5",
      "",
      "abc",
      true,
      false,
      [],
      [5],
      {},
      0,
      -1,
      0.5,
      NaN,
      Infinity,
      -Infinity,
      1e12,
      MAX_DURATION_SECONDS + 1,
    ]
  ) {
    assert.throws(
      () => parseDurationSeconds(bad),
      (e: unknown) => e instanceof HttpError && e.status === 400 && e.code === "invalid_input",
      `debería rechazar ${JSON.stringify(bad)}`,
    );
  }
});

Deno.test("sync-video: una duración inválida se rechaza con 400 y no toca la clase ni R2", async () => {
  const { deps, repo, r2 } = makeDeps();
  const row = repo.addClass({ r2_object_key: "classes/a/b.mp4", video_status: "pending" });
  r2.putObject("classes/a/b.mp4");
  const h = createSync(deps);
  for (const bad of ["5", 1e12, -3, true, []]) {
    const res = await h(post({ class_id: row.id, duration_seconds: bad }, "developer"));
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(await errCode(res), "invalid_input");
  }
  assert.equal(repo.classes.get(row.id)!.video_status, "pending");
  assert.equal(r2.calls.filter((c) => c.op === "headObject").length, 0);
});

// =============================================================== tope del cuerpo, en bytes
Deno.test("readJson: el tope cuenta BYTES (tildes y emojis pesan más que su .length)", async () => {
  // 9000 "ñ" = 9000 caracteres pero 18000 bytes: antes pasaba el tope de 16 KiB porque se medía .length.
  const body = JSON.stringify({ title: "ñ".repeat(9000) });
  assert.ok(body.length < 16 * 1024 && new TextEncoder().encode(body).length > 16 * 1024);
  await assert.rejects(
    readJson(post(body)),
    (e: unknown) => e instanceof HttpError && e.status === 413 && e.code === "payload_too_large",
  );
});

Deno.test("readJson: corta por Content-Length declarado sin leer el cuerpo, y acepta un cuerpo normal", async () => {
  await assert.rejects(
    readJson(post({ a: 1 }, undefined, { "content-length": String(1024 * 1024) })),
    (e: unknown) => e instanceof HttpError && e.status === 413,
  );
  assert.deepEqual(await readJson(post({ title: "Yoga ñandú 🧘" })), { title: "Yoga ñandú 🧘" });
  assert.deepEqual(await readJson(post("")), {});
  await assert.rejects(readJson(post("[1,2]")), (e: unknown) => e instanceof HttpError && e.code === "invalid_json");
  await assert.rejects(readJson(post("{roto")), (e: unknown) => e instanceof HttpError && e.code === "invalid_json");
});

Deno.test("endpoint: un cuerpo enorme da 413 por la vía normal (no 500)", async () => {
  const { deps } = makeDeps();
  const res = await createUpload(deps)(post(JSON.stringify({ title: "x".repeat(20_000) }), "developer"));
  assert.equal(res.status, 413);
  assert.equal(await errCode(res), "payload_too_large");
});

// =============================================================== cabeceras
Deno.test("toda respuesta JSON (éxito y error) lleva nosniff y no-store", async () => {
  const { deps } = makeDeps();
  const ok = await createUpload(deps)(post({ title: "A" }, "developer"));
  const denied = await createUpload(deps)(post({ title: "A" }));
  const wrongMethod = await createUpload(deps)(new Request("https://fn.test/x", { method: "GET" }));
  for (const r of [ok, denied, wrongMethod]) {
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
});

// =============================================================== límite de frecuencia
Deno.test("rate limit: playback corta con 429 + Retry-After al pasar el máximo, y no firma nada de más", async () => {
  const { deps, repo, r2 } = makeDeps();
  const row = repo.addClass({
    is_published: true,
    video_status: "ready",
    r2_object_key: "classes/a/b.mp4",
    duration_seconds: 600,
  });
  const h = createPlayback(deps);

  for (let i = 0; i < LIMITS.playback.max; i++) {
    assert.equal((await h(post({ class_id: row.id }, "user"))).status, 200, `petición ${i + 1}`);
  }
  const signedBefore = r2.calls.filter((c) => c.op === "signPlayback").length;

  const blocked = await h(post({ class_id: row.id }, "user"));
  assert.equal(blocked.status, 429);
  assert.equal(await errCode(blocked), "rate_limited");
  assert.equal(blocked.headers.get("retry-after"), String(LIMITS.playback.windowSeconds));
  assert.equal(r2.calls.filter((c) => c.op === "signPlayback").length, signedBefore, "no se firmó otra URL");

  // El límite es POR USUARIO: otra persona no se ve afectada.
  assert.equal((await h(post({ class_id: row.id }, "user2"))).status, 200);
});

Deno.test("rate limit: sin sesión no consume cupo (401 antes de contar) y el cupo es por función", async () => {
  const { deps, limiter, repo } = makeDeps();
  const row = repo.addClass({ is_published: true, video_status: "ready", r2_object_key: "classes/a/b.mp4" });
  for (let i = 0; i < 5; i++) await createPlayback(deps)(post({ class_id: row.id }));
  assert.equal(limiter.hits.size, 0, "las peticiones sin sesión no deben tocar el contador");

  await createPlayback(deps)(post({ class_id: row.id }, "user"));
  assert.deepEqual([...limiter.hits.keys()], [`playback:${USER_ID}`]);
});

Deno.test("rate limit: las funciones administrativas también limitan (subida, confirmación, borrado)", async () => {
  const { deps, repo } = makeDeps();
  const row = repo.addClass({ r2_object_key: "classes/a/b.mp4", video_status: "pending" });

  const upload = createUpload(deps);
  for (let i = 0; i < LIMITS.createUpload.max; i++) await upload(post({ title: `C${i}` }, "developer"));
  assert.equal((await upload(post({ title: "una más" }, "developer"))).status, 429);

  const sync = createSync(deps);
  for (let i = 0; i < LIMITS.syncVideo.max; i++) await sync(post({ class_id: row.id }, "developer"));
  assert.equal((await sync(post({ class_id: row.id }, "developer"))).status, 429);

  const del = createDelete(deps);
  const missing = crypto.randomUUID();
  for (let i = 0; i < LIMITS.deleteClass.max; i++) {
    assert.equal((await del(post({ class_id: missing }, "developer"))).status, 404);
  }
  assert.equal((await del(post({ class_id: missing }, "developer"))).status, 429);
});

Deno.test("rate limit: si el limitador se cae, la petición PASA (disponibilidad) y queda registrado", async () => {
  const { deps, limiter, repo } = makeDeps();
  const row = repo.addClass({ is_published: true, video_status: "ready", r2_object_key: "classes/a/b.mp4" });
  limiter.broken = true;
  const original = console.error;
  const logged: string[] = [];
  console.error = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    const res = await createPlayback(deps)(post({ class_id: row.id }, "user"));
    assert.equal(res.status, 200);
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((l) => l.includes("[rate-limit]")));
});

Deno.test("rate limit: caer el limitador NUNCA abre un acceso (la autorización va antes y es independiente)", async () => {
  const { deps, limiter, repo } = makeDeps();
  const restricted = repo.addClass({
    is_published: true,
    video_status: "ready",
    access_level: "restricted",
    r2_object_key: "classes/a/b.mp4",
  });
  limiter.broken = true;
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await createPlayback(deps)(post({ class_id: restricted.id }, "user"))).status, 403);
    assert.equal((await createUpload(deps)(post({ title: "x" }, "user"))).status, 403);
  } finally {
    console.error = original;
  }
});

Deno.test("enforceRateLimit: usa la clave scope:usuario y la ventana configurada", async () => {
  const { limiter } = makeDeps();
  await enforceRateLimit(limiter, "mi-scope", "u1", { max: 2, windowSeconds: 30 });
  await enforceRateLimit(limiter, "mi-scope", "u1", { max: 2, windowSeconds: 30 });
  await assert.rejects(
    enforceRateLimit(limiter, "mi-scope", "u1", { max: 2, windowSeconds: 30 }),
    (e: unknown) => e instanceof HttpError && e.status === 429 && e.headers["Retry-After"] === "30",
  );
  await enforceRateLimit(limiter, "mi-scope", "u2", { max: 2, windowSeconds: 30 }); // otra persona
  await enforceRateLimit(limiter, "otro-scope", "u1", { max: 2, windowSeconds: 30 }); // otra función
});

// =============================================================== un "video" que no es video
Deno.test("isUsableVideo: rechaza vacío, enorme y no-video; no objeta lo que R2 no informa", () => {
  assert.equal(isUsableVideo({ exists: false }), false);
  assert.equal(isUsableVideo({ exists: true, size: 5_000_000, contentType: "video/mp4" }), true);
  assert.equal(isUsableVideo({ exists: true, size: 5_000_000, contentType: "VIDEO/quicktime" }), true);
  assert.equal(isUsableVideo({ exists: true }), true);
  assert.equal(isUsableVideo({ exists: true, size: 0, contentType: "video/mp4" }), false);
  assert.equal(isUsableVideo({ exists: true, size: MAX_VIDEO_BYTES + 1, contentType: "video/mp4" }), false);
  assert.equal(isUsableVideo({ exists: true, size: 1000, contentType: "text/html" }), false);
  assert.equal(isUsableVideo({ exists: true, size: 1000, contentType: "application/zip" }), false);
  assert.equal(isUsableVideo({ exists: true, size: 1000, contentType: "application/octet-stream" }), false);
});

Deno.test("sync-video: un objeto vacío o que no es video deja la clase en 'failed' y la despublica", async () => {
  for (const [size, contentType] of [[0, "video/mp4"], [4096, "text/html"]] as const) {
    const { deps, repo, r2 } = makeDeps();
    const row = repo.addClass({
      r2_object_key: "classes/a/b.mp4",
      video_status: "ready",
      is_published: true,
      duration_seconds: 600,
    });
    r2.putObject("classes/a/b.mp4", size, contentType);

    const res = await createSync(deps)(post({ class_id: row.id, duration_seconds: 600 }, "developer"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.class.video_status, "failed", `${size}/${contentType}`);
    assert.equal(body.class.is_published, false, "una clase con video inválido nunca queda publicada");
    assert.equal(body.object_found, true);
  }
});

Deno.test("sync-video: un archivo inválido no recibe la duración que mande el navegador", async () => {
  const { deps, repo, r2 } = makeDeps();
  const row = repo.addClass({ r2_object_key: "classes/a/b.mp4", video_status: "pending" });
  r2.putObject("classes/a/b.mp4", 0);
  const body = await (await createSync(deps)(post({ class_id: row.id, duration_seconds: 900 }, "developer"))).json();
  assert.equal(body.class.video_status, "failed");
  assert.equal(body.class.duration_seconds, null);
});

Deno.test("flujo completo: video inválido -> 'failed' -> reintento reemplaza la key y BORRA el objeto malo de R2", async () => {
  const { deps, repo, r2 } = makeDeps();
  const created = await (await createUpload(deps)(post({ title: "Clase" }, "developer"))).json();
  const id = created.class.id as string;
  const badKey = [...repo.classes.values()][0].r2_object_key!;
  r2.putObject(badKey, 3, "text/html"); // el navegador "subió" otra cosa

  const synced = await (await createSync(deps)(post({ class_id: id, duration_seconds: 600 }, "developer"))).json();
  assert.equal(synced.class.video_status, "failed");

  const retry = await (await createUpload(deps)(post({ title: "Clase", class_id: id }, "developer"))).json();
  const newKey = repo.classes.get(id)!.r2_object_key!;
  assert.notEqual(newKey, badKey);
  assert.equal(retry.class.video_status, "pending");
  assert.equal(r2.objects.has(badKey), false, "el objeto inválido no queda ocupando (ni cobrando) almacenamiento");

  r2.putObject(newKey, 8_000_000, "video/mp4");
  const ok = await (await createSync(deps)(post({ class_id: id, duration_seconds: 600 }, "developer"))).json();
  assert.equal(ok.class.video_status, "ready");
  assert.equal(ok.class.duration_seconds, 600);
});
