import assert from "node:assert/strict";
import { createEndpoint } from "../_shared/http.ts";
import { createHandler as createUpload } from "../admin-create-upload/handler.ts";
import { createHandler as createSync } from "../admin-sync-video/handler.ts";
import { createHandler as createDelete } from "../admin-delete-class/handler.ts";
import { createHandler as createPlayback } from "../playback/handler.ts";
import { ADMIN_ID, DEV_ID, makeDeps, post } from "./fakes.ts";

const codeOf = async (r: Response) => (await r.json()).error?.code;

/** Endpoint mínimo protegido solo para desarrolladores (el panel técnico real llega en una fase posterior). */
function devOnlyEndpoint(deps: ReturnType<typeof makeDeps>["deps"]) {
  return createEndpoint({
    methods: ["POST"],
    allowedOrigins: [],
    run: async (req) => ({ ok: true, actor: (await deps.auth.requireDeveloper(req)).id }),
  });
}

Deno.test("roles: matriz de acceso — usuario, propietario y desarrollador en cada nivel", async () => {
  const { deps, repo } = makeDeps();
  const c = repo.addClass();
  const level = {
    // función de negocio (owner o superior)
    owner: [createUpload(deps), createSync(deps), createDelete(deps)],
  };
  const body = { title: "x", class_id: c.id };

  for (const h of level.owner) {
    assert.equal((await h(post(body))).status, 401, "sin sesión");
    const asUser = await h(post(body, "user"));
    assert.equal(asUser.status, 403);
    assert.equal(await codeOf(asUser), "owner_only");
  }
  // propietario y desarrollador sí entran a las funciones de negocio
  assert.equal((await createUpload(deps)(post({ title: "de owner" }, "owner"))).status, 200);
  assert.equal((await createUpload(deps)(post({ title: "de developer" }, "developer"))).status, 200);

  // el nivel técnico: solo el desarrollador
  const tech = devOnlyEndpoint(deps);
  assert.equal((await tech(post({}))).status, 401);
  for (const token of ["user", "owner"]) {
    const r = await tech(post({}, token));
    assert.equal(r.status, 403, `${token} no debe entrar al nivel técnico`);
    assert.equal(await codeOf(r), "developer_only");
  }
  const ok = await tech(post({}, "developer"));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).actor, DEV_ID);
});

Deno.test("roles: el usuario final solo usa la app pública (playback), nunca la administración", async () => {
  const { deps, repo, r2 } = makeDeps();
  const key = r2.newObjectKey(crypto.randomUUID());
  r2.putObject(key);
  const c = repo.addClass({ r2_object_key: key, video_status: "ready", is_published: true });
  assert.equal((await createPlayback(deps)(post({ class_id: c.id }, "user"))).status, 200);
  for (const h of [createUpload(deps), createSync(deps), createDelete(deps)]) {
    assert.equal((await h(post({ class_id: c.id, title: "x" }, "user"))).status, 403);
  }
  assert.equal(repo.classes.has(c.id), true, "el usuario no pudo borrar nada");
});

Deno.test("auditoría: subir un video registra quién, qué y sobre qué (best effort)", async () => {
  const { deps, audit } = makeDeps();
  const r = await createUpload(deps)(post({ title: "Yoga suave" }, "owner"));
  assert.equal(r.status, 200);
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].actorId, ADMIN_ID);
  assert.equal(audit.entries[0].action, "class.upload_prepared");
  assert.equal(audit.entries[0].entityType, "class");
  assert.equal(audit.entries[0].details?.title, "Yoga suave");
});

Deno.test("auditoría: si falla el registro, subir NO se rompe (no es destructivo)", async () => {
  const { deps, audit, repo } = makeDeps();
  audit.fail = true;
  const r = await createUpload(deps)(post({ title: "Yoga suave" }, "owner"));
  assert.equal(r.status, 200);
  assert.equal(repo.classes.size, 1);
});

Deno.test("auditoría: borrar registra ANTES de borrar y, si no se puede auditar, no se borra nada", async () => {
  const { deps, audit, repo, r2 } = makeDeps();
  const key = r2.newObjectKey(crypto.randomUUID());
  r2.putObject(key);
  const c = repo.addClass({ title: "A borrar", r2_object_key: key, is_published: false });

  audit.fail = true; // el historial no responde
  const blocked = await createDelete(deps)(post({ class_id: c.id }, "owner"));
  assert.equal(blocked.status, 500);
  assert.equal(repo.classes.has(c.id), true, "la clase sigue existiendo");
  assert.equal(r2.objects.has(key), true, "el objeto en R2 sigue existiendo");

  audit.fail = false;
  const ok = await createDelete(deps)(post({ class_id: c.id }, "developer"));
  assert.equal(ok.status, 200);
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].action, "class.delete");
  assert.equal(audit.entries[0].actorId, DEV_ID);
  assert.deepEqual(audit.entries[0].details, { title: "A borrar", had_video: true, was_published: false });
  assert.equal(repo.classes.has(c.id), false);
});

Deno.test("auditoría: un usuario rechazado por permisos no deja registros ni efectos", async () => {
  const { deps, audit, repo } = makeDeps();
  const c = repo.addClass();
  await createDelete(deps)(post({ class_id: c.id }, "user"));
  assert.equal(audit.entries.length, 0);
  assert.equal(repo.classes.has(c.id), true);
});

Deno.test("contrato: el frontend traduce los códigos de rol que devuelve el backend", async () => {
  const messages = await Deno.readTextFile(new URL("../../../js/lib/errors.js", import.meta.url));
  for (const code of ["owner_only", "developer_only"]) {
    assert.ok(messages.includes(code), `errors.js no traduce ${code}`);
  }
});
