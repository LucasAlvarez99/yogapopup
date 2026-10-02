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

Deno.test("roles: matriz completa — quién puede qué (subir = developer · gestionar = admin y developer)", async () => {
  const { deps, repo, r2 } = makeDeps();
  const mkClass = () => {
    const key = r2.newObjectKey(crypto.randomUUID());
    r2.putObject(key);
    return repo.addClass({ r2_object_key: key, video_status: "ready", is_published: false });
  };
  // La subida crea su propia clase (sin class_id); sincronizar y borrar necesitan una clase existente.
  const call = (h: (req: Request) => Promise<Response>, token?: string, creates = false) => () => {
    if (creates) return h(post({ title: "x" }, token));
    return h(post({ class_id: mkClass().id }, token));
  };

  // [función, quién entra, código de rechazo]
  const upload = {
    name: "admin-create-upload",
    h: createUpload(deps),
    allowed: ["developer"],
    deny: "developer_only",
    creates: true,
  };
  const sync = {
    name: "admin-sync-video",
    h: createSync(deps),
    allowed: ["admin", "developer"],
    deny: "admin_only",
    creates: false,
  };
  const del = {
    name: "admin-delete-class",
    h: createDelete(deps),
    allowed: ["admin", "developer"],
    deny: "admin_only",
    creates: false,
  };

  for (const fn of [upload, sync, del]) {
    assert.equal((await call(fn.h, undefined, fn.creates)()).status, 401, `${fn.name}: sin sesión`);
    for (const role of ["user", "admin", "developer"]) {
      const res = await call(fn.h, role, fn.creates)();
      if (fn.allowed.includes(role)) {
        assert.equal(res.status, 200, `${fn.name}: ${role} debe poder`);
      } else {
        assert.equal(res.status, 403, `${fn.name}: ${role} NO debe poder`);
        assert.equal(await codeOf(res), fn.deny, `${fn.name}: código de rechazo para ${role}`);
      }
    }
  }

  // el nivel técnico (roles, historial): solo el developer
  const tech = devOnlyEndpoint(deps);
  assert.equal((await tech(post({}))).status, 401);
  for (const token of ["user", "admin"]) {
    const r = await tech(post({}, token));
    assert.equal(r.status, 403, `${token} no debe entrar al nivel técnico`);
    assert.equal(await codeOf(r), "developer_only");
  }
  const ok = await tech(post({}, "developer"));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).actor, DEV_ID);
});

Deno.test("admin NO sube: se le rechaza sin crear la clase, sin tocar R2 y sin dejar rastro", async () => {
  const { deps, repo, r2, audit } = makeDeps();
  const existing = repo.addClass({ video_status: "failed" });

  // crear una clase nueva con video
  const create = await createUpload(deps)(post({ title: "Intento del admin" }, "admin"));
  assert.equal(create.status, 403);
  assert.equal(await codeOf(create), "developer_only");
  // reintentar / reemplazar el video de una clase existente (la otra vía de "subir")
  const retry = await createUpload(deps)(post({ title: "x", class_id: existing.id }, "admin"));
  assert.equal(retry.status, 403);

  assert.equal(repo.classes.size, 1, "no se creó ninguna clase");
  assert.equal(repo.classes.get(existing.id)!.r2_object_key, null, "la clase existente no recibió un video");
  assert.equal(r2.calls.filter((c) => c.op === "createUploadUrl").length, 0, "no se firmó ninguna URL de subida a R2");
  assert.equal(audit.entries.length, 0, "no hay entradas de auditoría de una acción que no ocurrió");
});

Deno.test("admin SÍ gestiona: confirma/consulta video, despublica por estado y borra clase + video, con auditoría a su nombre", async () => {
  const { deps, repo, r2, audit } = makeDeps();
  const key = r2.newObjectKey(crypto.randomUUID());
  r2.putObject(key);
  const c = repo.addClass({ title: "Para borrar", r2_object_key: key, video_status: "uploading", is_published: false });

  const sync = await createSync(deps)(post({ class_id: c.id, duration_seconds: 600 }, "admin"));
  assert.equal(sync.status, 200);
  assert.equal((await sync.json()).class.video_status, "ready");

  const del = await createDelete(deps)(post({ class_id: c.id }, "admin"));
  assert.equal(del.status, 200);
  assert.equal(repo.classes.has(c.id), false, "la clase se borró");
  assert.equal(r2.objects.has(key), false, "y su video también");
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].action, "class.delete");
  assert.equal(audit.entries[0].actorId, ADMIN_ID, "queda registrado QUIÉN borró");
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
  const r = await createUpload(deps)(post({ title: "Yoga suave" }, "developer"));
  assert.equal(r.status, 200);
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].actorId, DEV_ID);
  assert.equal(audit.entries[0].action, "class.upload_prepared");
  assert.equal(audit.entries[0].entityType, "class");
  assert.equal(audit.entries[0].details?.title, "Yoga suave");
});

Deno.test("auditoría: si falla el registro, subir NO se rompe (no es destructivo)", async () => {
  const { deps, audit, repo } = makeDeps();
  audit.fail = true;
  const r = await createUpload(deps)(post({ title: "Yoga suave" }, "developer"));
  assert.equal(r.status, 200);
  assert.equal(repo.classes.size, 1);
});

Deno.test("auditoría: borrar registra ANTES de borrar y, si no se puede auditar, no se borra nada", async () => {
  const { deps, audit, repo, r2 } = makeDeps();
  const key = r2.newObjectKey(crypto.randomUUID());
  r2.putObject(key);
  const c = repo.addClass({ title: "A borrar", r2_object_key: key, is_published: false });

  audit.fail = true; // el historial no responde
  const blocked = await createDelete(deps)(post({ class_id: c.id }, "admin"));
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
  for (const code of ["admin_only", "developer_only"]) {
    assert.ok(messages.includes(code), `errors.js no traduce ${code}`);
  }
});
