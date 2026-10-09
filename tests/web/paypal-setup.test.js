import assert from "node:assert/strict";
import {
  buildPlanBody,
  buildProductBody,
  buildWebhookBody,
  parseArgs,
  priceToCents,
  WEBHOOK_EVENTS,
} from "../../scripts/lib/paypal-setup.mjs";

Deno.test("priceToCents: precio final en euros -> céntimos, estricto", () => {
  assert.equal(priceToCents("9,99"), 999);
  assert.equal(priceToCents("9.99"), 999);
  assert.equal(priceToCents("10"), 1000);
  assert.equal(priceToCents(" 12,5 "), 1250);
  for (const bad of ["", "0", "0,00", "-1", "1,234", "abc", "1.000,50", undefined, null, true]) {
    assert.equal(priceToCents(bad), null, String(bad));
  }
});

Deno.test("buildPlanBody: mensual, sin fin, EUR, IVA incluido y reintentos de cobro acotados", () => {
  const b = buildPlanBody({ productId: "PROD-1", name: "Videoteca", priceCents: 999 });
  assert.equal(b.product_id, "PROD-1");
  assert.equal(b.status, "ACTIVE");
  const c = b.billing_cycles[0];
  assert.deepEqual(c.frequency, { interval_unit: "MONTH", interval_count: 1 });
  assert.equal(c.total_cycles, 0, "se renueva hasta que la persona cancele");
  assert.deepEqual(c.pricing_scheme.fixed_price, { value: "9.99", currency_code: "EUR" });
  assert.deepEqual(b.taxes, { percentage: "21", inclusive: true });
  assert.equal(b.payment_preferences.payment_failure_threshold, 3);
  assert.equal(b.payment_preferences.setup_fee_failure_action, "CANCEL");
  assert.equal(
    buildPlanBody({ productId: "P", name: "n", priceCents: 5000, interval: "YEAR", taxPercent: 10 }).billing_cycles[0]
      .pricing_scheme.fixed_price.value,
    "50.00",
  );
  assert.throws(() => buildPlanBody({ productId: "P", name: "n", priceCents: 0 }));
  assert.throws(() => buildPlanBody({ productId: "P", name: "n", priceCents: 99.5 }));
  assert.throws(() => buildPlanBody({ productId: "P", name: "n", priceCents: 100, interval: "WEEK" }));
  assert.equal(buildProductBody("x".repeat(300)).name.length, 127);
});

Deno.test("buildWebhookBody: solo https y con TODOS los eventos que usa el backend", () => {
  const b = buildWebhookBody("https://abc.supabase.co/functions/v1/paypal-webhook");
  assert.equal(b.url, "https://abc.supabase.co/functions/v1/paypal-webhook");
  assert.deepEqual(b.event_types.map((e) => e.name), WEBHOOK_EVENTS);
  for (const bad of ["http://x.com/h", "ftp://x", "", "no es url", undefined]) {
    assert.throws(() => buildWebhookBody(bad), /https/, String(bad));
  }
});

Deno.test("WEBHOOK_EVENTS == los eventos que maneja logic.ts (si uno cambia y el otro no, el webhook pierde eventos)", () => {
  const src = Deno.readTextFileSync(new URL("../../supabase/functions/_shared/payments/logic.ts", import.meta.url));
  const handled = new Set([...src.matchAll(/"((?:PAYMENT|BILLING)\.[A-Z.-]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(WEBHOOK_EVENTS)].sort(), [...handled].sort());
  assert.equal(new Set(WEBHOOK_EVENTS).size, WEBHOOK_EVENTS.length, "sin duplicados");
});

Deno.test("parseArgs", () => {
  assert.deepEqual(parseArgs(["plan", "--price", "9,99", "--confirm-live", "--name", "Mi plan"]), {
    _: ["plan"],
    price: "9,99",
    "confirm-live": true,
    name: "Mi plan",
  });
  assert.deepEqual(parseArgs([]), { _: [] });
});
