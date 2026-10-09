// deno-lint-ignore-file no-explicit-any -- los cuerpos JSON de PayPal se inspeccionan en profundidad en estas pruebas
import assert from "node:assert/strict";
import { PayPalError, PayPalService } from "../_shared/paypal/paypal.service.ts";
import { centsToValue, valueToCents } from "../_shared/paypal/money.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** fetch simulado: `routes` devuelve [status, cuerpo] según método + ruta. Registra todas las llamadas. */
function makeService(
  routes: (c: Call) => [number, unknown] | undefined,
  env: "sandbox" | "live" = "sandbox",
  clock = { now: 1_000_000 },
) {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const raw = init?.body;
    let body: unknown = raw;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch { /* form-urlencoded */ }
    }
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers, body };
    calls.push(call);
    if (call.url.endsWith("/v1/oauth2/token")) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: `TOKEN-${calls.length}`, expires_in: 3600 }), { status: 200 }),
      );
    }
    const hit = routes(call);
    if (!hit) return Promise.resolve(new Response(JSON.stringify({ name: "NOT_FOUND" }), { status: 404 }));
    return Promise.resolve(new Response(hit[0] === 204 ? null : JSON.stringify(hit[1]), { status: hit[0] }));
  }) as typeof fetch;
  const svc = new PayPalService({
    env,
    clientId: "CLIENT-ID-123",
    clientSecret: "SECRET-SHHH",
    fetchImpl,
    nowSeconds: () => clock.now,
  });
  return { svc, calls, clock };
}

// ---------------------------------------------------------------- dinero
Deno.test("money: céntimos <-> cadena de PayPal, sin float y estricto", () => {
  assert.equal(centsToValue(1999), "19.99");
  assert.equal(centsToValue(5), "0.05");
  assert.equal(centsToValue(100), "1.00");
  assert.equal(centsToValue(0), "0.00");
  assert.throws(() => centsToValue(-1));
  assert.throws(() => centsToValue(1.5));
  assert.equal(valueToCents("19.99"), 1999);
  assert.equal(valueToCents("19.9"), 1990);
  assert.equal(valueToCents("20"), 2000);
  assert.equal(valueToCents("0.05"), 5);
  for (
    const bad of [
      "1e3",
      "-1.00",
      "1,000.00",
      "12.345",
      "",
      "abc",
      " 1",
      "1.",
      ".5",
      12.5,
      null,
      undefined,
      "99999999999",
    ]
  ) {
    assert.equal(valueToCents(bad), null, String(bad));
  }
  for (const n of [1, 99, 1000, 1999, 1010, 7777, 123456]) assert.equal(valueToCents(centsToValue(n)), n);
});

// ---------------------------------------------------------------- OAuth
Deno.test("token: usa Basic con las credenciales, se reutiliza y se renueva antes de vencer", async () => {
  const { svc, calls, clock } = makeService((
    c,
  ) => (c.url.includes("/v2/checkout/orders/") ? [200, { id: "ORDER12345", status: "CREATED" }] : undefined));
  await svc.getOrder("ORDER12345");
  await svc.getOrder("ORDER12345");
  assert.equal(calls.filter((c) => c.url.endsWith("/oauth2/token")).length, 1, "un solo token para dos llamadas");
  const tokenCall = calls[0];
  assert.equal(tokenCall.headers.authorization, `Basic ${btoa("CLIENT-ID-123:SECRET-SHHH")}`);
  assert.equal(tokenCall.body, "grant_type=client_credentials");
  assert.equal(calls[1].headers.authorization, "Bearer TOKEN-1");
  clock.now += 3600 - 30; // faltan 30 s para vencer: se renueva (margen de 60 s)
  await svc.getOrder("ORDER12345");
  assert.equal(calls.filter((c) => c.url.endsWith("/oauth2/token")).length, 2);
});

