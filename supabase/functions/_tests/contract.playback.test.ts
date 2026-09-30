import assert from "node:assert/strict";
import { createHandler } from "../playback/handler.ts";
import { makeDeps, post } from "./fakes.ts";

/**
 * Contrato entre la función `playback` (backend) y las páginas que la consumen (frontend).
 * Si alguien renombra un campo de un lado y no del otro, esta prueba falla.
 */
const CONTRACT_KEYS = [
  "class_id",
  "completed",
  "duration_seconds",
  "expires_at",
  "resume_seconds",
  "title",
  "video_url",
];

Deno.test("contrato: la respuesta REAL de playback tiene exactamente los campos que el frontend espera", async () => {
  const { deps, repo, r2 } = makeDeps();
  const key = r2.newObjectKey(crypto.randomUUID());
  r2.putObject(key);
  const c = repo.addClass({
    r2_object_key: key,
    video_status: "ready",
    is_published: true,
    duration_seconds: 2700,
  });
  const res = await createHandler(deps)(post({ class_id: c.id }, "user"));
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(await res.json()).sort(), CONTRACT_KEYS);
});

Deno.test("contrato: los errores llevan { error: { code, message } } con los códigos que el frontend traduce", async () => {
  const { deps } = makeDeps();
  const res = await createHandler(deps)(post({ class_id: crypto.randomUUID() }, "user"));
  const body = await res.json();
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message"]);

  const messages = await Deno.readTextFile(new URL("../../../js/lib/errors.js", import.meta.url));
  for (const code of ["unauthenticated", "no_access", "class_not_found", "video_not_ready", "video_provider_error"]) {
    assert.ok(messages.includes(code), `js/lib/errors.js no traduce el código "${code}" que devuelve el backend`);
  }
});

Deno.test("contrato: el frontend solo lee campos que playback realmente devuelve", async () => {
  const src = await Deno.readTextFile(new URL("../../../js/pages/clase.js", import.meta.url));
  const used = new Set([...src.matchAll(/\b(?:pb|fresh)\.(\w+)/g)].map((m) => m[1]));
  assert.ok(used.size > 0, "no se detectó ningún uso de la respuesta de playback");
  for (const key of used) assert.ok(CONTRACT_KEYS.includes(key), `clase.js lee "${key}", que playback no devuelve`);
});
