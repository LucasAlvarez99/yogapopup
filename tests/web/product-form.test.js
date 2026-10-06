import assert from "node:assert/strict";
import {
  buildProductInput,
  centsToEurosInput,
  eurosToCents,
  MAX_PRICE_CENTS,
  parseStock,
  storagePathFromPublicUrl,
} from "../../js/lib/product-form.js";

Deno.test("eurosToCents: acepta coma o punto y con o sin decimales, siempre en enteros", () => {
  assert.equal(eurosToCents("19,99"), 1999);
  assert.equal(eurosToCents("19.99"), 1999);
  assert.equal(eurosToCents("19"), 1900);
  assert.equal(eurosToCents("19,9"), 1990); // un solo decimal = décimas, no céntimos
  assert.equal(eurosToCents("0,05"), 5);
  assert.equal(eurosToCents("0"), 0);
  assert.equal(eurosToCents(" 34,99 € "), 3499);
  assert.equal(eurosToCents("34,99 EUR"), 3499);
});

Deno.test("eurosToCents: sin errores de coma flotante (0,29 * 100 = 28.999… en JS)", () => {
  assert.equal(eurosToCents("0,29"), 29);
  assert.equal(eurosToCents("1,15"), 115);
  assert.equal(eurosToCents("4,35"), 435);
  assert.equal(eurosToCents("8,20"), 820);
});

Deno.test("eurosToCents: rechaza lo ambiguo, negativo, vacío o fuera de rango", () => {
  for (
    const bad of [
      "",
      "  ",
      "abc",
      "-5",
      "1.999",
      "1.999,50",
      "1,999",
      "19,999",
      "19,",
      ",99",
      "1e3",
      "1 000",
      null,
      undefined,
    ]
  ) {
    assert.equal(eurosToCents(bad), null, `debería rechazar ${JSON.stringify(bad)}`);
  }
  assert.equal(eurosToCents("1000000"), null); // 7 cifras de euros: fuera del formato admitido
  assert.equal(eurosToCents("999999,99"), MAX_PRICE_CENTS);
});

Deno.test("centsToEurosInput: ida y vuelta con eurosToCents", () => {
  assert.equal(centsToEurosInput(1999), "19,99");
  assert.equal(centsToEurosInput(1900), "19");
  assert.equal(centsToEurosInput(5), "0,05");
  assert.equal(centsToEurosInput(0), "0");
  assert.equal(centsToEurosInput(null), "");
  assert.equal(centsToEurosInput(-1), "");
  assert.equal(centsToEurosInput(12.5), "");
  for (const cents of [0, 1, 9, 10, 99, 100, 1999, 123456, MAX_PRICE_CENTS]) {
    assert.equal(eurosToCents(centsToEurosInput(cents)), cents);
  }
});

Deno.test("parseStock: vacío = sin control de stock (null); inválido = undefined", () => {
  assert.equal(parseStock(""), null);
  assert.equal(parseStock("  "), null);
  assert.equal(parseStock(undefined), null);
  assert.equal(parseStock("0"), 0); // 0 es AGOTADO, no "sin control": no se confunden
  assert.equal(parseStock("12"), 12);
  for (const bad of ["-1", "2,5", "2.5", "abc", "1e3", "99999999"]) {
    assert.equal(parseStock(bad), undefined, `debería rechazar ${JSON.stringify(bad)}`);
  }
});

Deno.test("buildProductInput: arma el producto normalizado", () => {
  const r = buildProductInput({
    title: "  Mat de yoga  ",
    description: "  Antideslizante  ",
    category: " Mats ",
    price: "29,99",
    stock: "8",
    sort_order: "3",
    is_active: true,
  });
  assert.deepEqual(r.value, {
    title: "Mat de yoga",
    description: "Antideslizante",
    category: "Mats",
    price_cents: 2999,
    stock: 8,
    sort_order: 3,
    is_active: true,
    tax_rate_bps: 2100, // sin elegir, el IVA general
  });
  assert.deepEqual(r.sizes, [], "sin talles");
});

Deno.test("buildProductInput: opcionales vacíos van como null / 0 y el producto nace inactivo por defecto", () => {
  const r = buildProductInput({
    title: "Bloque",
    description: "",
    category: "",
    price: "14,99",
    stock: "",
    sort_order: "",
  });
  assert.deepEqual(r.value, {
    title: "Bloque",
    description: null,
    category: null,
    price_cents: 1499,
    stock: null,
    sort_order: 0,
    is_active: false,
    tax_rate_bps: 2100,
  });
});