Deno.test("token: dos llamadas simultáneas comparten UN solo pedido de token", async () => {
  const { svc, calls } = makeService((
    c,
  ) => (c.url.includes("/v2/checkout/orders/") ? [200, { id: "ORDER12345", status: "CREATED" }] : undefined));
  await Promise.all([svc.getOrder("ORDER12345"), svc.getOrder("ORDER12345"), svc.getOrder("ORDER12345")]);
  assert.equal(calls.filter((c) => c.url.endsWith("/oauth2/token")).length, 1);
});

Deno.test("token: un 401 renueva el token y reintenta UNA vez", async () => {
  let n = 0;
  const { svc, calls } = makeService((c) => {
    if (!c.url.includes("/v2/checkout/orders/")) return undefined;
    return ++n === 1 ? [401, { name: "AUTHENTICATION_FAILURE" }] : [200, { id: "ORDER12345", status: "CREATED" }];
  });
  const o = await svc.getOrder("ORDER12345");
  assert.equal(o.id, "ORDER12345");
  assert.equal(calls.filter((c) => c.url.endsWith("/oauth2/token")).length, 2);
});

Deno.test("sandbox y live apuntan a hosts distintos", async () => {
  const sb = makeService(() => [200, { id: "ORDER12345", status: "CREATED" }], "sandbox");
  await sb.svc.getOrder("ORDER12345");
  assert.ok(sb.calls[0].url.startsWith("https://api-m.sandbox.paypal.com/"));
  const live = makeService(() => [200, { id: "ORDER12345", status: "CREATED" }], "live");
  await live.svc.getOrder("ORDER12345");
  assert.ok(live.calls[0].url.startsWith("https://api-m.paypal.com/"));
  assert.throws(() => new PayPalService({ env: "otro" as never, clientId: "a", clientSecret: "b" }));
  assert.throws(() => new PayPalService({ env: "live", clientId: "", clientSecret: "b" }));
});

Deno.test("errores: nunca incluyen las credenciales ni el token; llevan el código de detalle de PayPal", async () => {
  const { svc } = makeService(
    () => [422, {
      name: "UNPROCESSABLE_ENTITY",
      details: [{ issue: "INSTRUMENT_DECLINED", description: "SECRET-SHHH TOKEN-1" }],
    }],
  );
  const e = await svc.captureOrder("ORDER12345", "req-1").then(() => null, (x) => x as PayPalError);
  assert.ok(e instanceof PayPalError);
  assert.equal(e.status, 422);
  assert.equal(e.issue, "INSTRUMENT_DECLINED");
  assert.doesNotMatch(e.message, /SECRET-SHHH|CLIENT-ID-123|TOKEN-/);

  const failToken = new PayPalService({
    env: "sandbox",
    clientId: "CLIENT-ID-123",
    clientSecret: "SECRET-SHHH",
    fetchImpl: (() => Promise.resolve(new Response("{}", { status: 401 }))) as typeof fetch,
  });
  const te = await failToken.getOrder("ORDER12345").then(() => null, (x) => x as PayPalError);
  assert.ok(te instanceof PayPalError);
  assert.doesNotMatch(te.message, /SECRET-SHHH|CLIENT-ID-123/);

  const net = new PayPalService({
    env: "sandbox",
    clientId: "a",
    clientSecret: "b",
    fetchImpl: (() => Promise.reject(new Error("ECONNRESET SECRET"))) as typeof fetch,
  });
  const ne = await net.getOrder("ORDER12345").then(() => null, (x) => x as PayPalError);
  assert.ok(ne instanceof PayPalError);
  assert.doesNotMatch(ne.message, /SECRET|ECONNRESET/);
});

Deno.test("ids de la ruta: un id con barras o puntos no llega a la URL (no se puede redirigir la llamada)", async () => {
  const { svc, calls } = makeService(() => [200, {}]);
  for (const bad of ["../../v1/payments", "a/b/c/d/e", "x", "id con espacios", "id?x=1"]) {
    await assert.rejects(svc.getOrder(bad), PayPalError);
    await assert.rejects(svc.getSubscription(bad), PayPalError);
    await assert.rejects(svc.getRefund(bad), PayPalError);
  }
  assert.equal(calls.length, 0, "no se hizo ninguna llamada");
});

