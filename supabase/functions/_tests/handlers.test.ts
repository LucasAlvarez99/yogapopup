import assert from "node:assert/strict";
import { createHandler as createUpload } from "../admin-create-upload/handler.ts";
import { createHandler as createSync } from "../admin-sync-video/handler.ts";
import { createHandler as createDelete } from "../admin-delete-class/handler.ts";
import { createHandler as createPlayback } from "../playback/handler.ts";
import { createHandler as createHealth } from "../health/handler.ts";
import { ADMIN_ID, makeDeps, post, USER_ID } from "./fakes.ts";

const ORIGIN = "https://yogapopup.test";
const errCode = async (r: Response) => (await r.json()).error?.code;

// =============================================================== admin-create-upload
Deno.test("create-upload: sin sesión 401, usuario común 403, admin OK", async () => {
  const { deps } = makeDeps();
  const h = createUpload(deps);
  assert.equal((await h(post({ title: "A" }))).status, 401);
  const r = await h(post({ title: "A" }, "user"));
  assert.equal(r.status, 403);
  assert.equal(await errCode(r), "owner_only");
  assert.equal((await h(post({ title: "A" }, "owner"))).status, 200);
});

Deno.test("create-upload: crea clase + URL prefirmada de R2; nunca expone la key en la clase", async () => {
  const { deps, r2, repo } = makeDeps();
  const r = await createUpload(deps)(
    post({ title: "  Yoga para principiantes ", level: "principiante", category: "Vinyasa", sort_order: 3 }, "owner"),
  );
  assert.equal(r.status, 200);
  const body = await r.json();

  assert.equal(body.class.title, "Yoga para principiantes");
  assert.equal(body.class.is_published, false);
  assert.equal(body.class.video_status, "pending");
  assert.equal("r2_object_key" in body.class, false);
  assert.match(body.upload.url, /^https:\/\/fake-r2\.test\//);
  assert.equal(body.upload.expire, 1_800_000_000 + deps.config.uploadTtlSeconds);

  const saved = [...repo.classes.values()][0];
  assert.equal((saved as unknown as { created_by: string }).created_by, ADMIN_ID); // queda registrado quién la creó
  assert.equal(saved.r2_object_key, body.upload.key);
  assert.ok(r2.calls.some((c) => c.op === "createUploadUrl"));
});

Deno.test("create-upload: validaciones de entrada (400) y nada llega a R2 ni a la base", async () => {
  const { deps, r2, repo } = makeDeps();
  const h = createUpload(deps);
  for (
    const bad of [
      {},
      { title: "" },
      { title: 5 },
      { title: "x".repeat(151) },
      { title: "a", level: "experto" },
      { title: "a", access_level: "vip" },
      { title: "a", sort_order: 1.5 },
      { title: "a", class_id: "no-uuid" },
    ]
  ) {
    const r = await h(post(bad, "owner"));
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(await errCode(r), "invalid_input");
  }
  assert.equal((await h(post("no es json", "owner"))).status, 400);
  assert.equal((await h(post("[]", "owner"))).status, 400);
  assert.equal((await h(post("x".repeat(20_000), "owner"))).status, 413);
  assert.equal(r2.calls.length, 0);
  assert.equal(repo.classes.size, 0);
});

Deno.test("create-upload: si falla la base, no se llega a pedir nada a R2", async () => {
  const { deps, r2, repo } = makeDeps();
  repo.failInsert = true;
  const r = await createUpload(deps)(post({ title: "A" }, "owner"));
  assert.equal(r.status, 500);
  assert.equal(await errCode(r), "internal_error");
  assert.equal(r2.calls.length, 0); // no hay nada que compensar: la clase nunca se creó
});

Deno.test("create-upload: R2 caído -> 502; la clase queda creada para poder reintentar", async () => {
  const { deps, r2, repo } = makeDeps();
  r2.failWith = { op: "createUploadUrl", status: 503 };
  const r = await createUpload(deps)(post({ title: "A" }, "owner"));
  assert.equal(r.status, 502);
  assert.equal(await errCode(r), "video_provider_error");
  // la clase queda creada (insertClass fue antes que R2 en el flujo) pero sin URL de subida:
  // el admin puede reintentar con el mismo class_id y se reintenta createUploadUrl.
  assert.equal(repo.classes.size, 1);
});

Deno.test("create-upload: asociar video a clase sin video; 404 si la clase no existe", async () => {
  const { deps, repo, r2 } = makeDeps();
  const h = createUpload(deps);
  const c = repo.addClass({ title: "Existente" });
  const ok = await h(post({ title: "ignorado", class_id: c.id }, "owner"));
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.resumed, false);
  assert.ok(repo.classes.get(c.id)!.r2_object_key);
  assert.equal(repo.classes.get(c.id)!.r2_object_key, body.upload.key);
  assert.equal((await h(post({ title: "x", class_id: crypto.randomUUID() }, "owner"))).status, 404);
  void r2;
});

