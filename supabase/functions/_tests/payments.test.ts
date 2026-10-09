import assert from "node:assert/strict";
import { createHandler as createOrder } from "../paypal-create-order/handler.ts";
import { createHandler as captureOrder } from "../paypal-capture-order/handler.ts";
import { createHandler as createSub } from "../paypal-create-subscription/handler.ts";
import { createHandler as activateSub } from "../paypal-activate-subscription/handler.ts";
import { createHandler as cancelSub } from "../paypal-cancel-subscription/handler.ts";
import { createHandler as webhook } from "../paypal-webhook/handler.ts";
import { createHandler as reconcile } from "../paypal-reconcile/handler.ts";
import { PayPalError } from "../_shared/paypal/paypal.service.ts";
import { summarizeEvent } from "../_shared/payments/logic.ts";
import { parseCartItems, safeReturnUrl } from "../_shared/payments/request.ts";
import { post, USER2_ID, USER_ID } from "./fakes.ts";
import { CRON_SECRET, makePaymentDeps, PLAN_ID } from "./payments.fakes.ts";

const code = async (r: Response) => (await r.json()).error?.code;
const DAY = 86_400_000;

/** Un pedido de tienda ya creado y APROBADO en PayPal, listo para capturar. */
async function shopOrder(t: ReturnType<typeof makePaymentDeps>, qty = 2, token = "user") {
  const product = t.repo.addProduct({ title: "Mat de yoga", price_cents: 2000, stock: 5 });
  const r = await createOrder(t.deps)(post({ items: [{ type: "product", id: product.id, qty }] }, token));
  assert.equal(r.status, 200);
  const body = await r.json();
  t.paypal.approve(body.paypal_order_id);
  return { product, ...body } as {
    product: typeof product;
    paypal_order_id: string;
    order_id: string;
    total_cents: number;
  };
}

async function classOrder(t: ReturnType<typeof makePaymentDeps>, token = "user") {
  const cls = t.repo.addClass({ price_cents: 1210 });
  const r = await createOrder(t.deps)(post({ items: [{ type: "class", id: cls.id }] }, token));
  return { cls, res: r };
}

// =============================================================== paypal-create-order
Deno.test("create-order: sin sesión 401; sin PayPal configurado 503; mal formado 400", async () => {
  const t = makePaymentDeps();
  const h = createOrder(t.deps);
  assert.equal((await h(post({ items: [] }))).status, 401);
  assert.equal(await code(await h(post({ items: [] }, "user"))), "invalid_cart");
  assert.equal(await code(await h(post({ items: [{ type: "otra", id: "x" }] }, "user"))), "invalid_cart");
  assert.equal(await code(await h(post({}, "user"))), "invalid_cart");
  const sin = makePaymentDeps({}, { paypal: false });
  const r = await createOrder(sin.deps)(post({ items: [] }, "user"));
  assert.equal(r.status, 503);
  assert.equal(await code(r), "payments_not_configured");
});

Deno.test("create-order: el precio sale de la base, nunca del navegador (un price_cents inyectado se ignora)", async () => {
  const t = makePaymentDeps();
  const p = t.repo.addProduct({ title: "Mat", price_cents: 2000, stock: 5 });
  const r = await createOrder(t.deps)(
    post({ items: [{ type: "product", id: p.id, qty: 2, price_cents: 1, total_cents: 1 }], total_cents: 1 }, "user"),
  );
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.total_cents, 4000, "2 x 20,00 € de la base");
  const [order] = [...t.paypal.orders.values()];
  assert.equal(order.input.totalCents, 4000);
  assert.deepEqual(order.input.items, [{ name: "Mat", unitCents: 2000, qty: 2, digital: false }]);
  assert.equal(order.input.shipping, "address", "producto físico: PayPal pide la dirección");
  assert.equal(order.input.orderId, body.order_id, "el id del pedido viaja como custom_id");
  assert.equal(t.repo.products.get(p.id)!.stock, 3, "el stock queda reservado");
});

Deno.test("create-order: sin stock suficiente 409 y no se llama a PayPal", async () => {
  const t = makePaymentDeps();
  const p = t.repo.addProduct({ title: "Mat", price_cents: 2000, stock: 1 });
  const r = await createOrder(t.deps)(post({ items: [{ type: "product", id: p.id, qty: 2 }] }, "user"));
  assert.equal(r.status, 409);
  assert.equal(await code(r), "insufficient_stock");
  assert.equal(t.paypal.calls.length, 0);
  assert.equal(t.repo.products.get(p.id)!.stock, 1);
});

Deno.test("create-order: si PayPal falla, el pedido se cierra y el stock vuelve", async () => {
  const t = makePaymentDeps();
  const p = t.repo.addProduct({ title: "Mat", price_cents: 2000, stock: 5 });
  t.paypal.failNext = { op: "createOrder", error: new PayPalError("boom", 500, "createOrder") };
  const r = await createOrder(t.deps)(post({ items: [{ type: "product", id: p.id, qty: 2 }] }, "user"));
  assert.equal(r.status, 502);
  assert.equal(await code(r), "payment_provider_error");
  assert.equal(t.repo.products.get(p.id)!.stock, 5, "stock devuelto");
  assert.equal([...t.repo.orders.values()][0].status, "failed");
});

