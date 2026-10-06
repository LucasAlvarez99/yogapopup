import assert from "node:assert/strict";
import { DEFAULT_LANG, isLang, LANGS, norm, pickInitialLang, translateWith } from "../../js/lib/i18n.js";
import en from "../../js/i18n/en.js";

const ROOT = new URL("../../", import.meta.url);
const read = (rel) => Deno.readTextFileSync(new URL(rel, ROOT));

// ------------------------------------------------------------------ motor (lógica pura)
Deno.test("i18n: traduce por texto exacto y conserva los espacios de los extremos", () => {
  const d = { exact: { "Inicio": "Home" } };
  assert.equal(translateWith("Inicio", d), "Home");
  assert.equal(translateWith("\n   Inicio  \n", d), "\n   Home  \n");
  assert.equal(translateWith(" Inicio\u00a0", d), " Home\u00a0");
  assert.equal(translateWith("Otra cosa", d), null);
  assert.equal(translateWith("   ", d), null);
});

Deno.test("i18n: los textos con datos se traducen por patrón y el resto del texto se conserva", () => {
  const d = { exact: {}, patterns: [[/^Talle: (.+)$/, "Size: $1"]] };
  assert.equal(translateWith("Talle: M", d), "Size: M");
  assert.equal(translateWith(" Talle: XL ", d), " Size: XL ");
  assert.equal(translateWith("Talle M", d), null, "el patrón está anclado");
});

Deno.test("i18n: una clave heredada de Object.prototype no se confunde con una traducción", () => {
  assert.equal(translateWith("constructor", { exact: {} }), null);
  assert.equal(translateWith("toString", { exact: {} }), null);
});

Deno.test("i18n: idioma inicial = ?lang válido > el guardado > español; valores raros se ignoran", () => {
  assert.equal(pickInitialLang("?lang=en", "es"), "en");
  assert.equal(pickInitialLang("", "en"), "en");
  assert.equal(pickInitialLang("", null), DEFAULT_LANG);
  assert.equal(pickInitialLang("?lang=xx", null), DEFAULT_LANG);
  assert.equal(pickInitialLang("?lang=__proto__", "constructor"), DEFAULT_LANG);
  assert.equal(isLang("en"), true);
  assert.equal(isLang("toString"), false);
});

Deno.test("i18n: cada idioma del selector se muestra en su propio idioma", () => {
  assert.equal(LANGS.es, "Español");
  assert.equal(LANGS.en, "English");
});

// ------------------------------------------------------------------ diccionario
Deno.test("diccionario en: claves normalizadas, valores no vacíos y patrones anclados", () => {
  for (const [k, v] of Object.entries(en.exact)) {
    assert.equal(k, norm(k), `la clave tiene espacios de más: «${k}»`);
    assert.ok(typeof v === "string" && v.trim() !== "", `traducción vacía para «${k}»`);
  }
  for (const [re, out] of en.patterns) {
    assert.ok(re.source.startsWith("^") && re.source.endsWith("$"), `patrón sin anclar: ${re}`);
    assert.equal(typeof out, "string");
  }
});

Deno.test("diccionario en: patrones de ejemplo", () => {
  const t = (s) => translateWith(s, en);
  assert.equal(t("8 semanas"), "8 weeks");
  assert.equal(t("Solo quedan 3 unidades"), "Only 3 left");
  assert.equal(t("Quitar Remera (talle M)"), "Remove Remera (size M)");
  assert.equal(t("Contraseña nueva (mínimo 8 caracteres)"), "New password (minimum 8 characters)");
  assert.equal(t("IVA incluido: 1,00 € · sin IVA: 8,00 €"), "VAT included: 1,00 € · excl. VAT: 8,00 €");
  assert.equal(t("Con Manu"), "With Manu");
});

Deno.test("diccionario en: un título escrito por el equipo no se traduce por accidente", () => {
  // Los títulos de clases y productos llevan translate="no" en el DOM; además ningún patrón debe tragarse
  // un texto corriente que empiece distinto de sus prefijos fijos.
  assert.equal(translateWith("Con los pies en la tierra", en), null);
  assert.equal(translateWith("Vinyasa de otoño", en), null);
});

// ------------------------------------------------------------------ cobertura de las páginas públicas
/** Textos que se muestran igual en inglés (nombres propios, marcas, precios, iniciales). */
const SAME = new Set([
  "Yoga Pop Up",
  "Subtotal",
  "WhatsApp",
  "Instagram (@yogapopup.life_)",
  "YouTube (@yogapopup)",
  "Hatha Yoga",
  "Vinyasa Flow",
  "Yoga Relax",
  "Manu",
  "María Sol",
  "Tomás R.",
  "Luli F.",
]);
const PAGES_NOT_TRANSLATED = new Set(["panel.html", "privacidad.html"]);

function visibleTexts(html) {
  const out = new Set();
  const clean = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "").replace(/<noscript>[\s\S]*?<\/noscript>/g, (m) => m); // noscript sí se muestra sin JS
  for (const [, t] of clean.matchAll(/>([^<>]+)</g)) {
    out.add(norm(t.replaceAll("&amp;", "&").replaceAll("&nbsp;", " ")));
  }
  for (const [, t] of clean.matchAll(/\b(?:placeholder|aria-label|title|alt)="([^"]*)"/g)) {
    out.add(norm(t.replaceAll("&amp;", "&")));
  }
  return [...out].filter((t) => /\p{L}{2,}/u.test(t));
}

const looksTranslatable = (t) =>
  !SAME.has(t) && !/^[\d.,:\s€%]+$/.test(t) && !/^[A-Z]{2}$/.test(t) && !/^\d+[.,]\d+\s*€$/.test(t);

for (const e of Deno.readDirSync(ROOT)) {
  if (!e.isFile || !e.name.endsWith(".html") || PAGES_NOT_TRANSLATED.has(e.name)) continue;
  Deno.test(`cobertura en: todos los textos fijos de ${e.name} tienen traducción`, () => {
    const missing = visibleTexts(read(e.name)).filter(looksTranslatable).filter((t) => translateWith(t, en) === null);
    assert.deepEqual(missing, [], `faltan en js/i18n/en.js:\n${missing.map((t) => `  '${t}'`).join("\n")}`);
  });
}

Deno.test("la política de privacidad y el panel quedan fuera de la traducción automática, a propósito", () => {
  assert.match(read("privacidad.html"), /<main[^>]*translate="no"/, 'el texto legal debe llevar translate="no"');
});

Deno.test("el selector de idioma está en la home y en el encabezado común", () => {
  assert.match(read("index.html"), /data-lang-slot/);
  assert.match(read("js/ui/layout.js"), /data-lang-slot/);
  assert.match(read("js/ui/boot.js"), /initLanguage\(\)/);
  assert.match(read("js/pages/home.js"), /initLanguage\(\)/);
});
