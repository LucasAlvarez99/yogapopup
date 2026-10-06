import assert from "node:assert/strict";
import { DEFAULT_TAX_BPS, formatRate, normalizeRate, priceParts, splitTax } from "../../js/lib/tax.js";

Deno.test("splitTax: separa base e IVA con enteros y base + IVA suman SIEMPRE el precio", () => {
  assert.deepEqual(splitTax(3500, 2100), { grossCents: 3500, netCents: 2893, taxCents: 607, rateBps: 2100 });
  assert.deepEqual(splitTax(12100, 2100), { grossCents: 12100, netCents: 10000, taxCents: 2100, rateBps: 2100 });
  assert.deepEqual(splitTax(5500, 2100), { grossCents: 5500, netCents: 4545, taxCents: 955, rateBps: 2100 });
  assert.deepEqual(splitTax(1100, 1000), { grossCents: 1100, netCents: 1000, taxCents: 100, rateBps: 1000 });
  assert.deepEqual(splitTax(1040, 400), { grossCents: 1040, netCents: 1000, taxCents: 40, rateBps: 400 });
  assert.deepEqual(splitTax(999, 0), { grossCents: 999, netCents: 999, taxCents: 0, rateBps: 0 }, "exento: sin IVA");
  assert.deepEqual(splitTax(0, 2100), { grossCents: 0, netCents: 0, taxCents: 0, rateBps: 2100 });
  for (const rate of [0, 400, 1000, 2100, 2500]) {
    for (let g = 0; g <= 5000; g += 7) {
      const r = splitTax(g, rate);
      assert.equal(r.netCents + r.taxCents, g, `suma exacta ${g} @ ${rate}`);
      assert.ok(r.netCents <= g && r.taxCents >= 0);
      assert.ok(
        Math.abs(r.netCents - (g * 10000) / (10000 + rate)) <= 0.5 + 1e-9,
        `redondeo al céntimo más cercano ${g} @ ${rate}`,
      );
    }
  }
});

Deno.test("splitTax: precios inválidos dan null (nunca un número inventado) y el tipo inválido vuelve al general", () => {
  for (const bad of [-1, 1.5, NaN, Infinity, "3500", null, undefined, 2 ** 60]) {
    assert.equal(splitTax(bad), null, String(bad));
  }
  for (const bad of [-1, 2501, 10.5, NaN, "2100", null, undefined, {}]) {
    assert.equal(normalizeRate(bad), DEFAULT_TAX_BPS, String(bad));
    assert.equal(splitTax(3500, bad).rateBps, 2100);
  }
  assert.equal(splitTax(3500).rateBps, 2100, "sin tipo = 21 %");
});

Deno.test("priceParts: el precio grande y, al lado, el precio sin IVA (nada que mostrar si es exento)", () => {
  const p = priceParts(3500, 2100);
  assert.match(p.price, /^35,00\s€$/);
  assert.match(p.net, /^28,93\s€$/);
  assert.equal(p.rateLabel, "21 %");
  assert.equal(priceParts(3500, 0).net, "", "exento: no repite la cifra");
  assert.deepEqual(priceParts(null), { price: "", net: "", rateLabel: "" });
  assert.match(priceParts(1100, 1000).net, /^10,00\s€$/);
});

Deno.test("formatRate: 21 %, 10 %, 4 %, 0 % y decimales con coma", () => {
  assert.equal(formatRate(2100), "21 %");
  assert.equal(formatRate(1000), "10 %");
  assert.equal(formatRate(400), "4 %");
  assert.equal(formatRate(0), "0 %");
  assert.equal(formatRate(1050), "10,5 %");
});