Deno.test("create-order: clase suelta digital (sin envío) y no se compra dos veces", async () => {
  const t = makePaymentDeps();
  const { cls, res } = await classOrder(t);
  assert.equal(res.status, 200);
  const [order] = [...t.paypal.orders.values()];
  assert.equal(order.input.shipping, "none");
  assert.equal(order.input.items[0].digital, true);
  assert.equal(order.input.totalCents, 1210);
  t.repo.entitlements.push({
    user_id: USER_ID,
    scope: "class",
    class_id: cls.id,
    source: "paypal",
    external_ref: "x",
    expires_at: null,
  });
  const again = await createOrder(t.deps)(post({ items: [{ type: "class", id: cls.id }] }, "user"));
  assert.equal(again.status, 409);
  assert.equal(await code(again), "already_owned");
});

Deno.test("create-order: límite de frecuencia 429", async () => {
  const t = makePaymentDeps();
  const h = createOrder(t.deps);
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await h(post({ items: [] }, "user"))).status;
  assert.equal(last, 429);
});

Deno.test("parseCartItems / safeReturnUrl: validación estricta", () => {
  const id = crypto.randomUUID();
  assert.deepEqual(parseCartItems({ items: [{ type: "product", id, qty: 2, extra: "x" }] }), [{
    type: "product",
    id,
    variant_id: null,
    qty: 2,
  }]);
  for (
    const bad of [
      { items: [{ type: "product", id, qty: 0 }] },
      { items: [{ type: "product", id, qty: 1.5 }] },
      { items: [{ type: "product", id, qty: "2" }] },
      { items: [{ type: "product", id: "no", qty: 1 }] },
      { items: new Array(31).fill({ type: "class", id }) },
    ]
  ) {
    assert.throws(() => parseCartItems(bad as never), /./, JSON.stringify(bad).slice(0, 60));
  }
  const allowed = ["https://yogapopup.test", "http://localhost:5500"];
  assert.equal(safeReturnUrl("https://yogapopup.test/cuenta.html", allowed), "https://yogapopup.test/cuenta.html");
  assert.equal(
    safeReturnUrl("https://evil.example/robo", allowed),
    "https://yogapopup.test/",
    "origen ajeno: se usa el propio",
  );
  assert.equal(safeReturnUrl("javascript:alert(1)", allowed), "https://yogapopup.test/");
  assert.equal(safeReturnUrl(undefined, ["http://localhost:5500"]), undefined);
});

// =============================================================== paypal-capture-order
Deno.test("capture-order: aprobada -> se captura, se verifica y queda pagada; repetir no duplica nada", async () => {
  const t = makePaymentDeps();
  const o = await shopOrder(t);
  const h = captureOrder(t.deps);
  const r = await h(post({ paypal_order_id: o.paypal_order_id }, "user"));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, "paid");
  assert.equal(body.order_id, o.order_id);
  const order = t.repo.orders.get(o.order_id)!;
  assert.equal(order.status, "paid");
  assert.ok(order.paypal_capture_id);
  assert.ok(t.audit.entries.some((e) => e.action === "payment.paid" && e.entityId === o.order_id));

  // Reintento (doble clic, red lenta): el mismo resultado y el stock no se vuelve a tocar.
  const again = await h(post({ paypal_order_id: o.paypal_order_id }, "user"));
  assert.equal((await again.json()).status, "paid");
  assert.equal(t.repo.products.get(o.product.id)!.stock, 3);
  assert.equal(t.audit.entries.filter((e) => e.action === "payment.paid").length, 1, "se registra un solo pago");
});

Deno.test("capture-order: la compra de una clase concede el acceso (y solo a esa clase)", async () => {
  const t = makePaymentDeps();
  const { cls, res } = await classOrder(t);
  const { paypal_order_id } = await res.json();
  t.paypal.approve(paypal_order_id);
  assert.equal(t.repo.hasClassAccess(USER_ID, cls.id), false, "antes de pagar no hay acceso");
  assert.equal((await captureOrder(t.deps)(post({ paypal_order_id }, "user"))).status, 200);
  assert.equal(t.repo.hasClassAccess(USER_ID, cls.id), true);
  assert.equal(t.repo.hasClassAccess(USER_ID, crypto.randomUUID()), false, "no abre otras clases");
  await captureOrder(t.deps)(post({ paypal_order_id }, "user"));
  assert.equal(t.repo.entitlements.length, 1, "un solo acceso aunque se repita");
});

