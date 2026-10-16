import assert from "node:assert/strict";
import {
  checkoutTotals,
  PROVINCES,
  shipContactLines,
  shippingFor,
  shipToLines,
  validateShipTo,
} from "../../js/lib/shipping.js";
import { orderBreakdown } from "../../js/lib/account-view.js";
import { parseShippingPrice } from "../../js/lib/payments-view.js";

const OK = {
  name: "  Ana   Pérez ",
  address_line_1: "Calle Mayor 1",
  address_line_2: "",
  postal_code: "07800",
  city: "Ibiza",
  region: "Illes Balears",
  phone: "+34 600 111 222",
  email: "ana@test.dev",
};

Deno.test("validateShipTo: un domicilio completo es válido, queda limpio y con el país fijo", () => {
  const r = validateShipTo(OK);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, {});
  assert.equal(r.value.name, "Ana Pérez", "espacios de más fuera");
  assert.equal(r.value.address_line_2, null, "la línea 2 vacía es null");
  assert.equal(r.value.country_code, "ES");
});

Deno.test("validateShipTo: cada campo obligatorio dice qué corregir", () => {
  const r = validateShipTo({});
  assert.equal(r.ok, false);
  for (const f of ["name", "address_line_1", "postal_code", "city", "region", "phone", "email"]) {
    assert.ok(r.errors[f], `falta mensaje para ${f}`);
  }
  assert.equal(r.errors.address_line_2, undefined, "la línea 2 es opcional");
});

Deno.test("validateShipTo: código postal de 5 números, provincia de la lista, teléfono y mail razonables", () => {
  assert.ok(validateShipTo({ ...OK, postal_code: "7800" }).errors.postal_code);
  assert.ok(validateShipTo({ ...OK, postal_code: "07 80" }).errors.postal_code);
  assert.ok(validateShipTo({ ...OK, region: "Narnia" }).errors.region);
  assert.ok(validateShipTo({ ...OK, phone: "abc" }).errors.phone);
  assert.ok(validateShipTo({ ...OK, phone: "123" }).errors.phone);
  assert.ok(validateShipTo({ ...OK, email: "sin-arroba" }).errors.email);
  assert.equal(validateShipTo({ ...OK, phone: "600111222" }).ok, true);
  assert.equal(PROVINCES[0], "Illes Balears", "Baleares primero");
  assert.equal(new Set(PROVINCES).size, PROVINCES.length, "sin provincias repetidas");
});

Deno.test("shipToLines / shipContactLines: domicilio y contacto en líneas de texto", () => {
  const v = validateShipTo(OK).value;
  assert.deepEqual(shipToLines(v), ["Ana Pérez", "Calle Mayor 1", "07800 Ibiza", "Illes Balears, España"]);
  assert.deepEqual(shipContactLines(v), ["Tel: +34 600 111 222", "Mail: ana@test.dev"]);
  assert.deepEqual(shipToLines(null), []);
  assert.deepEqual(shipContactLines(undefined), []);
  // el domicilio de PayPal (sin contacto) también se dibuja
  assert.deepEqual(
    shipToLines({
      name: "Lucas",
      address_line_1: "Villa Lugano",
      postal_code: "1439",
      city: "CABA",
      country_code: "AR",
    }),
    ["Lucas", "Villa Lugano", "1439 CABA", "AR"],
  );
});

Deno.test("shippingFor / checkoutTotals: el envío solo con productos y el total es compra + envío", () => {
  assert.equal(shippingFor(true, 1000), 1000);
  assert.equal(shippingFor(false, 1000), 0, "solo videos: sin envío");
  assert.equal(shippingFor(true, -5), 0);
  assert.equal(shippingFor(true, "x"), 0);
  assert.equal(shippingFor(true, 9.5), 0, "céntimos enteros");
  const t = checkoutTotals({ hasProducts: true, subtotalCents: 4000, taxCents: 694 }, 1000);
  assert.equal(t.shippingCents, 1000);
  assert.equal(t.totalCents, 5000);
  assert.equal(t.taxCents, 694 + 174, "el IVA incluido del envío (21 %) se suma");
  const v = checkoutTotals({ hasProducts: false, subtotalCents: 1500, taxCents: 260 }, 1000);
  assert.equal(v.totalCents, 1500);
  assert.equal(v.taxCents, 260);
});

Deno.test("orderBreakdown: detalle del pedido con cada línea, el envío y el total", () => {
  const rows = orderBreakdown({
    total_cents: 5000,
    shipping_cents: 1000,
    order_items: [{ title: "Mat", size: null, qty: 2, unit_cents: 2000 }],
  });
  assert.deepEqual(rows.map((r) => r.label), ["2 × Mat", "Envío", "Total"]);
  assert.match(rows[0].amount, /40,00/);
  assert.match(rows[1].amount, /10,00/);
  assert.match(rows[2].amount, /50,00/);
  assert.equal(rows[2].total, true);
  const sin = orderBreakdown({ total_cents: 1500, order_items: [{ title: "Video", qty: 1, unit_cents: 1500 }] });
  assert.deepEqual(sin.map((r) => r.label), ["1 × Video", "Total"], "sin envío no hay línea de envío");
  assert.deepEqual(
    orderBreakdown({ total_cents: 1, order_items: [{ title: "x", qty: 1 }] }),
    [],
    "sin importes no se inventa un detalle",
  );
  assert.deepEqual(orderBreakdown({}), []);
});

Deno.test("parseShippingPrice: euros con coma o punto; 0 es envío gratis; vacío o negativo no valen", () => {
  assert.deepEqual(parseShippingPrice("10"), { ok: true, cents: 1000 });
  assert.deepEqual(parseShippingPrice("9,50"), { ok: true, cents: 950 });
  assert.deepEqual(parseShippingPrice("0"), { ok: true, cents: 0 });
  for (const bad of ["", "  ", "abc", "-1", "1001"]) assert.equal(parseShippingPrice(bad).ok, false, bad);
});
