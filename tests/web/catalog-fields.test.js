import assert from "node:assert/strict";
import {
  canonicalCategory,
  categoryProblem,
  cleanCategory,
  knownCategories,
  parseSortOrder,
  SORT_HINT,
} from "../../js/lib/catalog-fields.js";
import { buildProductInput } from "../../js/lib/product-form.js";

const ok = { title: "Mat", description: "", category: "", price: "10", stock: "", sort_order: "", is_active: false };

Deno.test("categoría: una categoría solo de números es un error (el número va en 'Orden')", () => {
  for (const bad of ["2", " 5 ", "3333", "1.5", "1,5", "12 34", "007"]) {
    assert.match(categoryProblem(bad), /texto.*no un número/, JSON.stringify(bad));
  }
  for (const good of ["", "Ropa", "Accesorios", "Set 2", "2024 Verano", "Yoga y 1", "Mats"]) {
    assert.equal(categoryProblem(good), null, JSON.stringify(good));
  }
});

Deno.test("categoría: la que YA era numérica y no se toca no impide editar el producto (el precio, el stock…)", () => {
  assert.equal(categoryProblem("3333", { previous: "3333" }), null);
  assert.equal(categoryProblem(" 3333 ", { previous: "3333" }), null);
  assert.match(categoryProblem("4444", { previous: "3333" }), /texto/, "pero si la cambia a otro número, no");
  assert.match(categoryProblem("3333", { previous: "Ropa" }), /texto/);
});

Deno.test("categoría: limpia espacios y adopta la grafía de una ya existente (sin importar mayúsculas ni tildes)", () => {
  assert.equal(cleanCategory("  Ropa   de   yoga "), "Ropa de yoga");
  assert.equal(cleanCategory(null), "");
  const known = ["Accesorios", "Ropa", "Meditación"];
  assert.equal(canonicalCategory("ropa", known), "Ropa");
  assert.equal(canonicalCategory("  ROPA ", known), "Ropa");
  assert.equal(canonicalCategory("meditacion", known), "Meditación");
  assert.equal(canonicalCategory("Libros", known), "Libros", "una nueva se queda como está escrita");
  assert.equal(canonicalCategory("", known), "");
  assert.equal(canonicalCategory("ropa", []), "ropa");
});

Deno.test("categorías conocidas: sin repetidas, la grafía más usada, ordenadas y sin las que son solo números", () => {
  const items = [
    { category: "ropa" },
    { category: "Ropa" },
    { category: "Ropa" },
    { category: "Accesorios" },
    { category: "accesorios " },
    { category: "meditación" },
    { category: "2" },
    { category: "3333" },
    { category: null },
    { category: "" },
    {},
    null,
  ];
  assert.deepEqual(knownCategories(items), ["Accesorios", "meditación", "Ropa"]);
  assert.deepEqual(knownCategories([]), []);
  assert.deepEqual(knownCategories(undefined), []);
});

Deno.test("orden: vacío = 0; solo enteros; lo demás da un mensaje claro", () => {
  assert.deepEqual(parseSortOrder(""), { value: 0 });
  assert.deepEqual(parseSortOrder("   "), { value: 0 });
  assert.deepEqual(parseSortOrder(null), { value: 0 });
  assert.deepEqual(parseSortOrder("3"), { value: 3 });
  assert.deepEqual(parseSortOrder(" -2 "), { value: -2 });
  assert.deepEqual(parseSortOrder("0"), { value: 0 });
  for (const bad of ["1.5", "1,5", "abc", "1e3", "--1", "+2", "99999999999", "2 3"]) {
    assert.match(parseSortOrder(bad).error, /entero/, JSON.stringify(bad));
  }
});

Deno.test("producto: Categoría y Orden se validan al guardar (errores claros, nada se guarda)", () => {
  assert.match(buildProductInput({ ...ok, category: "2" }).error, /no un número/);
  assert.match(buildProductInput({ ...ok, sort_order: "1,5" }).error, /entero/);
  // un producto antiguo con categoría numérica se puede seguir editando mientras no la toquen
  assert.equal(buildProductInput({ ...ok, category: "3333" }, { previousCategory: "3333" }).value.category, "3333");
});

Deno.test("producto: 'ropa' se guarda como 'Ropa' si esa categoría ya existe, y una nueva queda tal cual", () => {
  const opts = { knownCategories: ["Ropa", "Accesorios"] };
  assert.equal(buildProductInput({ ...ok, category: "ropa" }, opts).value.category, "Ropa");
  assert.equal(buildProductInput({ ...ok, category: " accesorios  " }, opts).value.category, "Accesorios");
  assert.equal(buildProductInput({ ...ok, category: "Libros" }, opts).value.category, "Libros");
  assert.equal(buildProductInput({ ...ok, category: "" }, opts).value.category, null);
  assert.equal(buildProductInput({ ...ok, category: "  Ropa   yoga " }).value.category, "Ropa yoga");
  assert.equal(buildProductInput({ ...ok, sort_order: "7" }).value.sort_order, 7);
});

Deno.test("pistas: explican Categoría y Orden sin ambigüedad", () => {
  assert.match(SORT_HINT, /menor aparece primero/);
  assert.match(SORT_HINT, /entero/);
});