Deno.test("capture-order: pedido ajeno o inexistente 404; sin sesión 401; id inválido 400; no aprobada 409", async () => {
  const t = makePaymentDeps();
  const o = await shopOrder(t);
  const h = captureOrder(t.deps);
  assert.equal((await h(post({ paypal_order_id: o.paypal_order_id }))).status, 401);
  const ajeno = await h(post({ paypal_order_id: o.paypal_order_id }, "user2"));
  assert.equal(ajeno.status, 404);
  assert.equal(await code(ajeno), "order_not_found");
  assert.equal((await h(post({ paypal_order_id: "NOEXISTE12345" }, "user"))).status, 404);
  assert.equal(await code(await h(post({ paypal_order_id: "../../x" }, "user"))), "invalid_input");
  assert.equal(t.repo.orders.get(o.order_id)!.status, "created", "nada cambió");

  const t2 = makePaymentDeps();
  const p = t2.repo.addProduct({ title: "Mat", price_cents: 2000 });
  const created = await (await createOrder(t2.deps)(post({ items: [{ type: "product", id: p.id, qty: 1 }] }, "user")))
    .json();
  const noApproved = await captureOrder(t2.deps)(post({ paypal_order_id: created.paypal_order_id }, "user"));
  assert.equal(noApproved.status, 409);
  assert.equal(await code(noApproved), "order_not_approved");
});

Deno.test("capture-order: si PayPal cobró un monto DISTINTO no se da por pagado y queda para revisión", async () => {
  const t = makePaymentDeps();
  const o = await shopOrder(t);
  t.paypal.captureAmountCents = o.total_cents - 1;
  const r = await captureOrder(t.deps)(post({ paypal_order_id: o.paypal_order_id }, "user"));
  assert.equal(r.status, 409);
  assert.equal(await code(r), "payment_review");
  const order = t.repo.orders.get(o.order_id)!;
  assert.notEqual(order.status, "paid");
  assert.equal(order.needs_review, true);
  assert.ok(t.audit.entries.some((e) => e.action === "payment.mismatch"));
});

Deno.test("capture-order: orden de PayPal que no corresponde a nuestro pedido (custom_id) -> revisión", async () => {
  const t = makePaymentDeps();
  const o = await shopOrder(t);
  t.paypal.orders.get(o.paypal_order_id)!.order.customId = crypto.randomUUID();
  const r = await captureOrder(t.deps)(post({ paypal_order_id: o.paypal_order_id }, "user"));
  assert.equal(r.status, 409);
  assert.equal(await code(r), "payment_review");
  assert.equal(t.repo.orders.get(o.order_id)!.status, "created");
  assert.equal(t.paypal.calls.includes("captureOrder"), false, "ni siquiera se intenta cobrar");
});

Deno.test("capture-order: cobro rechazado -> 402 y el stock vuelve; pendiente -> 'pending' sin dar acceso", async () => {
  const t = makePaymentDeps();
  const o = await shopOrder(t);
  t.paypal.captureStatus = "DECLINED";
  const r = await captureOrder(t.deps)(post({ paypal_order_id: o.paypal_order_id }, "user"));
  assert.equal(r.status, 402);
  assert.equal(await code(r), "payment_failed");
  assert.equal(t.repo.products.get(o.product.id)!.stock, 5, "stock devuelto");

  const t2 = makePaymentDeps();
  const { cls, res } = await classOrder(t2);
  const { paypal_order_id } = await res.json();
  t2.paypal.approve(paypal_order_id);
  t2.paypal.captureStatus = "PENDING";
  const p = await captureOrder(t2.deps)(post({ paypal_order_id }, "user"));
  assert.equal((await p.json()).status, "pending");
  assert.equal(t2.repo.hasClassAccess(USER_ID, cls.id), false, "pendiente: todavía sin acceso");
});

Deno.test("capture-order: medio de pago rechazado por PayPal (422) -> 402 payment_declined y el pedido sigue abierto", async () => {
  const t = makePaymentDeps();
  const o = await shopOrder(t);
  t.paypal.failNext = {
    op: "captureOrder",
    error: new PayPalError("declined", 422, "captureOrder", "INSTRUMENT_DECLINED"),
  };
  const r = await captureOrder(t.deps)(post({ paypal_order_id: o.paypal_order_id }, "user"));
  assert.equal(r.status, 402);
  assert.equal(await code(r), "payment_declined");
  assert.equal(t.repo.orders.get(o.order_id)!.status, "created", "se puede reintentar con otro medio de pago");
});

// =============================================================== suscripciones
async function subscribed(
  t: ReturnType<typeof makePaymentDeps>,
  nextBilling = new Date(Date.now() + 30 * DAY).toISOString(),
) {
  const r = await createSub(t.deps)(post({}, "user"));
  assert.equal(r.status, 200);
  const { subscription_id } = await r.json();
  t.paypal.activateSub(subscription_id, nextBilling);
  const a = await activateSub(t.deps)(post({ subscription_id }, "user"));
  assert.equal(a.status, 200);
  return { subscription_id, nextBilling, activation: await a.json() };
}

Deno.test("create-subscription: crea la suscripción con el plan del servidor y la persona como custom_id", async () => {
  const t = makePaymentDeps();
  const r = await createSub(t.deps)(
    post({ plan_id: "P-OTRO-MAS-BARATO", return_url: "https://evil.example/" }, "user"),
  );
  assert.equal(r.status, 200);
  const { subscription_id } = await r.json();
  const sub = t.paypal.subs.get(subscription_id)!;
  assert.equal(sub.planId, PLAN_ID, "el plan lo decide el servidor, no el navegador");
  assert.equal(sub.customId, USER_ID);
  assert.equal(t.repo.subs.get(subscription_id)!.status, "approval_pending");
});