// ---------------------------------------------------------------- Orders v2
Deno.test("createOrder: manda EUR, el total exacto, custom_id/invoice_id y una clave de idempotencia", async () => {
  const { svc, calls } = makeService((
    c,
  ) => (c.url.endsWith("/v2/checkout/orders") && c.method === "POST"
    ? [201, { id: "5O190127TN364715T", status: "CREATED" }]
    : undefined)
  );
  const r = await svc.createOrder({
    orderId: "11111111-1111-4111-8111-111111111111",
    totalCents: 4999,
    description: "Pedido",
    items: [{ name: "Mat", unitCents: 1999, qty: 2, digital: false }, {
      name: "Bloque",
      unitCents: 1001,
      qty: 1,
      digital: false,
    }],
    shipping: "address",
    brandName: "Yoga Pop Up",
  });
  assert.equal(r.id, "5O190127TN364715T");
  const call = calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!;
  assert.equal(call.headers["paypal-request-id"], "yp-order-11111111-1111-4111-8111-111111111111");
  const body = call.body as Record<string, any>;
  assert.equal(body.intent, "CAPTURE");
  const pu = body.purchase_units[0];
  assert.equal(pu.custom_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(pu.amount.currency_code, "EUR");
  assert.equal(pu.amount.value, "49.99");
  assert.equal(pu.amount.breakdown.item_total.value, "49.99");
  assert.deepEqual(pu.items.map((i: any) => [i.name, i.quantity, i.unit_amount.value, i.category]), [[
    "Mat",
    "2",
    "19.99",
    "PHYSICAL_GOODS",
  ], ["Bloque", "1", "10.01", "PHYSICAL_GOODS"]]);
  assert.equal(body.application_context.shipping_preference, "GET_FROM_FILE");
});

Deno.test("createOrder: producto digital sin envío; un total que no coincide con las líneas se rechaza antes de llamar", async () => {
  const { svc, calls } = makeService(() => [201, { id: "ORDER12345", status: "CREATED" }]);
  await svc.createOrder({
    orderId: "o",
    totalCents: 1210,
    description: "d",
    items: [{ name: "Curso", unitCents: 1210, qty: 1, digital: true }],
    shipping: "none",
    brandName: "b",
  });
  const body = calls.at(-1)!.body as Record<string, any>;
  assert.equal(body.application_context.shipping_preference, "NO_SHIPPING");
  assert.equal(body.purchase_units[0].items[0].category, "DIGITAL_GOODS");
  const before = calls.length;
  await assert.rejects(
    svc.createOrder({
      orderId: "o",
      totalCents: 999,
      description: "d",
      items: [{ name: "Curso", unitCents: 1210, qty: 1, digital: true }],
      shipping: "none",
      brandName: "b",
    }),
    PayPalError,
  );
  assert.equal(calls.length, before, "no llegó a PayPal");
});

Deno.test("captureOrder: devuelve la captura normalizada (monto, estado, custom_id, envío)", async () => {
  const { svc, calls } = makeService(() => [201, {
    id: "ORDER12345",
    status: "COMPLETED",
    payer: { payer_id: "PAYER1", email_address: "x@y.com" },
    purchase_units: [{
      custom_id: "pedido-1",
      amount: { currency_code: "EUR", value: "12.10" },
      shipping: {
        name: { full_name: "Ana Pérez" },
        address: {
          address_line_1: "Calle 1",
          admin_area_2: "Madrid",
          admin_area_1: "M",
          postal_code: "28001",
          country_code: "ES",
        },
      },
      payments: {
        captures: [{
          id: "CAP-1234567",
          status: "COMPLETED",
          amount: { currency_code: "EUR", value: "12.10" },
          custom_id: "pedido-1",
        }],
      },
    }],
  }]);
  const o = await svc.captureOrder("ORDER12345", "yp-capture-1");
  assert.deepEqual(o.capture, {
    id: "CAP-1234567",
    status: "COMPLETED",
    amountCents: 1210,
    currency: "EUR",
    customId: "pedido-1",
  });
  assert.equal(o.customId, "pedido-1");
  assert.equal(o.payerId, "PAYER1");
  assert.equal(o.shipping?.name, "Ana Pérez");
  assert.equal(o.shipping?.country_code, "ES");
  assert.equal(JSON.stringify(o).includes("x@y.com"), false, "el correo del pagador no se propaga");
  assert.equal(calls.at(-1)!.headers["paypal-request-id"], "yp-capture-1");
});

Deno.test("captureOrder: ORDER_ALREADY_CAPTURED no es un error, se lee el estado actual", async () => {
  const { svc } = makeService((c) => {
    if (c.method === "POST") {
      return [422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] }];
    }
    return [200, {
      id: "ORDER12345",
      status: "COMPLETED",
      purchase_units: [{
        custom_id: "p",
        amount: { currency_code: "EUR", value: "1.00" },
        payments: {
          captures: [{ id: "CAP-1234567", status: "COMPLETED", amount: { currency_code: "EUR", value: "1.00" } }],
        },
      }],
    }];
  });
  const o = await svc.captureOrder("ORDER12345", "r");
  assert.equal(o.status, "COMPLETED");
  assert.equal(o.capture?.id, "CAP-1234567");
});