Deno.test("create-upload: subida interrumpida (pending/uploading) se REANUDA con la misma key", async () => {
  const { deps, repo, r2 } = makeDeps();
  const h = createUpload(deps);
  for (const status of ["pending", "uploading"] as const) {
    const key = r2.newObjectKey(crypto.randomUUID());
    const c = repo.addClass({ r2_object_key: key, video_status: status });
    const r = await h(post({ title: "x", class_id: c.id }, "owner"));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.resumed, true);
    assert.equal(body.upload.key, key); // misma key, nada nuevo en R2
    assert.equal(repo.classes.get(c.id)!.r2_object_key, key);
  }
});

Deno.test("create-upload: video fallido se REEMPLAZA y se borra la key vieja de R2", async () => {
  const { deps, repo, r2 } = makeDeps();
  const oldKey = r2.newObjectKey(crypto.randomUUID());
  r2.putObject(oldKey); // llegó a subirse algo antes de fallar
  const c = repo.addClass({ r2_object_key: oldKey, video_status: "failed" });
  const r = await createUpload(deps)(post({ title: "x", class_id: c.id }, "owner"));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.notEqual(body.upload.key, oldKey);
  assert.equal(repo.classes.get(c.id)!.r2_object_key, body.upload.key);
  assert.equal(repo.classes.get(c.id)!.video_status, "pending");
  assert.equal(r2.objects.has(oldKey), false); // sin huérfanos
});

Deno.test("create-upload: video en uso (processing/ready) -> 409 y no se toca R2", async () => {
  const { deps, repo, r2 } = makeDeps();
  const h = createUpload(deps);
  for (const status of ["processing", "ready"] as const) {
    const key = r2.newObjectKey(crypto.randomUUID());
    const c = repo.addClass({ r2_object_key: key, video_status: status });
    const before = r2.calls.length;
    const r = await h(post({ title: "x", class_id: c.id }, "owner"));
    assert.equal(r.status, 409);
    assert.equal(await errCode(r), "video_already_attached");
    assert.equal(r2.calls.length, before);
  }
});

// =============================================================== admin-sync-video
Deno.test("sync-video: refleja si el objeto existe en R2 y guarda la duración que manda el navegador; solo admin", async () => {
  const { deps, repo, r2 } = makeDeps();
  const key = r2.newObjectKey(crypto.randomUUID());
  const c = repo.addClass({ r2_object_key: key });
  const h = createSync(deps);

  assert.equal((await h(post({ class_id: c.id }, "user"))).status, 403);

  // todavía no se subió nada
  let body = await (await h(post({ class_id: c.id }, "owner"))).json();
  assert.equal(body.class.video_status, "pending");
  assert.equal(body.object_found, false);

  r2.putObject(key);
  body = await (await h(post({ class_id: c.id, duration_seconds: 2699.6 }, "owner"))).json();
  assert.equal(body.object_found, true);
  assert.equal(body.class.video_status, "ready");
  assert.equal(body.class.duration_seconds, 2700);
  assert.equal(body.class.is_published, false); // nunca publica solo
});

Deno.test("sync-video: si el objeto desaparece, una clase publicada se despublica (respeta el CHECK)", async () => {
  const { deps, repo, r2 } = makeDeps();
  const key = r2.newObjectKey(crypto.randomUUID());
  const c = repo.addClass({ r2_object_key: key, video_status: "ready", is_published: true });
  // no se llama a r2.putObject(key): el objeto no existe (se borró a mano en el bucket, por ejemplo)
  const r = await createSync(deps)(post({ class_id: c.id }, "owner"));
  assert.equal(r.status, 200); // el fake lanzaría si se violara el CHECK
  const body = await r.json();
  assert.equal(body.class.video_status, "failed");
  assert.equal(body.class.is_published, false);
});

Deno.test("sync-video: video que nunca llegó a subirse -> 409 sin video; clase inexistente -> 404", async () => {
  const { deps, repo } = makeDeps();
  const h = createSync(deps);
  const none = repo.addClass();
  assert.equal((await h(post({ class_id: none.id }, "owner"))).status, 409);
  assert.equal((await h(post({ class_id: crypto.randomUUID() }, "owner"))).status, 404);
});