Deno.test("create-subscription: sin sesión 401; sin plan configurado 503; con una suscripción viva 409", async () => {
  const t = makePaymentDeps();
  assert.equal((await createSub(t.deps)(post({}))).status, 401);
  const sinPlan = makePaymentDeps({ planId: null });
  const r = await createSub(sinPlan.deps)(post({}, "user"));
  assert.equal(r.status, 503);
  assert.equal(await code(r), "payments_not_configured");
  await subscribed(t);
  const again = await createSub(t.deps)(post({}, "user"));
  assert.equal(again.status, 409);
  assert.equal(await code(again), "already_subscribed");
});

Deno.test("activate-subscription: pendiente no da acceso; activa sí (con 2 días de gracia); ajena 404; otro plan 409", async () => {
  const t = makePaymentDeps();
  const { subscription_id } = await (await createSub(t.deps)(post({}, "user"))).json();
  const pend = await (await activateSub(t.deps)(post({ subscription_id }, "user"))).json();
  assert.equal(pend.status, "approval_pending");
  assert.equal(t.repo.entitlements.length, 0, "sin aprobar no hay acceso");

  const next = new Date(Date.now() + 30 * DAY).toISOString();
  t.paypal.activateSub(subscription_id, next);
  const ok = await (await activateSub(t.deps)(post({ subscription_id }, "user"))).json();
  assert.equal(ok.status, "active");
  assert.equal(ok.current_period_end, next);
  assert.equal(t.repo.hasClassAccess(USER_ID, crypto.randomUUID()), true, "suscripta: acceso a todo");
  assert.equal(t.repo.entitlements[0].scope, "all");
  assert.equal(Date.parse(t.repo.entitlements[0].expires_at!), Date.parse(next) + 2 * DAY);

  assert.equal(
    (await activateSub(t.deps)(post({ subscription_id }, "user2"))).status,
    404,
    "la suscripción de otra persona no existe para vos",
  );
  assert.equal((await activateSub(t.deps)(post({ subscription_id: "I-NOEXISTE1" }, "user"))).status, 404);

  // Una suscripción a OTRO plan (más barato) no concede nada.
  const t2 = makePaymentDeps();
  const s2 = await (await createSub(t2.deps)(post({}, "user"))).json();
  t2.paypal.activateSub(s2.subscription_id, next);
  t2.paypal.subs.get(s2.subscription_id)!.planId = "P-OTRO-PLAN";
  const bad = await activateSub(t2.deps)(post({ subscription_id: s2.subscription_id }, "user"));
  assert.equal(bad.status, 409);
  assert.equal(t2.repo.entitlements.length, 0);
});

Deno.test("cancel-subscription: cancela en PayPal y el acceso sigue hasta el fin de lo pagado", async () => {
  const t = makePaymentDeps();
  const { subscription_id, nextBilling } = await subscribed(t);
  assert.equal((await cancelSub(t.deps)(post({}))).status, 401);
  assert.equal((await cancelSub(t.deps)(post({}, "user2"))).status, 404, "quien no tiene suscripción: 404");

  const r = await cancelSub(t.deps)(post({}, "user"));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, "cancelled");
  assert.equal(body.access_until, nextBilling);
  assert.equal(t.paypal.subs.get(subscription_id)!.status, "CANCELLED", "se canceló en PayPal, no solo en la base");
  assert.equal(t.repo.subs.get(subscription_id)!.status, "cancelled");
  // El acceso NO se corta al cancelar: dura hasta el fin del período pagado (sin la gracia).
  assert.equal(t.repo.entitlements[0].expires_at, nextBilling);
  assert.equal(t.repo.hasClassAccess(USER_ID, crypto.randomUUID()), true, "todavía tiene lo que pagó");
  assert.equal(
    t.repo.hasClassAccess(USER_ID, crypto.randomUUID(), Date.parse(nextBilling) + 1000),
    false,
    "después del vencimiento, no",
  );
  assert.ok(t.audit.entries.some((e) => e.action === "subscription.cancel_requested" && e.actorId === USER_ID));
  // Cancelar de nuevo: ya no hay suscripción viva.
  assert.equal((await cancelSub(t.deps)(post({}, "user"))).status, 404);
});

Deno.test("cancel-subscription: si PayPal ya la tenía cancelada se refleja igual; otros errores de PayPal 502 sin tocar la base", async () => {
  const t = makePaymentDeps();
  const { subscription_id } = await subscribed(t);
  t.paypal.subs.get(subscription_id)!.status = "CANCELLED"; // cancelada desde PayPal directamente
  const r = await cancelSub(t.deps)(post({}, "user"));
  assert.equal(r.status, 200);
  assert.equal(t.repo.subs.get(subscription_id)!.status, "cancelled");

  const t2 = makePaymentDeps();
  const s = await subscribed(t2);
  t2.paypal.failNext = { op: "cancelSubscription", error: new PayPalError("down", 503, "cancelSubscription") };
  const down = await cancelSub(t2.deps)(post({}, "user"));
  assert.equal(down.status, 502);
  assert.equal(t2.repo.subs.get(s.subscription_id)!.status, "active", "si PayPal no canceló, la base sigue igual");
});

