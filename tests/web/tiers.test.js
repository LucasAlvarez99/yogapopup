import assert from "node:assert/strict";
import {
  classTiersLabel,
  normalizeClassTiers,
  parseTierPrice,
  parseTierText,
  sellableTiers,
  sortTiers,
  tierName,
  tierPriceLabel,
} from "../../js/lib/tiers.js";

const rows = [
  { tier: 3, name: "Premium", benefits: "", price_cents: 3000, plan_ready: true },
  { tier: 1, name: "Esencial", benefits: "", price_cents: 1000, plan_ready: true },
  { tier: 2, name: "Plus", benefits: "", price_cents: 2000, plan_ready: false },
  { tier: 9, name: "Rara", price_cents: 1 },
  null,
];

Deno.test("niveles: se ordenan y una fila rara no rompe nada", () => {
  assert.deepEqual(sortTiers(rows).map((r) => r.tier), [1, 2, 3]);
  assert.deepEqual(sortTiers(null), []);
  assert.deepEqual(sortTiers("x"), []);
});

Deno.test("niveles: solo se ofrecen los que tienen plan y entran en los niveles de la clase", () => {
  assert.deepEqual(sellableTiers(rows).map((r) => r.tier), [1, 3], "el 2 todavía no tiene plan");
  assert.deepEqual(sellableTiers(rows, [3]).map((r) => r.tier), [3]);
  assert.deepEqual(sellableTiers(rows, [2]).map((r) => r.tier), [], "la clase pide un nivel que aún no se vende");
  assert.deepEqual(sellableTiers(rows, []).map((r) => r.tier), [1, 3], "lista vacía = sin filtro");
  assert.deepEqual(sellableTiers(rows, null).map((r) => r.tier), [1, 3]);
});

Deno.test("niveles: el precio se muestra por mes, sin decimales si es redondo", () => {
  assert.equal(tierPriceLabel(1000), "10 € / mes");
  assert.equal(tierPriceLabel(2990), "29,90 € / mes");
  assert.equal(tierPriceLabel(1250), "12,50 € / mes");
});

Deno.test("niveles: el precio del panel acepta coma o punto y rechaza lo que el servidor rechazaría", () => {
  assert.deepEqual(parseTierPrice("10"), { ok: true, cents: 1000 });
  assert.deepEqual(parseTierPrice(" 12,5 "), { ok: true, cents: 1250 });
  assert.deepEqual(parseTierPrice("29.99 €"), { ok: true, cents: 2999 });
  assert.deepEqual(parseTierPrice("500"), { ok: true, cents: 50000 });
  assert.deepEqual(parseTierPrice("1"), { ok: true, cents: 100 });
  for (const bad of ["", "0", "0,50", "501", "-5", "abc", "1,234", "1e3", null, undefined]) {
    assert.equal(parseTierPrice(bad).ok, false, `«${bad}»`);
  }
});

Deno.test("niveles: nombre y beneficios tienen los mismos límites que la base", () => {
  assert.deepEqual(parseTierText("  Plus ", " Una clase gratis al mes "), {
    ok: true,
    name: "Plus",
    benefits: "Una clase gratis al mes",
  });
  assert.equal(parseTierText("", "x").ok, false);
  assert.equal(parseTierText("x".repeat(41), "").ok, false);
  assert.equal(parseTierText("Plus", "x".repeat(401)).ok, false);
  assert.equal(parseTierText("Plus", "").ok, true, "los beneficios pueden quedar vacíos");
});

Deno.test("niveles de una clase: se normalizan y se describen", () => {
  assert.deepEqual(normalizeClassTiers(["3", 2, 2, "x", 7, 0]), [2, 3]);
  assert.deepEqual(normalizeClassTiers(null), []);
  assert.equal(classTiersLabel([1, 2, 3]), "Todos los niveles");
  assert.equal(classTiersLabel([]), "Todos los niveles");
  assert.equal(classTiersLabel([3]), "Nivel 3");
  assert.equal(classTiersLabel([2, 3]), "Niveles 2 y 3");
  assert.equal(classTiersLabel([1, 3]), "Niveles 1 y 3");
});

Deno.test("niveles: el nombre de un nivel se busca por número", () => {
  assert.equal(tierName(rows, 3), "Premium");
  assert.equal(tierName(rows, 5), "");
  assert.equal(tierName([], 1), "");
});