Deno.test("sync-video: duration_seconds inválido -> 400", async () => {
  const { deps, repo } = makeDeps();
  const c = repo.addClass({ r2_object_key: "classes/x/a.mp4" });
  const r = await createSync(deps)(post({ class_id: c.id, duration_seconds: -1 }, "owner"));
  assert.equal(r.status, 400);
  assert.equal(await errCode(r), "invalid_input");
});

// =============================================================== admin-delete-class
Deno.test("delete-class: borra el objeto de R2 y la clase; solo admin", async () => {
  const { deps, repo, r2 } = makeDeps();
  const key = r2.newObjectKey(crypto.randomUUID());
  r2.putObject(key);
  const c = repo.addClass({ r2_object_key: key });
  const h = createDelete(deps);
  assert.equal((await h(post({ class_id: c.id }, "user"))).status, 403);
  assert.equal(repo.classes.size, 1);

  const r = await h(post({ class_id: c.id }, "owner"));
  assert.deepEqual(await r.json(), { deleted: true, class_id: c.id, video_deleted: true });
  assert.equal(repo.classes.size, 0);
  assert.equal(r2.objects.has(key), false);
});

Deno.test("delete-class: borra también la miniatura; si Storage falla no rompe el borrado", async () => {
  const { deps, repo } = makeDeps();
  const h = createDelete(deps);
  const a = repo.addClass({
    thumbnail_url: "https://x.supabase.co/storage/v1/object/public/class-thumbnails/a/1.webp",
  });
  assert.equal((await h(post({ class_id: a.id }, "owner"))).status, 200);
  assert.deepEqual(repo.deletedThumbnails, [a.thumbnail_url]);

  repo.failThumbnailDelete = true;
  const b = repo.addClass({
    thumbnail_url: "https://x.supabase.co/storage/v1/object/public/class-thumbnails/b/1.webp",
  });
  const r = await h(post({ class_id: b.id }, "owner"));
  assert.equal(r.status, 200); // la clase ya se borró: la miniatura es secundaria
  assert.equal(repo.classes.has(b.id), false);
});

Deno.test("delete-class: si R2 falla NO se borra la clase (se puede reintentar)", async () => {
  const { deps, repo, r2 } = makeDeps();
  const key = r2.newObjectKey(crypto.randomUUID());
  const c = repo.addClass({ r2_object_key: key });
  r2.failWith = { op: "deleteObject", status: 500 };
  const r = await createDelete(deps)(post({ class_id: c.id }, "owner"));
  assert.equal(r.status, 502);
  assert.equal(repo.classes.size, 1);
  assert.equal(repo.deleteCalls, 0);
});

Deno.test("delete-class: objeto ya borrado en R2 (404) igual limpia la clase; sin video también", async () => {
  const { deps, repo } = makeDeps();
  const h = createDelete(deps);
  const a = repo.addClass({ r2_object_key: "classes/x/ya-borrado.mp4" });
  assert.equal((await (await h(post({ class_id: a.id }, "owner"))).json()).video_deleted, false);
  const b = repo.addClass();
  assert.equal((await h(post({ class_id: b.id }, "owner"))).status, 200);
  assert.equal(repo.classes.size, 0);
  assert.equal((await h(post({ class_id: crypto.randomUUID() }, "owner"))).status, 404);
});

// =============================================================== playback
function readyClass(access: "free" | "restricted" = "free", extra = {}) {
  const ctx = makeDeps();
  const key = ctx.r2.newObjectKey(crypto.randomUUID());
  ctx.r2.putObject(key);
  const c = ctx.repo.addClass({
    r2_object_key: key,
    video_status: "ready",
    is_published: true,
    duration_seconds: 2700,
    access_level: access,
    ...extra,
  });
  return { ...ctx, c, key };
}

Deno.test("playback: sin sesión 401; con sesión y acceso -> URL firmada + resume", async () => {
  const { deps, c, key, repo } = await readyClass();
  const h = createPlayback(deps);
  assert.equal((await h(post({ class_id: c.id }))).status, 401);
  assert.equal((await h(post({ class_id: c.id }, "token-falso"))).status, 401);

  repo.progress.set(`${USER_ID}|${c.id}`, { progress_seconds: 1663, completed: false }); // 27:43
  const r = await h(post({ class_id: c.id }, "user"));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const b = await r.json();
  assert.equal(b.resume_seconds, 1663);
  assert.equal(b.duration_seconds, 2700);
  assert.ok(b.video_url.includes(key));
  assert.ok(b.video_url.includes("sig=play"));
  assert.equal(b.expires_at, 1_800_000_000 + 7200);
});

