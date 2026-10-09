import assert from "node:assert/strict";
import {
  describeItems,
  MAX_CLASS_PRICE_CENTS,
  ORDER_STATUS,
  parseClassPrice,
  reconcileMessage,
  reviewNoteText,
  shippingLines,
  statusInfo,
  SUBSCRIPTION_STATUS,
  sweepMessage,
} from "../../js/lib/payments-view.js";

Deno.test("estados de pedido y suscripción: todos los que existen en la base tienen texto", () => {
  for (const s of ["created", "pending", "paid", "failed", "cancelled", "refunded"]) {
    assert.ok(ORDER_STATUS[s]?.label, s);
  }
  for (const s of ["approval_pending", "active", "suspended", "cancelled", "expired"]) {
    assert.ok(SUBSCRIPTION_STATUS[s]?.label, s);
  }
  assert.deepEqual(
    statusInfo(ORDER_STATUS, "inventado"),
    { label: "inventado", tone: "secondary" },
    "un estado desconocido no rompe la tabla",
  );
  assert.equal(statusInfo(ORDER_STATUS, undefined).label, "");
});

Deno.test("estados de la base == estados del panel (no se desfasan)", () => {
  const sql = Deno.readTextFileSync(
    new URL("../../supabase/migrations/20261008120000_payments_paypal.sql", import.meta.url),
  );
  const listOf = (re) => [...sql.match(re)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    Object.keys(ORDER_STATUS).sort(),
    listOf(/status\s+text\s+not null default 'created'\s+check \(status in \(([^)]*)\)/),
  );
  assert.deepEqual(
    Object.keys(SUBSCRIPTION_STATUS).sort(),
    listOf(/status\s+text\s+not null default 'approval_pending'\s+check \(status in \(([^)]*)\)/),
  );
});

Deno.test("reviewNoteText: explica qué pasó y qué hacer", () => {
  assert.match(reviewNoteText("amount_mismatch"), /importe distinto/);
  assert.match(reviewNoteText("paid_without_stock"), /reembolsar/);
  assert.match(reviewNoteText("otra cosa"), /revisión/);
  assert.equal(reviewNoteText(null), "");
});

Deno.test("describeItems y shippingLines", () => {
  assert.equal(
    describeItems([{ qty: 2, title: "Mat", size: null }, { qty: 1, title: "Remera", size: "M" }]),
    "2 × Mat, 1 × Remera (talle M)",
  );
  assert.equal(describeItems(undefined), "");
  assert.deepEqual(
    shippingLines({
      name: "Ana Pérez",
      address_line_1: "Calle 1",
      address_line_2: null,
      city: "Madrid",
      region: "M",
      postal_code: "28001",
      country_code: "ES",
    }),
    ["Ana Pérez", "Calle 1", "28001 Madrid", "M, ES"],
  );
  assert.deepEqual(shippingLines(null), []);
  assert.deepEqual(shippingLines("raro"), []);
});

Deno.test("reconcileMessage / sweepMessage", () => {
  assert.equal(reconcileMessage("paid").type, "success");
  assert.equal(reconcileMessage("mismatch").type, "error");
  assert.equal(reconcileMessage("wrong_plan").type, "error");
  assert.match(reconcileMessage("cancelled").text, /stock/);
  assert.equal(reconcileMessage("???").type, "info");
  assert.match(
    sweepMessage({ checked: 3, paid: 1, cancelled: 2, failed: 0, errors: 0 }),
    /1 pagado, 2 cancelados \(stock liberado\)/,
  );
  assert.match(sweepMessage({ checked: 4, paid: 0, cancelled: 0, failed: 0, errors: 1 }), /1 con error/);
  assert.match(
    sweepMessage({ checked: 2, paid: 0, cancelled: 0, failed: 0, errors: 0 }),
    /nada pendiente \(2 pedidos revisados\)/,
  );
});

Deno.test("parseClassPrice: euros -> céntimos; vacío = no se vende suelta; inválido se rechaza", () => {
  assert.deepEqual(parseClassPrice("12,10"), { ok: true, cents: 1210 });
  assert.deepEqual(parseClassPrice(" 12.5 € "), { ok: true, cents: 1250 });
  assert.deepEqual(parseClassPrice("0,99"), { ok: true, cents: 99 });
  assert.deepEqual(parseClassPrice(""), { ok: true, cents: null });
  assert.deepEqual(parseClassPrice("   "), { ok: true, cents: null });
  assert.deepEqual(parseClassPrice(null), { ok: true, cents: null });
  for (const bad of ["0", "0,00", "-5", "abc", "1.999,50", "12,345", "100001", "1e3"]) {
    assert.equal(parseClassPrice(bad).ok, false, bad);
  }
  assert.equal(parseClassPrice("100000").ok, true, "100.000 € es el tope");
  assert.equal(MAX_CLASS_PRICE_CENTS, 10_000_000);
});
