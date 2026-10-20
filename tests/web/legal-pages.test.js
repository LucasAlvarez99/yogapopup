import assert from "node:assert/strict";

/**
 * Páginas legales: aviso legal y condiciones de compra (además de la política de privacidad, que tiene su propio test).
 * Fallan si alguien borra una sección obligatoria, escribe a mano los datos del titular (deben salir de js/config.js),
 * deja texto provisional o quita los enlaces desde los pies de página y desde las pantallas de pago.
 */
const ROOT = new URL("../../", import.meta.url);
const read = (rel) => Deno.readTextFileSync(new URL(rel, ROOT));
const LEGAL_KEYS = ["NAME", "TAX_ID", "ADDRESS", "EMAIL"];

const PAGES = {
  "aviso-legal.html": {
    sections: {
      titular: "identidad del prestador (art. 10 LSSI)",
      objeto: "objeto",
      uso: "condiciones de uso",
      propiedad: "propiedad intelectual",
      salud: "aviso de salud",
      responsabilidad: "responsabilidad",
      datos: "protección de datos",
      legislacion: "legislación y jurisdicción",
    },
    keys: LEGAL_KEYS,
  },
  "condiciones.html": {
    sections: {
      titular: "quién vende",
      productos: "qué se vende",
      precios: "precios con IVA",
      proceso: "cuándo se completa el pedido",
      pago: "pago con PayPal",
      digital: "contenido digital y pérdida del desistimiento",
      suscripciones: "renovación y cancelación",
      envios: "envíos",
      desistimiento: "desistimiento de 14 días",
      devoluciones: "devoluciones",
      reembolsos: "reembolsos",
      garantia: "garantía legal",
      reclamaciones: "reclamaciones",
    },
    keys: LEGAL_KEYS,
  },
};

for (const [page, spec] of Object.entries(PAGES)) {
  Deno.test(`${page}: tiene todas las secciones obligatorias, los datos del titular salen de la configuración y no hay texto provisional`, () => {
    const html = read(page);
    for (const [id, what] of Object.entries(spec.sections)) {
      assert.match(html, new RegExp(`<h2 id="${id}">`), `falta la sección: ${what}`);
    }
    for (const key of spec.keys) {
      assert.match(html, new RegExp(`data-legal="${key}"`), `falta el dato del titular ${key}`);
    }
    assert.match(html, /<main[^>]*translate="no"/, "el texto legal no se traduce solo");
    assert.match(html, /js\/pages\/privacidad\.js/, "sin este script los datos del titular quedan vacíos");
    assert.doesNotMatch(html, /\[COMPLETAR|lorem|Tramitando/i, "no puede quedar texto provisional");
    assert.doesNotMatch(html, /\bTODO\b/, "no puede quedar una marca TODO");
    for (const v of ["B12345678", "hola@yogapopup.es", "Manuelaperuzzotti"]) {
      assert.ok(!html.includes(v), `los datos del titular no se escriben en el HTML (${v})`);
    }
    assert.match(html, /privacidad\.html/, "enlaza la política de privacidad");
  });
}

Deno.test("condiciones.html: dice lo que exige la normativa y lo que hace el sitio", () => {
  const html = read("condiciones.html");
  assert.match(html, /14 días naturales/, "plazo de desistimiento");
  assert.match(html, /pierdes el derecho de desistimiento/, "pérdida del desistimiento en contenido digital");
  assert.match(html, /30 días/, "los videos sueltos dan acceso 30 días");
  assert.match(html, /PayPal/);
  assert.match(html, /IVA/);
  assert.match(html, /desde <a href="cuenta\.html">Mi cuenta<\/a>/, "cómo cancelar la suscripción");
  assert.doesNotMatch(
    html,
    /ec\.europa\.eu\/consumers\/odr/,
    "la plataforma europea de resolución de litigios en línea ya no existe",
  );
});

Deno.test("los pies de página enlazan las tres páginas legales (home estática y pie generado por JS)", () => {
  const home = read("index.html");
  const layout = read("js/ui/layout.js");
  for (const page of ["privacidad.html", "aviso-legal.html", "condiciones.html"]) {
    assert.ok(home.includes(`href="${page}"`), `index.html no enlaza ${page}`);
    assert.ok(layout.includes(page), `js/ui/layout.js no enlaza ${page}`);
  }
});

Deno.test("las pantallas de pago muestran el aviso de condiciones y desistimiento", () => {
  const notice = read("js/ui/legal-notice.js");
  assert.match(notice, /condiciones\.html/);
  assert.match(notice, /rel: 'noopener'/, "el enlace abre otra pestaña sin perder el pago en curso");
  assert.match(notice, /derecho de desistimiento/);
  for (const f of ["js/ui/checkout-view.js", "js/ui/subscribe-box.js", "js/ui/pay-class.js"]) {
    assert.match(read(f), /purchaseNotice\(/, `${f} no muestra el aviso junto al pago`);
  }
});