Deno.test("respuestas inválidas de PayPal se rechazan (monto raro, estado ausente, id ausente)", async () => {
  const mk = (body: unknown) => makeService(() => [200, body]).svc;
  await assert.rejects(mk({ id: "ORDER12345" }).getOrder("ORDER12345"), PayPalError, "sin status");
  await assert.rejects(mk({ status: "COMPLETED" }).getOrder("ORDER12345"), PayPalError, "sin id");
  await assert.rejects(
    mk({
      id: "ORDER12345",
      status: "COMPLETED",
      purchase_units: [{
        payments: {
          captures: [{ id: "CAP-1234567", status: "COMPLETED", amount: { currency_code: "EUR", value: "1e3" } }],
        },
      }],
    }).getOrder("ORDER12345"),
    PayPalError,
    "monto en notación científica",
  );
  const noCapture = await mk({
    id: "ORDER12345",
    status: "APPROVED",
    purchase_units: [{ custom_id: "p", amount: { currency_code: "EUR", value: "5.00" } }],
  }).getOrder("ORDER12345");
  assert.equal(noCapture.capture, null);
  assert.equal(noCapture.amountCents, 500);
});

Deno.test("getRefund: monto, estado y captura de origen (enlace 'up')", async () => {
  const { svc } = makeService(
    () => [200, {
      id: "REFUND-1234",
      status: "COMPLETED",
      amount: { currency_code: "EUR", value: "2.00" },
      links: [{ rel: "self", href: "https://x/refunds/REFUND-1234" }, {
        rel: "up",
        href: "https://api.paypal.com/v2/payments/captures/CAP-1234567",
      }],
    }],
  );
  assert.deepEqual(await svc.getRefund("REFUND-1234"), {
    id: "REFUND-1234",
    status: "COMPLETED",
    amountCents: 200,
    currency: "EUR",
    captureId: "CAP-1234567",
  });
});

