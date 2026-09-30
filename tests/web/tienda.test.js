import assert from "node:assert/strict";
import { formatPrice, stockInfo } from "../../js/lib/format.js";
import { categoriesOf, filterProducts } from "../../js/lib/catalog.js";

// Intl formatea el espacio antes del € con un espacio no separable: se normaliza para comparar.
const plain = (s) => s.replace(/\s/g, " ");

Deno.test("formatPrice: céntimos de euro a texto en español", () => {
  assert.equal(plain(formatPrice(3499)), "34,99 €");
  assert.equal(plain(formatPrice(0)), "0,00 €");
  assert.equal(plain(formatPrice(1999)), "19,99 €");
  assert.equal(plain(formatPrice("699")), "6,99 €");
  assert.equal(plain(formatPrice(123456)), "1234,56 €"); // es-ES no agrupa miles en 4 cifras
});

Deno.test("formatPrice: no inventa precios con datos inválidos", () => {
  assert.equal(formatPrice(null), ""); // un precio ausente no es "0,00 €"
  assert.equal(formatPrice(""), "");
  assert.equal(formatPrice(-1), "");
  assert.equal(formatPrice(NaN), "");
  assert.equal(formatPrice(undefined), "");
  assert.equal(formatPrice("abc"), "");
});

Deno.test("stockInfo: null = sin control de stock; 0 = agotado; pocas = aviso", () => {
  assert.deepEqual(stockInfo(null), { available: true, label: "" });
  assert.deepEqual(stockInfo(undefined), { available: true, label: "" });
  assert.deepEqual(stockInfo(0), { available: false, label: "Agotado" });
  assert.deepEqual(stockInfo(-3), { available: false, label: "Agotado" });
  assert.deepEqual(stockInfo(3), { available: true, label: "Últimas 3 unidades" });
  assert.deepEqual(stockInfo(5), { available: true, label: "Últimas 5 unidades" });
  assert.deepEqual(stockInfo(6), { available: true, label: "" });
});

const PRODUCTS = [
  { title: "Mat de yoga Premium", description: "Antideslizante", category: "Mats" },
  { title: "Botella térmica", description: null, category: "Accesorios" },
  { title: "Remera Pop Up", description: "Algodón orgánico", category: "Ropa" },
  { title: "Guía de bienestar", description: "PDF descargable", category: null },
];

Deno.test("filterProducts: por texto, sin distinguir mayúsculas ni acentos", () => {
  assert.deepEqual(filterProducts(PRODUCTS, { q: "termica" }).map((p) => p.title), ["Botella térmica"]);
  assert.deepEqual(filterProducts(PRODUCTS, { q: "ALGODON" }).map((p) => p.title), ["Remera Pop Up"]);
  assert.equal(filterProducts(PRODUCTS, { q: "  " }).length, 4);
  assert.equal(filterProducts(PRODUCTS, { q: "zzz" }).length, 0);
});

Deno.test("filterProducts: por categoría y combinado; una descripción nula no rompe la búsqueda", () => {
  assert.deepEqual(filterProducts(PRODUCTS, { category: "Ropa" }).map((p) => p.title), ["Remera Pop Up"]);
  assert.equal(filterProducts(PRODUCTS, { category: "Ropa", q: "mat" }).length, 0);
  assert.equal(filterProducts(PRODUCTS, { q: "null" }).length, 0); // "null" no debe matchear la descripción vacía
  assert.equal(filterProducts(PRODUCTS).length, 4);
});

Deno.test("categoriesOf: únicas, ordenadas y sin vacías", () => {
  assert.deepEqual(categoriesOf(PRODUCTS), ["Accesorios", "Mats", "Ropa"]);
  assert.deepEqual(categoriesOf([]), []);
});
