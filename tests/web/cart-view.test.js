import assert from "node:assert/strict";
import { addItem, emptyCart, MAX_LINES, MAX_QTY_PER_ITEM, validateCart } from "../../js/lib/cart.js";
import { addFeedback, badgeText, canIncrease, isRemovableOnly, lineNotice, MAX_BADGE } from "../../js/lib/cart-view.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const product = (id, extra = {}) => ({ id, title: "Mat", price_cents: 2500, stock: null, ...extra });
const lineOf = (cart, p) => validateCart(cart, p ? [p] : []).lines[0];

Deno.test("badgeText: vacío si no hay nada, número exacto, y '99+' para muchos", () => {
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(-2), "");
  assert.equal(badgeText(NaN), "");
  assert.equal(badgeText(undefined), "");
  assert.equal(badgeText(1), "1");
  assert.equal(badgeText(MAX_BADGE), "99");
  assert.equal(badgeText(MAX_BADGE + 1), "99+");
  assert.equal(badgeText(300), "99+");
});

Deno.test("lineNotice: un texto claro por cada problema, y nada si está todo bien", () => {
  const cart = addItem(emptyCart(), A, 5);
  assert.equal(lineNotice(lineOf(cart, product(A))), "");
  assert.equal(lineNotice(lineOf(cart, product(A, { stock: 0 }))), "Agotado");
  assert.equal(lineNotice(lineOf(cart, null)), "Ya no está disponible");
  assert.equal(lineNotice(lineOf(cart, product(A, { stock: 2 }))), "Solo quedan 2 unidades");
  assert.equal(lineNotice(lineOf(cart, product(A, { stock: 1 }))), "Solo queda 1 unidad");
});

Deno.test("canIncrease: no deja pasar del stock ni del tope, ni subir líneas rotas", () => {
  const two = addItem(emptyCart(), A, 2);
  assert.equal(canIncrease(lineOf(two, product(A, { stock: null }))), true);
  assert.equal(canIncrease(lineOf(two, product(A, { stock: 3 }))), true);
  assert.equal(canIncrease(lineOf(two, product(A, { stock: 2 }))), false); // ya está al máximo del stock
  const max = addItem(emptyCart(), A, MAX_QTY_PER_ITEM);
  assert.equal(canIncrease(lineOf(max, product(A, { stock: null }))), false); // tope por producto
  assert.equal(canIncrease(lineOf(two, product(A, { stock: 0 }))), false); // agotado
  assert.equal(canIncrease(lineOf(two, null)), false); // ya no existe
  // pedía 5 pero quedan 2: la línea corregida ya está al máximo
  assert.equal(canIncrease(lineOf(addItem(emptyCart(), A, 5), product(A, { stock: 2 }))), false);
});

Deno.test("isRemovableOnly: agotadas y desaparecidas solo se quitan; las reducidas siguen editables", () => {
  const cart = addItem(emptyCart(), A, 3);
  assert.equal(isRemovableOnly(lineOf(cart, product(A, { stock: 0 }))), true);
  assert.equal(isRemovableOnly(lineOf(cart, null)), true);
  assert.equal(isRemovableOnly(lineOf(cart, product(A, { stock: 2 }))), false);
  assert.equal(isRemovableOnly(lineOf(cart, product(A))), false);
});

Deno.test("addFeedback: éxito, agotado, máximo alcanzado y carrito lleno tienen cada uno su texto", () => {
  const p = product(A, { title: "Botella térmica", stock: 2 });
  const empty = emptyCart();
  const one = addItem(empty, A, 1, { stock: 2 });
  const two = addItem(one, A, 1, { stock: 2 });

  assert.deepEqual(addFeedback(empty, one, p), { kind: "success", text: "«Botella térmica» se agregó al carrito." });
  assert.equal(addFeedback(one, two, p).kind, "success");

  const capped = addFeedback(two, addItem(two, A, 1, { stock: 2 }), p); // ya estaba al tope del stock
  assert.equal(capped.kind, "info");
  assert.match(capped.text, /máximo disponible de «Botella térmica»/);

  const soldout = product(A, { stock: 0 });
  assert.equal(addFeedback(empty, addItem(empty, A, 1, { stock: 0 }), soldout).text, "Este producto está agotado.");

  let full = emptyCart();
  for (let i = 1; i <= MAX_LINES; i++) full = addItem(full, uuid(i));
  const extra = product(B, { stock: null });
  const tryAdd = addFeedback(full, addItem(full, B), extra);
  assert.equal(tryAdd.kind, "info");
  assert.match(tryAdd.text, /no admite más productos distintos/);
});
