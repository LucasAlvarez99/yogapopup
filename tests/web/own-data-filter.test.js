import assert from "node:assert/strict";

/**
 * Regresión: la gestión (admin/developer) puede leer por RLS los pedidos y suscripciones de TODAS las personas.
 * Si "Mis compras" / "Mi suscripción" no filtran por la persona con sesión, la gestión ve las compras ajenas como propias.
 */
const api = Deno.readTextFileSync(new URL("../../js/lib/api.js", import.meta.url));
const body = (name) => api.slice(api.indexOf(`export async function ${name}`)).split("\n}\n")[0];

for (const fn of ["listMyOrders", "getMySubscription"]) {
  Deno.test(`${fn}: filtra por la persona con sesión (no se apoya solo en la RLS)`, () => {
    assert.match(body(fn), /\.eq\('user_id', myId\(\)\)/);
  });
}
