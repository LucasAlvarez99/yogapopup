import assert from "node:assert/strict";
import {
  cartOptionsFor,
  findVariant,
  hasSizes,
  MAX_SIZES,
  productAvailability,
  sizesSummary,
  sortedVariants,
  validateSizeRows,
  variantInfo,
} from "../../js/lib/sizes.js";

const V = (n, size, stock, sort_order = n) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  size,
  stock,
  sort_order,
});
const product = (variants, stock = null) => ({
  id: "10000000-0000-4000-8000-000000000001",
  stock,
  product_variants: variants,
});

Deno.test("talles: se ordenan por sort_order, estable, y se ignoran los datos rotos", () => {
  const p = product([V(1, "L", 1, 2), V(2, "S", 1, 0), V(3, "M", 1, 1), V(4, "XL", 1, 2), null, { id: 5 }, {
    id: "x",
    size: "",
  }]);
  assert.deepEqual(sortedVariants(p).map((v) => v.size), ["S", "M", "L", "XL"]);
  assert.deepEqual(sortedVariants({}), []);
  assert.deepEqual(sortedVariants(null), []);
  assert.deepEqual(sortedVariants({ product_variants: "no" }), []);
  assert.equal(hasSizes(p), true);
  assert.equal(hasSizes(product([])), false);
  assert.equal(hasSizes({}), false);
  assert.equal(sizesSummary(p), "S · M · L · XL");
  assert.equal(sizesSummary({}), "");
});

Deno.test("talles: findVariant busca por id sin importar mayúsculas y nunca inventa", () => {
  const p = product([V(1, "S", 1), V(2, "M", 1)]);
  assert.equal(findVariant(p, "00000000-0000-4000-8000-000000000002").size, "M");
  assert.equal(findVariant(p, "00000000-0000-4000-8000-000000000002".toUpperCase()).size, "M");
  for (const bad of ["00000000-0000-4000-8000-000000000009", "", null, undefined, 5, {}]) {
    assert.equal(findVariant(p, bad), null);
  }
});

Deno.test("talles: disponibilidad por talle y del producto (con talles manda el stock de cada talle)", () => {
  assert.deepEqual(variantInfo(V(1, "S", 0)), { available: false, label: "Agotado" });
  assert.deepEqual(variantInfo(V(1, "S", 3)), { available: true, label: "Últimas 3 unidades" });
  assert.deepEqual(variantInfo(V(1, "S", null)), { available: true, label: "" });
  assert.deepEqual(variantInfo(V(1, "S", 50)), { available: true, label: "" });

  // el stock del PRODUCTO se ignora cuando hay talles
  assert.equal(productAvailability(product([V(1, "S", 0), V(2, "M", 2)], 0)).available, true);
  assert.equal(productAvailability(product([V(1, "S", 0), V(2, "M", 0)], 99)).available, false);
  assert.equal(productAvailability(product([V(1, "S", 0), V(2, "M", null)], 0)).available, true, "sin control = hay");
  assert.equal(productAvailability(product([V(1, "S", 1)])).hasSizes, true);
  // sin talles: la regla de siempre
  assert.deepEqual(productAvailability(product([], 0)), { hasSizes: false, available: false, label: "Agotado" });
  assert.deepEqual(productAvailability(product([], null)), { hasSizes: false, available: true, label: "" });
});

Deno.test("talles: cartOptionsFor entrega el id y el stock del talle", () => {
  assert.deepEqual(cartOptionsFor(V(2, "M", 4)), { variant: "00000000-0000-4000-8000-000000000002", stock: 4 });
});

Deno.test("validateSizeRows: limpia, acepta stock vacío (= sin control) y deja todo listo para la base", () => {
  assert.deepEqual(
    validateSizeRows([{ size: "  S ", stock: "3" }, { size: "M", stock: "" }, { size: "2XL", stock: null }, {
      size: "Única",
      stock: 0,
    }]).value,
    [
      { size: "S", stock: 3 },
      { size: "M", stock: null },
      { size: "2XL", stock: null },
      { size: "Única", stock: 0 },
    ],
  );
  assert.deepEqual(validateSizeRows([]).value, []);
  assert.deepEqual(validateSizeRows(undefined).value, []);
  assert.deepEqual(
    validateSizeRows([{ size: "  talle   grande " }]).value,
    [{ size: "talle grande", stock: null }],
    "espacios repetidos se juntan",
  );
  assert.equal(validateSizeRows([{ size: "S", stock: "1000000" }]).value[0].stock, 1000000);
});

Deno.test("validateSizeRows: cada error tiene un mensaje claro y no se manda nada", () => {
  const err = (rows) => validateSizeRows(rows).error;
  assert.match(err([{ size: "" }]), /sin nombre/);
  assert.match(err([{ size: "   " }]), /sin nombre/);
  assert.match(err([{ size: "S" }, { size: "s" }]), /repetido/);
  assert.match(err([{ size: "M" }, { size: " M " }]), /«M».*repetido/);
  assert.match(err([{ size: "x".repeat(21) }]), /muy largo/);
  assert.match(err([{ size: "a\u0007b" }]), /no válidos/);
  assert.deepEqual(
    validateSizeRows([{ size: "a\tb" }]).value,
    [{ size: "a b", stock: null }],
    "un tabulador es solo un espacio",
  );
  for (const bad of ["-1", "1.5", "1,5", "abc", "1e3", "1000001", "99999999", "+3"]) {
    assert.match(err([{ size: "S", stock: bad }]), /stock del talle S.*entero/, bad);
  }
  assert.match(err(Array.from({ length: MAX_SIZES + 1 }, (_, i) => ({ size: `T${i}` }))), /hasta 20/);
  assert.equal(validateSizeRows(Array.from({ length: MAX_SIZES }, (_, i) => ({ size: `T${i}` }))).value.length, 20);
});

import { isSchemaBehind } from "../../js/lib/catalog.js";

Deno.test("base atrasada: se reconoce el error de una base sin las migraciones de talles/IVA (y solo ese)", () => {
  for (const code of ["PGRST200", "PGRST204", "42703", "42P01"]) assert.equal(isSchemaBehind({ code }), true, code);
  for (
    const e of [null, undefined, {}, { code: "42501" }, { code: "PGRST116" }, { code: "23514" }, {
      message: "red caída",
    }]
  ) {
    assert.equal(isSchemaBehind(e), false, JSON.stringify(e));
  }
});