// ---------------------------------------------------------------- webhook
Deno.test("verifyWebhook: manda las 5 cabeceras, el id del webhook y el evento; SUCCESS=true, cualquier otra cosa=false", async () => {
  let status = "SUCCESS";
  const { svc, calls } = makeService((
    c,
  ) => (c.url.endsWith("/v1/notifications/verify-webhook-signature")
    ? [200, { verification_status: status }]
    : undefined)
  );
  const input = {
    webhookId: "WH-ID-1",
    headers: {
      authAlgo: "SHA256withRSA",
      certUrl: "https://api.paypal.com/cert",
      transmissionId: "tx",
      transmissionSig: "sig",
      transmissionTime: "2026-10-08T00:00:00Z",
    },
    event: { id: "WH-1", event_type: "X.Y", resource: { a: 1 } },
  };
  assert.equal(await svc.verifyWebhook(input), true);
  assert.deepEqual(calls.at(-1)!.body, {
    auth_algo: "SHA256withRSA",
    cert_url: "https://api.paypal.com/cert",
    transmission_id: "tx",
    transmission_sig: "sig",
    transmission_time: "2026-10-08T00:00:00Z",
    webhook_id: "WH-ID-1",
    webhook_event: input.event,
  });
  status = "FAILURE";
  assert.equal(await svc.verifyWebhook(input), false);
  status = "";
  assert.equal(await svc.verifyWebhook(input), false);
});

// ---------------------------------------------------------------- suscripciones
Deno.test("createSubscription: plan, custom_id y flujo sin envío; idempotente por clave", async () => {
  const { svc, calls } = makeService((
    c,
  ) => (c.url.endsWith("/v1/billing/subscriptions")
    ? [201, { id: "I-BW452GLLEP1G", status: "APPROVAL_PENDING" }]
    : undefined)
  );
  const r = await svc.createSubscription({
    planId: "P-PLAN",
    userId: "user-1",
    brandName: "Yoga",
    returnUrl: "https://yoga.test/",
    cancelUrl: "https://yoga.test/",
    requestId: "yp-sub-1",
  });
  assert.equal(r.id, "I-BW452GLLEP1G");
  const call = calls.at(-1)!;
  assert.equal(call.headers["paypal-request-id"], "yp-sub-1");
  const body = call.body as Record<string, any>;
  assert.equal(body.plan_id, "P-PLAN");
  assert.equal(body.custom_id, "user-1");
  assert.equal(body.application_context.shipping_preference, "NO_SHIPPING");
  assert.equal(body.application_context.return_url, "https://yoga.test/");
});

Deno.test("getSubscription: estado, plan, custom_id y fechas válidas; fechas inválidas -> null", async () => {
  const mk = (billing: unknown) =>
    makeService(
      () => [200, {
        id: "I-BW452GLLEP1G",
        plan_id: "P-PLAN",
        status: "ACTIVE",
        custom_id: "user-1",
        billing_info: billing,
      }],
    ).svc;
  const ok = await mk({ next_billing_time: "2026-11-08T10:00:00Z", last_payment: { time: "2026-10-08T10:00:00Z" } })
    .getSubscription("I-BW452GLLEP1G");
  assert.equal(ok.nextBillingTime, "2026-11-08T10:00:00.000Z");
  assert.equal(ok.lastPaymentTime, "2026-10-08T10:00:00.000Z");
  assert.equal(ok.customId, "user-1");
  const bad = await mk({ next_billing_time: "mañana" }).getSubscription("I-BW452GLLEP1G");
  assert.equal(bad.nextBillingTime, null);
  await assert.rejects(
    makeService(() => [200, { id: "I-BW452GLLEP1G" }]).svc.getSubscription("I-BW452GLLEP1G"),
    PayPalError,
  );
});

Deno.test("cancelSubscription: POST /cancel con motivo acotado (204 sin cuerpo)", async () => {
  const { svc, calls } = makeService((c) => (c.url.endsWith("/cancel") ? [204, null] : undefined));
  await svc.cancelSubscription("I-BW452GLLEP1G", "x".repeat(500));
  const call = calls.at(-1)!;
  assert.ok(call.url.endsWith("/v1/billing/subscriptions/I-BW452GLLEP1G/cancel"));
  assert.equal((call.body as { reason: string }).reason.length, 128);
});
