import assert from "node:assert/strict";
import {
  discountedCents,
  discountLabel,
  minTierLabel,
  normalizeMinTier,
  parseTierDiscount,
  parseTierFreeClasses,
  parseTierPrice,
  parseTierText,
  sellableTiers,
  sortTiers,
  tierBenefitLines,
  tierDiscountBps,
  tierName,
  tierPriceLabel,
  tiersFromMin,
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

Deno.test("nivel mínimo de una clase: se normaliza, es acumulativo y se describe", () => {
  assert.equal(normalizeMinTier("3"), 3);
  assert.equal(normalizeMinTier(2), 2);
  assert.equal(normalizeMinTier(null), 1, "sin dato: la ven todos");
  assert.equal(normalizeMinTier("x"), 1);
  assert.equal(normalizeMinTier(7), 1);
  assert.equal(normalizeMinTier(0), 1);
  assert.deepEqual(tiersFromMin(1), [1, 2, 3]);
  assert.deepEqual(tiersFromMin(2), [2, 3], "el nivel 3 ve también lo del nivel 2");
  assert.deepEqual(tiersFromMin(3), [3]);
  assert.deepEqual(tiersFromMin(undefined), [1, 2, 3]);
  assert.equal(minTierLabel(1), "Todos los niveles");
  assert.equal(minTierLabel(2), "Niveles 2 y 3");
  assert.equal(minTierLabel(3), "Solo nivel 3");
  assert.equal(minTierLabel(null), "Todos los niveles");
});

Deno.test("niveles: el nombre de un nivel se busca por número", () => {
  assert.equal(tierName(rows, 3), "Premium");
  assert.equal(tierName(rows, 5), "");
  assert.equal(tierName([], 1), "");
});

Deno.test("descuento del nivel: porcentaje del panel -> puntos básicos, con los mismos límites que la base", () => {
  assert.deepEqual(parseTierDiscount("5"), { ok: true, bps: 500 });
  assert.deepEqual(parseTierDiscount("7,5"), { ok: true, bps: 750 });
  assert.deepEqual(parseTierDiscount("7.25"), { ok: true, bps: 725 });
  assert.deepEqual(parseTierDiscount(""), { ok: true, bps: 0 }, "vacío = sin descuento");
  assert.deepEqual(parseTierDiscount("50"), { ok: true, bps: 5000 });
  for (const bad of ["51", "-1", "abc", "5%", "1,234", "100"]) {
    assert.equal(parseTierDiscount(bad).ok, false, bad);
  }
  assert.equal(discountLabel(500), "5 %");
  assert.equal(discountLabel(750), "7,5 %");
  assert.equal(discountLabel(0), "0 %");
});

Deno.test("clases gratis por mes: de 0 a 5", () => {
  assert.deepEqual(parseTierFreeClasses("1"), { ok: true, count: 1 });
  assert.deepEqual(parseTierFreeClasses(""), { ok: true, count: 0 });
  assert.deepEqual(parseTierFreeClasses("5"), { ok: true, count: 5 });
  for (const bad of ["6", "-1", "1,5", "x"]) assert.equal(parseTierFreeClasses(bad).ok, false, bad);
});

Deno.test("precio con descuento: igual que el servidor (por unidad, nunca menos de 1 céntimo)", () => {
  assert.equal(discountedCents(1000, 500), 950);
  assert.equal(discountedCents(2000, 700), 1860);
  assert.equal(discountedCents(999, 0), 999);
  assert.equal(discountedCents(1, 700), 1);
  assert.equal(discountedCents(1999, 500), 1899, "1899,05 se redondea al céntimo");
  assert.equal(tierDiscountBps([{ tier: 2, price_cents: 2000, discount_bps: 500 }], 2), 500);
  assert.equal(tierDiscountBps([], 2), 0);
});

Deno.test("beneficios del nivel: los videos suman y el resto sale de lo que dice la base", () => {
  assert.deepEqual(tierBenefitLines({ tier: 1, discount_bps: 0, monthly_free_classes: 0 }), ["Los videos del nivel 1"]);
  assert.deepEqual(tierBenefitLines({ tier: 2, discount_bps: 500, monthly_free_classes: 0 }), [
    "Los videos de los niveles 1 y 2",
    "5 % de descuento en toda la tienda",
  ]);
  assert.deepEqual(tierBenefitLines({ tier: 3, discount_bps: 700, monthly_free_classes: 1 }), [
    "Todos los videos, sin excepciones",
    "7 % de descuento en toda la tienda",
    "1 clase virtual gratis por mes",
  ]);
  assert.deepEqual(
    tierBenefitLines({ tier: 3, discount_bps: 0, monthly_free_classes: 2 }).at(-1),
    "2 clases virtuales gratis por mes",
  );
});