Deno.test("buildProductInput: cada error tiene un mensaje claro y no se guarda nada", () => {
  const ok = { title: "X", price: "1", stock: "", sort_order: "" };
  assert.match(buildProductInput({ ...ok, title: "   " }).error, /título es obligatorio/);
  assert.match(buildProductInput({ ...ok, title: "x".repeat(151) }).error, /150/);
  assert.match(buildProductInput({ ...ok, description: "x".repeat(5001) }).error, /5000/);
  assert.match(buildProductInput({ ...ok, category: "x".repeat(61) }).error, /60/);
  assert.match(buildProductInput({ ...ok, price: "" }).error, /precio válido/);
  assert.match(buildProductInput({ ...ok, price: "-3" }).error, /precio válido/);
  assert.match(buildProductInput({ ...ok, stock: "-1" }).error, /stock/);
  assert.match(buildProductInput({ ...ok, sort_order: "1,5" }).error, /orden/);
  for (const bad of [{ title: "" }, { price: "abc" }, { stock: "x" }]) {
    assert.equal(buildProductInput({ ...ok, ...bad }).value, undefined);
  }
});

const BASE = "https://abc.supabase.co/storage/v1/object/public/product-images/";

Deno.test("storagePathFromPublicUrl: extrae la ruta solo de imágenes del bucket propio", () => {
  assert.equal(storagePathFromPublicUrl(`${BASE}p1/a.webp`, "product-images"), "p1/a.webp");
  assert.equal(storagePathFromPublicUrl(`${BASE}p1/a%20b.webp?t=1`, "product-images"), "p1/a b.webp");
});

Deno.test("storagePathFromPublicUrl: nunca devuelve algo ajeno o con salida de carpeta", () => {
  const bad = [
    "https://abc.supabase.co/storage/v1/object/public/class-thumbnails/p1/a.webp", // otro bucket
    "https://cdn.ejemplo.com/foto.jpg", // imagen externa
    `${BASE}../class-thumbnails/x.webp`,
    `${BASE}p1/../../x.webp`,
    `${BASE}%2e%2e/x.webp`,
    `${BASE}/abs.webp`,
    `${BASE}p1//a.webp`,
    `${BASE}`,
    `${BASE}%E0%A4%A`, // porcentaje mal formado
    "",
    null,
    undefined,
  ];
  for (const url of bad) {
    assert.equal(storagePathFromPublicUrl(url, "product-images"), null, `debería rechazar ${JSON.stringify(url)}`);
  }
});

Deno.test("buildProductInput: IVA incluido — por defecto 21 %, acepta los tipos válidos y rechaza lo demás", () => {
  const base = { title: "Mat", price: "10", stock: "", sort_order: "" };
  assert.equal(buildProductInput(base).value.tax_rate_bps, 2100);
  assert.equal(buildProductInput({ ...base, tax_rate_bps: "" }).value.tax_rate_bps, 2100);
  for (const [text, bps] of [["2100", 2100], ["1000", 1000], ["400", 400], ["0", 0], [" 0 ", 0], [1000, 1000]]) {
    assert.equal(buildProductInput({ ...base, tax_rate_bps: text }).value.tax_rate_bps, bps, String(text));
  }
  for (const bad of ["2501", "-1", "21%", "10,5", "abc", "99999", "1e3"]) {
    assert.match(buildProductInput({ ...base, tax_rate_bps: bad }).error, /IVA/, bad);
  }
});

Deno.test("buildProductInput: con talles el stock del producto se descarta y se devuelven los talles ya validados", () => {
  const base = { title: "Remera", price: "35", stock: "8", sort_order: "" };
  const r = buildProductInput({ ...base, sizes: [{ size: " S ", stock: "3" }, { size: "M", stock: "" }] });
  assert.equal(r.value.stock, null, "el stock del producto se ignora cuando hay talles");
  assert.deepEqual(r.sizes, [{ size: "S", stock: 3 }, { size: "M", stock: null }]);
  assert.equal(buildProductInput({ ...base, sizes: [] }).value.stock, 8, "sin talles, el stock del producto manda");
  assert.match(
    buildProductInput({ ...base, sizes: [{ size: "S" }, { size: "s" }] }).error,
    /repetido/,
    "un talle inválido impide guardar",
  );
  assert.match(buildProductInput({ ...base, sizes: [{ size: "S", stock: "-1" }] }).error, /entero/);
});