// =============================================================== paypal-webhook
const SIG = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-sig": "firma",
  "paypal-transmission-time": "2026-10-08T12:00:00Z",
};
const event = (type: string, resource: Record<string, unknown>, id = `WH-${crypto.randomUUID()}`) => ({
  id,
  event_type: type,
  resource_type: "x",
  resource,
});
const hook = (e: unknown, headers: Record<string, string> = SIG) => post(e, undefined, headers);

Deno.test("webhook: sin firma o con firma inválida -> 401 y NADA se procesa", async () => {
  const t = makePaymentDeps();
  const o = await shopOrder(t);
  t.paypal.captureStatus = "COMPLETED";
  await t.paypal.captureOrder(o.paypal_order_id, "x"); // PayPal cobró, pero nosotros todavía no lo sabemos
  const ev = event("PAYMENT.CAPTURE.COMPLETED", { id: "CAP1", custom_id: o.order_id });
  const h = webhook(t.deps);

  assert.equal((await h(hook(ev, {}))).status, 401, "sin cabeceras de firma");
  t.paypal.webhookValid = false;
  const bad = await h(hook(ev));
  assert.equal(bad.status, 401);
  assert.equal(await code(bad), "invalid_signature");
  assert.equal(t.repo.orders.get(o.order_id)!.status, "created", "un evento no verificado no cambia nada");
  assert.equal(t.repo.events.size, 0, "ni siquiera se registra");
});

Deno.test("webhook: cuerpo que no es un evento 400; sin id de webhook configurado 503; método distinto de POST 405", async () => {
  const t = makePaymentDeps();
  const h = webhook(t.deps);
  assert.equal(await code(await h(post("esto no es json", undefined, SIG))), "invalid_event");
  assert.equal(await code(await h(hook({ hola: 1 }))), "invalid_event");
  assert.equal(await code(await h(hook({ id: "WH-1", event_type: "X.Y", resource: [] }))), "invalid_event");
  const sin = makePaymentDeps({ webhookId: null });
  assert.equal((await webhook(sin.deps)(hook(event("X.Y", {})))).status, 503);
  assert.equal((await h(new Request("https://fn.test/x", { method: "GET" }))).status, 405);
});

Deno.test("webhook: cobro completado que el navegador no alcanzó a confirmar -> el pedido queda pagado", async () => {
  const t = makePaymentDeps();
  const { cls, res } = await classOrder(t);
  const { paypal_order_id, order_id } = await res.json();
  t.paypal.approve(paypal_order_id);
  await t.paypal.captureOrder(paypal_order_id, "x"); // la persona cerró la pestaña antes de que corra capture-order
  const r = await webhook(t.deps)(hook(event("PAYMENT.CAPTURE.COMPLETED", { id: "CAP-X", custom_id: order_id })));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, "processed");
  assert.equal(t.repo.orders.get(order_id)!.status, "paid");
  assert.equal(t.repo.hasClassAccess(USER_ID, cls.id), true, "y se concedió el acceso");
});

Deno.test("webhook: el MISMO evento reenviado no duplica el pedido ni el acceso", async () => {
  const t = makePaymentDeps();
  const { res } = await classOrder(t);
  const { paypal_order_id, order_id } = await res.json();
  t.paypal.approve(paypal_order_id);
  await t.paypal.captureOrder(paypal_order_id, "x");
  const ev = event("PAYMENT.CAPTURE.COMPLETED", { id: "CAP-X", custom_id: order_id }, "WH-REENVIADO");
  const h = webhook(t.deps);
  assert.equal((await (await h(hook(ev))).json()).status, "processed");
  const second = await h(hook(ev));
  assert.equal(second.status, 200, "PayPal tiene que recibir 200 para dejar de reintentar");
  assert.equal((await second.json()).status, "duplicate");
  assert.equal(t.repo.markPaidCalls, 1, "el segundo evento ni siquiera se procesa");
  assert.equal(t.repo.entitlements.length, 1);
  assert.equal(t.repo.events.size, 1);
});

Deno.test("webhook: si el procesamiento falla responde 500 (PayPal reintenta) y el reintento funciona", async () => {
  const t = makePaymentDeps();
  const { res } = await classOrder(t);
  const { paypal_order_id, order_id } = await res.json();
  t.paypal.approve(paypal_order_id);
  await t.paypal.captureOrder(paypal_order_id, "x");
  const ev = event("PAYMENT.CAPTURE.COMPLETED", { id: "CAP-X", custom_id: order_id }, "WH-FALLA");
  const h = webhook(t.deps);
  t.repo.failNextWrite = true;
  const fail = await h(hook(ev));
  assert.equal(fail.status, 500);
  assert.equal(await code(fail), "event_failed");
  assert.equal(t.repo.events.get("WH-FALLA")!.status, "failed");
  assert.match(t.repo.events.get("WH-FALLA")!.error ?? "", /db down/);
  assert.equal(t.repo.orders.get(order_id)!.status, "created");

  const retry = await h(hook(ev)); // PayPal reintenta
  assert.equal(retry.status, 200);
  assert.equal(t.repo.orders.get(order_id)!.status, "paid");
  assert.equal(t.repo.events.get("WH-FALLA")!.attempts, 2);
});