Deno.test("playback: clase restringida -> 403 sin entitlement, 200 con entitlement", async () => {
  const { deps, c, auth } = await readyClass("restricted");
  const h = createPlayback(deps);
  const denied = await h(post({ class_id: c.id }, "user"));
  assert.equal(denied.status, 403);
  const deniedText = await denied.text();
  assert.equal(JSON.parse(deniedText).error.code, "no_access");
  assert.ok(!deniedText.includes("sig=play")); // ni rastro de la URL firmada

  auth.entitlements.set(USER_ID, new Set([c.id]));
  assert.equal((await h(post({ class_id: c.id }, "user"))).status, 200);
  assert.equal((await h(post({ class_id: c.id }, "user2"))).status, 403); // otro usuario sigue sin acceso
});

Deno.test("playback: clase no publicada -> 403 (no revela que existe); admin sí puede previsualizar", async () => {
  const { deps, c, repo } = await readyClass("free");
  repo.classes.get(c.id)!.is_published = false;
  const h = createPlayback(deps);
  const r = await h(post({ class_id: c.id }, "user"));
  assert.equal(r.status, 403);
  const ghost = await h(post({ class_id: crypto.randomUUID() }, "user"));
  assert.equal(ghost.status, 403); // misma respuesta que "no publicada"
  assert.equal((await h(post({ class_id: c.id }, "owner"))).status, 200);
});

Deno.test("playback: video no listo -> 409 (caso admin en clase sin video)", async () => {
  const { deps, repo } = makeDeps();
  const c = repo.addClass({ video_status: "processing" });
  const r = await createPlayback(deps)(post({ class_id: c.id }, "owner"));
  assert.equal(r.status, 409);
  assert.equal(await errCode(r), "video_not_ready");
});

Deno.test("playback: reglas de 'continuar' (menos de 5 s o terminada -> desde 0)", async () => {
  const { deps, c, repo } = await readyClass();
  const h = createPlayback(deps);
  const resume = async (s: number, completed = false) => {
    repo.progress.set(`${USER_ID}|${c.id}`, { progress_seconds: s, completed });
    return (await (await h(post({ class_id: c.id }, "user"))).json()).resume_seconds;
  };
  assert.equal(await resume(0), 0);
  assert.equal(await resume(4), 0);
  assert.equal(await resume(5), 5);
  assert.equal(await resume(2564), 2564); // 94.96 %
  assert.equal(await resume(2565, true), 0); // 95 %: vuelve a empezar
  assert.equal(await resume(2700, true), 0);
});

Deno.test("playback: el progreso es por usuario", async () => {
  const { deps, c, repo } = await readyClass();
  repo.progress.set(`${USER_ID}|${c.id}`, { progress_seconds: 900, completed: false });
  const b = await (await createPlayback(deps)(post({ class_id: c.id }, "user2"))).json();
  assert.equal(b.resume_seconds, 0);
});

Deno.test("playback: class_id inválido -> 400", async () => {
  const { deps } = makeDeps();
  assert.equal((await createPlayback(deps)(post({ class_id: "1 OR 1=1" }, "user"))).status, 400);
  assert.equal((await createPlayback(deps)(post({}, "user"))).status, 400);
});

// =============================================================== health + CORS + método
Deno.test("health: 200 si la base responde, 503 si no; pública", async () => {
  const { deps, repo } = makeDeps();
  const h = createHealth(deps);
  const get = () => new Request("https://fn.test/h", { method: "GET" });
  assert.equal((await h(get())).status, 200);
  repo.pingFails = true;
  const r = await h(get());
  assert.equal(r.status, 503);
  assert.equal(await errCode(r), "db_unavailable");
});

Deno.test("CORS: preflight y reflejo de origen solo si está permitido", async () => {
  const { deps } = makeDeps();
  const h = createPlayback(deps);
  const pre = await h(new Request("https://fn.test/p", { method: "OPTIONS", headers: { origin: ORIGIN } }));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);

  const evil = await h(post({ class_id: crypto.randomUUID() }, "user", { origin: "https://evil.test" }));
  assert.equal(evil.headers.get("access-control-allow-origin"), null);

  const ok = await h(post({ class_id: crypto.randomUUID() }, "user", { origin: ORIGIN }));
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(ok.headers.get("vary"), "Origin");

  // también en las respuestas de error
  const noAuth = await h(post({}, undefined, { origin: ORIGIN }));
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.headers.get("access-control-allow-origin"), ORIGIN);
});

Deno.test("método no permitido -> 405", async () => {
  const { deps } = makeDeps();
  assert.equal((await createPlayback(deps)(new Request("https://fn.test/p", { method: "GET" }))).status, 405);
  assert.equal((await createUpload(deps)(new Request("https://fn.test/p", { method: "DELETE" }))).status, 405);
});
