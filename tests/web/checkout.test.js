import assert from "node:assert/strict";
import { validateCart } from "../../js/lib/cart.js";
import { AppError } from "../../js/lib/errors.js";
import { canCheckout, cartToItems, classifyPaymentError, classToItems, outcomeMessage } from "../../js/lib/checkout.js";
// paypal.js lee window.YOGAPOPUP_CONFIG al cargarse: se define antes de importarlo.
globalThis.window ??= globalThis;
globalThis.YOGAPOPUP_CONFIG = { PAYPAL: { CLIENT_ID: "" } };
const { sdkUrl, NAMESPACES, loadPayPal } = await import("../../js/lib/paypal.js");

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const V1 = "33333333-3333-4333-8333-333333333333";
const products = [
  { id: P1, title: "Mat", price_cents: 2000, stock: 5, tax_rate_bps: 2100, product_variants: [] },
  {
    id: P2,
    title: "Remera",
    price_cents: 3000,
    stock: null,
    tax_rate_bps: 2100,
    product_variants: [{ id: V1, size: "M", stock: 2, sort_order: 0 }],
  },
];

Deno.test("cartToItems: manda solo tipo, id, talle y cantidad (el precio NO viaja)", () => {
  const v = validateCart({ items: [{ id: P1, variant: null, qty: 2 }, { id: P2, variant: V1, qty: 1 }] }, products);
  assert.equal(canCheckout(v), true);
  const items = cartToItems(v);
  assert.deepEqual(items, [
    { type: "product", id: P1, variant_id: null, qty: 2 },
    { type: "product", id: P2, variant_id: V1, qty: 1 },
  ]);
  assert.doesNotMatch(
    JSON.stringify(items),
    /price|cents|total|subtotal/i,
    "ni un solo dato de precio en lo que se envía",
  );
});

Deno.test("cartToItems / canCheckout: un carrito con problemas o vacío no se puede pagar", () => {
  const reduced = validateCart({ items: [{ id: P1, variant: null, qty: 9 }] }, products); // stock 5: se reduce
  assert.equal(reduced.ok, false);
  assert.deepEqual(cartToItems(reduced), []);
  assert.equal(canCheckout(reduced), false);
  const noSize = validateCart({ items: [{ id: P2, variant: null, qty: 1 }] }, products);
  assert.equal(canCheckout(noSize), false);
  const gone = validateCart({ items: [{ id: crypto.randomUUID(), variant: null, qty: 1 }] }, products);
  assert.equal(canCheckout(gone), false);
  assert.equal(canCheckout(validateCart({ items: [] }, products)), false);
  assert.equal(canCheckout(null), false);
  assert.deepEqual(cartToItems(undefined), []);
});

Deno.test("classToItems: una clase", () => {
  assert.deepEqual(classToItems(P1), [{ type: "class", id: P1 }]);
});

Deno.test("outcomeMessage: pagado, pendiente y fallido dicen cosas distintas (y el fallido no asusta con cobros)", () => {
  assert.equal(outcomeMessage("paid", "class").type, "success");
  assert.match(outcomeMessage("paid", "class").title, /clase/i);
  assert.match(outcomeMessage("paid", "shop").text, /dirección/i);
  const pending = outcomeMessage("pending", "shop");
  assert.equal(pending.type, "info");
  assert.match(pending.text, /no hace falta que pagues de nuevo/i);
  const failed = outcomeMessage("cualquier-otra", "shop");
  assert.equal(failed.type, "error");
  assert.match(failed.text, /no se te cobr/i);
});

Deno.test("classifyPaymentError: qué hacer con cada error (recargar carrito, loguear, reintentar)", () => {
  const c = (code) => classifyPaymentError(new AppError(code));
  for (const k of ["insufficient_stock", "product_unavailable", "class_unavailable", "invalid_cart", "size_required"]) {
    assert.equal(c(k), "stale", k);
  }
  for (const k of ["already_owned", "already_subscribed"]) assert.equal(c(k), "owned", k);
  assert.equal(c("unauthenticated"), "login");
  assert.equal(c("payments_unavailable"), "unavailable");
  assert.equal(c("payments_not_configured"), "unavailable");
  for (const k of ["network", "payment_provider_error", "internal_error", "payment_declined"]) {
    assert.equal(c(k), "retry", k);
  }
  assert.equal(classifyPaymentError(new Error("raro")), "retry");
  assert.equal(classifyPaymentError(null), "retry");
});

Deno.test("sdkUrl: pago único y suscripción usan parámetros distintos y siempre EUR", () => {
  const checkout = new URL(sdkUrl("checkout", "CLIENT-ABC-123"));
  assert.equal(checkout.origin + checkout.pathname, "https://www.paypal.com/sdk/js");
  assert.equal(checkout.searchParams.get("client-id"), "CLIENT-ABC-123");
  assert.equal(checkout.searchParams.get("currency"), "EUR");
  assert.equal(checkout.searchParams.get("intent"), "capture");
  assert.equal(checkout.searchParams.get("vault"), null);
  assert.equal(checkout.searchParams.get("components"), "buttons");

  const sub = new URL(sdkUrl("subscription", "CLIENT-ABC-123"));
  assert.equal(sub.searchParams.get("intent"), "subscription");
  assert.equal(sub.searchParams.get("vault"), "true");
  assert.equal(sub.searchParams.get("currency"), "EUR");

  assert.notEqual(NAMESPACES.checkout, NAMESPACES.subscription, "dos instancias del SDK no se pisan");
  // Un id con caracteres de URL se codifica (no puede inyectar parámetros)
  const evil = new URL(sdkUrl("checkout", "x&intent=tokenize&client-id=otro"));
  assert.equal(evil.searchParams.get("client-id"), "x&intent=tokenize&client-id=otro");
  assert.equal(evil.searchParams.get("intent"), "capture");
});

Deno.test("loadPayPal: sin Client ID falla con 'payments_unavailable' y NO inyecta ningún script", async () => {
  let created = 0;
  globalThis.document = {
    createElement: () => {
      created++;
      return {};
    },
    head: { append() {} },
  };
  await assert.rejects(loadPayPal("checkout"), (e) => e instanceof AppError && e.code === "payments_unavailable");
  await assert.rejects(loadPayPal("subscription"), (e) => e.code === "payments_unavailable");
  await assert.rejects(loadPayPal("otro-modo"), (e) => e.code === "payments_unavailable");
  assert.equal(created, 0);
  delete globalThis.document;
});