Deno.test("webhook: reembolso total de una clase quita el acceso; parcial no; el mismo reembolso no se aplica dos veces", async () => {
  const t = makePaymentDeps();
  const { cls, res } = await classOrder(t);
  const { paypal_order_id, order_id } = await res.json();
  t.paypal.approve(paypal_order_id);
  await captureOrder(t.deps)(post({ paypal_order_id }, "user"));
  const capId = t.repo.orders.get(order_id)!.paypal_capture_id!;
  const refund = (id: string, cents: number) => {
    t.paypal.refunds.set(id, { id, status: "COMPLETED", amountCents: cents, currency: "EUR", captureId: capId });
    return event("PAYMENT.CAPTURE.REFUNDED", {
      id,
      links: [{ rel: "up", href: `https://api.paypal.com/v2/payments/captures/${capId}` }],
    }, `WH-${id}`);
  };
  const h = webhook(t.deps);
  assert.equal((await (await h(hook(refund("REFUND-1", 200)))).json()).detail, "refund_applied");
  assert.equal(t.repo.orders.get(order_id)!.status, "paid", "reembolso parcial: sigue pagado");
  assert.equal(t.repo.hasClassAccess(USER_ID, cls.id), true, "y con acceso");
  assert.equal((await (await h(hook(refund("REFUND-1", 200), SIG))).json()).status, "duplicate");
  assert.equal(t.repo.orders.get(order_id)!.refunded_cents, 200, "no se suma dos veces");

  assert.equal((await (await h(hook(refund("REFUND-2", 1010)))).json()).detail, "refund_applied");
  assert.equal(t.repo.orders.get(order_id)!.status, "refunded");
  assert.equal(t.repo.hasClassAccess(USER_ID, cls.id), false, "reembolso total: sin acceso");
});

Deno.test("webhook: contracargo (reversed) se trata como reembolso total", async () => {
  const t = makePaymentDeps();
  const { cls, res } = await classOrder(t);
  const { paypal_order_id, order_id } = await res.json();
  t.paypal.approve(paypal_order_id);
  await captureOrder(t.deps)(post({ paypal_order_id }, "user"));
  const capId = t.repo.orders.get(order_id)!.paypal_capture_id!;
  const ev = event("PAYMENT.CAPTURE.REVERSED", {
    id: "REV-1",
    links: [{ rel: "up", href: `https://api.paypal.com/v2/payments/captures/${capId}` }],
  });
  assert.equal((await webhook(t.deps)(hook(ev))).status, 200);
  assert.equal(t.repo.orders.get(order_id)!.status, "refunded");
  assert.equal(t.repo.hasClassAccess(USER_ID, cls.id), false);
});

