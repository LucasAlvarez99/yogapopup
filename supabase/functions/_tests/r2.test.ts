import assert from "node:assert/strict";
import { R2Error, R2Service } from "../_shared/r2/r2.service.ts";
import { NOW } from "./fakes.ts";

const ACCOUNT = "abc123";
const BUCKET = "test-bucket";

function makeR2(fetchImpl: typeof fetch) {
  return new R2Service({
    accountId: ACCOUNT,
    accessKeyId: "key-id",
    secretAccessKey: "secret",
    bucket: BUCKET,
    fetchImpl,
    nowSeconds: () => NOW,
  });
}

Deno.test("R2Service: configuración inválida falla al construir", () => {
  const ok = { accountId: "a", accessKeyId: "k", secretAccessKey: "s", bucket: "b" };
  assert.throws(() => new R2Service({ ...ok, accountId: "" }));
  assert.throws(() => new R2Service({ ...ok, accessKeyId: "" }));
  assert.throws(() => new R2Service({ ...ok, secretAccessKey: "" }));
  assert.throws(() => new R2Service({ ...ok, bucket: "" }));
});

Deno.test("R2Service: newObjectKey siempre es una key válida bajo classes/<id>/", () => {
  const r2 = makeR2(() => Promise.reject(new Error("no debería llamar a la red")));
  const key = r2.newObjectKey("11111111-1111-4111-8111-111111111111");
  assert.match(key, /^classes\/11111111-1111-4111-8111-111111111111\/[0-9a-f-]{36}\.mp4$/);
});

Deno.test("R2Service: createUploadUrl firma un PUT con expiración en la query", async () => {
  const r2 = makeR2(() => Promise.reject(new Error("createUploadUrl no debe pegarle a la red")));
  const up = await r2.createUploadUrl("classes/x/a.mp4", 3600);
  assert.equal(up.key, "classes/x/a.mp4");
  assert.equal(up.expire, NOW + 3600);
  const url = new URL(up.url);
  assert.equal(url.hostname, `${ACCOUNT}.r2.cloudflarestorage.com`);
  assert.equal(url.pathname, `/${BUCKET}/classes/x/a.mp4`);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "3600");
  assert.ok(url.searchParams.get("X-Amz-Signature"));
  assert.ok(!up.url.includes("secret")); // la secret key nunca sale en la URL
});

Deno.test("R2Service: signPlayback firma un GET con expiración en la query", async () => {
  const r2 = makeR2(() => Promise.reject(new Error("signPlayback no debe pegarle a la red")));
  const pb = await r2.signPlayback("classes/x/a.mp4", 7200);
  assert.equal(pb.expiresAt, NOW + 7200);
  const url = new URL(pb.url);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "7200");
});

Deno.test("R2Service: headObject existente / inexistente", async () => {
  const calls: string[] = [];
  const r2 = makeR2((input) => {
    const req = input as Request;
    calls.push(req.method);
    if (req.url.includes("/presente.mp4")) {
      return Promise.resolve(new Response(null, { status: 200, headers: { "content-length": "1234" } }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  const a = await r2.headObject("classes/x/presente.mp4");
  assert.deepEqual(a, { exists: true, size: 1234 });
  const b = await r2.headObject("classes/x/ausente.mp4");
  assert.deepEqual(b, { exists: false });
  assert.deepEqual(calls, ["HEAD", "HEAD"]);
});

Deno.test("R2Service: deleteObject es idempotente (404 -> false, sin error)", async () => {
  const r2 = makeR2((input) => {
    const req = input as Request;
    assert.equal(req.method, "DELETE");
    return Promise.resolve(new Response(null, { status: req.url.includes("borrar") ? 204 : 404 }));
  });
  assert.equal(await r2.deleteObject("classes/x/borrar.mp4"), true);
  assert.equal(await r2.deleteObject("classes/x/no-existe.mp4"), false);
});

Deno.test("R2Service: errores del servidor no filtran las credenciales", async () => {
  const r2 = makeR2(() => Promise.resolve(new Response("upstream error", { status: 500 })));
  const err = await r2.headObject("classes/x/a.mp4").catch((e) => e);
  assert.ok(err instanceof R2Error);
  assert.equal(err.status, 500);
  assert.ok(!err.message.includes("secret"));

  const r2Net = makeR2(() => Promise.reject(new TypeError("boom secret")));
  const netErr = await r2Net.headObject("classes/x/a.mp4").catch((e) => e);
  assert.ok(netErr instanceof R2Error && !netErr.message.includes("secret"));
});

Deno.test("R2Service: keys con path-injection son rechazadas antes de llegar a la red", async () => {
  const r2 = makeR2(() => Promise.reject(new Error("no debería llamar a la red")));
  for (const bad of ["../../etc/passwd", "", "a b", "x?y"]) {
    await assert.rejects(r2.headObject(bad), R2Error);
    await assert.rejects(r2.deleteObject(bad), R2Error);
    await assert.rejects(r2.signPlayback(bad, 60), R2Error);
    await assert.rejects(r2.createUploadUrl(bad, 60), R2Error);
  }
});