Deno.test("webhook: suscripción activada / renovada / cancelada / pago fallido", async () => {
  const t = makePaymentDeps();
  const { subscription_id } = await (await createSub(t.deps)(post({}, "user"))).json();
  const h = webhook(t.deps);
  const next1 = new Date(Date.now() + 30 * DAY).toISOString();

  // ACTIVATED: el navegador no llegó a llamar a activate-subscription, pero el webhook sí.
  t.paypal.activateSub(subscription_id, next1);
  assert.equal(
    (await (await h(hook(event("BILLING.SUBSCRIPTION.ACTIVATED", { id: subscription_id })))).json()).status,
    "processed",
  );
  assert.equal(t.repo.subs.get(subscription_id)!.status, "active");
  assert.equal(t.repo.entitlements.length, 1);

  // Renovación (PAYMENT.SALE.COMPLETED trae el id de la suscripción como billing_agreement_id): se extiende el acceso.
  const next2 = new Date(Date.now() + 60 * DAY).toISOString();
  t.paypal.activateSub(subscription_id, next2);
  await h(hook(event("PAYMENT.SALE.COMPLETED", { id: "SALE-1", billing_agreement_id: subscription_id })));
  assert.equal(Date.parse(t.repo.entitlements[0].expires_at!), Date.parse(next2) + 2 * DAY);
  assert.equal(t.repo.entitlements.length, 1, "un solo acceso");

  // Pago fallido: PayPal la suspende. No se extiende.
  t.paypal.subs.get(subscription_id)!.status = "SUSPENDED";
  await h(hook(event("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: subscription_id })));
  assert.equal(t.repo.subs.get(subscription_id)!.status, "suspended");
  assert.equal(
    Date.parse(t.repo.entitlements[0].expires_at!),
    Date.parse(next2) + 2 * DAY,
    "suspendida: no se extiende",
  );

  // Cancelada desde PayPal: el acceso termina al vencer lo pagado.
  t.paypal.subs.get(subscription_id)!.status = "CANCELLED";
  await h(hook(event("BILLING.SUBSCRIPTION.CANCELLED", { id: subscription_id })));
  assert.equal(t.repo.subs.get(subscription_id)!.status, "cancelled");
  assert.equal(t.repo.entitlements[0].expires_at, next2);
});

Deno.test("webhook: una venta común (sin suscripción), eventos que no manejamos y pedidos ajenos se ignoran sin fallar", async () => {
  const t = makePaymentDeps();
  const h = webhook(t.deps);
  assert.equal(
    (await (await h(hook(event("PAYMENT.SALE.COMPLETED", { id: "S" })))).json()).detail,
    "not_a_subscription",
  );
  assert.equal(
    (await (await h(hook(event("CUSTOMER.DISPUTE.CREATED", { id: "D" })))).json()).detail,
    "event_type_not_handled",
  );
  assert.equal(
    (await (await h(hook(event("PAYMENT.CAPTURE.COMPLETED", { id: "C", custom_id: crypto.randomUUID() })))).json())
      .detail,
    "order_not_found",
  );
  assert.equal((await (await h(hook(event("CHECKOUT.ORDER.APPROVED", { id: "O" })))).json()).status, "ignored");
  assert.ok([...t.repo.events.values()].every((e) => e.status === "ignored"));
});

Deno.test("webhook: suscripción a otro plan o de otra persona no concede acceso; sin usuario conocido no se inventa nada", async () => {
  const t = makePaymentDeps();
  const h = webhook(t.deps);
  const next = new Date(Date.now() + 30 * DAY).toISOString();
  // Suscripción creada FUERA de nuestro sistema (nunca pasó por create-subscription), con un plan ajeno.
  t.paypal.subs.set("I-AJENA00001", {
    id: "I-AJENA00001",
    planId: "P-OTRO",
    status: "ACTIVE",
    customId: USER_ID,
    nextBillingTime: next,
    lastPaymentTime: null,
  });
  assert.equal(
    (await (await h(hook(event("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-AJENA00001" })))).json()).detail,
    "subscription_wrong_plan",
  );
  // Sin custom_id: no sabemos de quién es.
  t.paypal.subs.set("I-SINUSER001", {
    id: "I-SINUSER001",
    planId: PLAN_ID,
    status: "ACTIVE",
    customId: null,
    nextBillingTime: next,
    lastPaymentTime: null,
  });
  assert.equal(
    (await (await h(hook(event("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-SINUSER001" })))).json()).detail,
    "subscription_unknown",
  );
  assert.equal(t.repo.entitlements.length, 0);
  // Con el custom_id correcto (llegó primero el webhook y la fila no existía) sí se crea.
  t.paypal.subs.set("I-PRIMERO001", {
    id: "I-PRIMERO001",
    planId: PLAN_ID,
    status: "ACTIVE",
    customId: USER2_ID,
    nextBillingTime: next,
    lastPaymentTime: null,
  });
  assert.equal(
    (await (await h(hook(event("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-PRIMERO001" })))).json()).detail,
    "subscription_ok",
  );
  assert.equal(t.repo.entitlements[0].user_id, USER2_ID);
});

Deno.test("summarizeEvent: el resumen guardado no incluye datos personales (correo, dirección)", () => {
  const s = summarizeEvent({
    id: "WH-1",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: "CAP",
      status: "COMPLETED",
      custom_id: "abc",
      amount: { value: "12.10", currency_code: "EUR" },
      payer: { email_address: "a@b.com" },
      shipping: { address: "calle" },
    },
  });
  assert.deepEqual(s, {
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource_id: "CAP",
    custom_id: "abc",
    status: "COMPLETED",
    amount: "12.10",
    currency: "EUR",
  });
  assert.doesNotMatch(JSON.stringify(s), /a@b\.com|calle/);
});

// =============================================================== paypal-reconcile
Deno.test("reconcile: solo personal de gestión; sin sesión 401; usuario común 403", async () => {
  const t = makePaymentDeps();
  const h = reconcile(t.deps);
  assert.equal((await h(post({ sweep: true }))).status, 401);
  assert.equal((await h(post({ sweep: true }, "user"))).status, 403);
  assert.equal((await h(post({ sweep: true }, "admin"))).status, 200);
  assert.equal((await h(post({}, "admin"))).status, 400);
});

Deno.test("reconcile: 'verificar de nuevo' un pedido cuyo webhook nunca llegó lo deja pagado", async () => {
  const t = makePaymentDeps();
  const { cls, res } = await classOrder(t);
  const { paypal_order_id, order_id } = await res.json();
  t.paypal.approve(paypal_order_id);
  await t.paypal.captureOrder(paypal_order_id, "x"); // PayPal cobró; ni el navegador ni el webhook avisaron
  const r = await reconcile(t.deps)(post({ order_id }, "admin"));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.outcome, "paid");
  assert.equal(body.order.status, "paid");
  assert.equal(t.repo.hasClassAccess(USER_ID, cls.id), true);
  assert.ok(t.audit.entries.some((e) => e.action === "payment.reconcile" && e.actorId !== null));
  // Verificar de nuevo un pedido ya pagado no cambia nada
  assert.equal((await (await reconcile(t.deps)(post({ order_id }, "admin"))).json()).outcome, "already_paid");
  assert.equal(t.repo.entitlements.length, 1);
  assert.equal((await reconcile(t.deps)(post({ order_id: crypto.randomUUID() }, "admin"))).status, 404);
  assert.equal(await code(await reconcile(t.deps)(post({ order_id: "no" }, "admin"))), "invalid_input");
});

Deno.test("reconcile: barrido — captura lo aprobado y nunca capturado, libera lo abandonado, no toca lo reciente", async () => {
  const t = makePaymentDeps();
  const old = new Date(Date.now() - 2 * 3600_000).toISOString();

  const aprobado = await shopOrder(t, 1); // aprobado, nunca capturado, hace 2 h
  t.repo.orders.get(aprobado.order_id)!.created_at = old;

  const p2 = t.repo.addProduct({ title: "Bloque", price_cents: 1000, stock: 4 });
  const abandonado =
    await (await createOrder(t.deps)(post({ items: [{ type: "product", id: p2.id, qty: 3 }] }, "user2"))).json();
  t.repo.orders.get(abandonado.order_id)!.created_at = old; // la persona nunca aprobó nada
  assert.equal(t.repo.products.get(p2.id)!.stock, 1);

  const p3 = t.repo.addProduct({ title: "Cinta", price_cents: 500, stock: 2 });
  const reciente = await (await createOrder(t.deps)(post({ items: [{ type: "product", id: p3.id, qty: 1 }] }, "admin")))
    .json();

  const r = await reconcile(t.deps)(post({ sweep: true }, "admin"));
  assert.equal(r.status, 200);
  const sum = await r.json();
  assert.equal(sum.paid, 1);
  assert.equal(sum.cancelled, 1);
  assert.equal(t.repo.orders.get(aprobado.order_id)!.status, "paid", "se capturó lo que la persona había aprobado");
  assert.equal(t.repo.orders.get(abandonado.order_id)!.status, "cancelled");
  assert.equal(t.repo.products.get(p2.id)!.stock, 4, "el stock del pedido abandonado volvió");
  assert.equal(t.repo.orders.get(reciente.order_id)!.status, "created", "lo reciente no se toca");
  assert.equal(t.repo.products.get(p3.id)!.stock, 1);
  assert.ok(t.audit.entries.some((e) => e.action === "payment.sweep"));
});

Deno.test("reconcile: una orden aprobada hace MÁS de 24 h no se captura sola, se cancela", async () => {
  const t = makePaymentDeps();
  const o = await shopOrder(t, 1);
  t.repo.orders.get(o.order_id)!.created_at = new Date(Date.now() - 30 * 3600_000).toISOString();
  await reconcile(t.deps)(post({ sweep: true }, "admin"));
  assert.equal(t.paypal.calls.includes("captureOrder"), false);
  assert.equal(t.repo.orders.get(o.order_id)!.status, "cancelled");
  assert.equal(t.repo.products.get(o.product.id)!.stock, 5);
});

Deno.test("reconcile: un fallo con PayPal en un pedido no corta el barrido de los demás", async () => {
  const t = makePaymentDeps();
  const old = new Date(Date.now() - 2 * 3600_000).toISOString();
  const a = await shopOrder(t, 1);
  const b = await shopOrder(t, 1, "user2"); // otra persona: la misma cancelaría su pedido anterior
  t.repo.orders.get(a.order_id)!.created_at = old;
  t.repo.orders.get(b.order_id)!.created_at = old;
  t.paypal.failNext = { op: "getOrder", error: new PayPalError("caído", 503, "getOrder") };
  const sum = await (await reconcile(t.deps)(post({ sweep: true }, "admin"))).json();
  assert.equal(sum.errors, 1);
  assert.equal(sum.paid, 1, "el otro pedido se concilió igual");
});

Deno.test("reconcile: un cron con el secreto correcto dispara SOLO el barrido; con el secreto equivocado no entra", async () => {
  const t = makePaymentDeps();
  const h = reconcile(t.deps);
  const ok = await h(post({ sweep: true }, undefined, { "x-cron-secret": CRON_SECRET }));
  assert.equal(ok.status, 200);
  const soloBarrido = await h(post({ order_id: crypto.randomUUID() }, undefined, { "x-cron-secret": CRON_SECRET }));
  assert.equal(soloBarrido.status, 403);
  assert.equal((await h(post({ sweep: true }, undefined, { "x-cron-secret": "otro" }))).status, 401);
  const sinSecretoConfigurado = makePaymentDeps({ cronSecret: null });
  assert.equal(
    (await reconcile(sinSecretoConfigurado.deps)(post({ sweep: true }, undefined, { "x-cron-secret": "" }))).status,
    401,
  );
  assert.equal(
    (await reconcile(sinSecretoConfigurado.deps)(post({ sweep: true }, undefined, { "x-cron-secret": CRON_SECRET })))
      .status,
    401,
  );
});

Deno.test("reconcile: verificar una suscripción desde PayPal", async () => {
  const t = makePaymentDeps();
  const { subscription_id } = await (await createSub(t.deps)(post({}, "user"))).json();
  t.paypal.activateSub(subscription_id, new Date(Date.now() + 30 * DAY).toISOString()); // PayPal la activó; no nos enteramos
  const r = await (await reconcile(t.deps)(post({ subscription_id }, "admin"))).json();
  assert.equal(r.status, "active");
  assert.equal(t.repo.entitlements.length, 1);
  assert.equal((await reconcile(t.deps)(post({ subscription_id: "I-NOEXISTE1" }, "admin"))).status, 404);
});
