import assert from "node:assert/strict";

// env.js lee window.YOGAPOPUP_CONFIG al importarse: se fija ANTES de importar los módulos.
globalThis.window = globalThis;
globalThis.YOGAPOPUP_CONFIG = {
  SUPABASE_URL: "https://abcdwxyz.supabase.co",
  PRIVACY_URL: "privacidad.html",
  LEGAL: {
    NAME: "  Yoga Pop Up S.L.  ",
    TAX_ID: "B12345678",
    ADDRESS: "Calle Mayor 1, Madrid",
    EMAIL: "hola@yogapopup.es",
    EXTRA: "<img src=x>",
  },
};
const { consentMetadata, isEmail, LEGAL_FIELDS, PRIVACY_VERSION, privacyHref } = await import("../../js/lib/legal.js");
const { cfg } = await import("../../js/lib/env.js");

const read = (rel) => Deno.readTextFileSync(new URL(`../../${rel}`, import.meta.url));

// ------------------------------------------------------------------ aceptación
Deno.test("privacidad: solo viaja la versión cuando la casilla está marcada (la fecha la pone el servidor)", () => {
  assert.deepEqual(consentMetadata(true), { privacy_version: PRIVACY_VERSION });
  assert.deepEqual(consentMetadata(false), {});
  assert.deepEqual(consentMetadata(undefined), {});
  assert.deepEqual(consentMetadata(null), {});
  // Nunca se manda una fecha del navegador: no se podría confiar en ella.
  assert.equal("privacy_accepted_at" in consentMetadata(true), false);
});

Deno.test("privacidad: la versión es una fecha AAAA-MM-DD válida (la misma que acepta la base)", () => {
  assert.match(PRIVACY_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!Number.isNaN(Date.parse(`${PRIVACY_VERSION}T12:00:00`)));
});

// ------------------------------------------------------------------ enlace a la política
Deno.test("privacidad: el enlace de la casilla acepta https y rutas del sitio, y descarta todo lo demás", () => {
  assert.equal(privacyHref("https://yogapopup.es/privacidad"), "https://yogapopup.es/privacidad");
  assert.equal(privacyHref("http://localhost:3000/privacidad.html"), "http://localhost:3000/privacidad.html");
  assert.ok(
    privacyHref("privacidad.html").endsWith("/privacidad.html"),
    "una ruta relativa se resuelve contra el sitio",
  );
  for (
    const bad of [
      "",
      "   ",
      null,
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>1</script>",
      "http://sitio-ajeno.com/p",
      "//sitio-ajeno.com/p",
      "/etc/passwd",
      "../fuera.html",
      "a/../../b.html",
      "ftp://x.com",
      "vbscript:x",
      "privacidad.html onclick=alert(1)",
      "https://x.com/a b",
    ]
  ) assert.equal(privacyHref(bad), "", `debe descartar ${JSON.stringify(bad)}`);
  assert.ok(privacyHref().endsWith("/privacidad.html"), "por defecto usa PRIVACY_URL de la configuración");
});

// ------------------------------------------------------------------ datos del responsable
Deno.test("privacidad: LEGAL se lee limpio de la configuración y no deja pasar claves ajenas", () => {
  assert.deepEqual({ ...cfg.LEGAL }, {
    NAME: "Yoga Pop Up S.L.",
    TAX_ID: "B12345678",
    ADDRESS: "Calle Mayor 1, Madrid",
    EMAIL: "hola@yogapopup.es",
  });
  assert.equal(Object.isFrozen(cfg.LEGAL), true);
  assert.deepEqual(LEGAL_FIELDS.map(([k]) => k), ["NAME", "TAX_ID", "ADDRESS", "EMAIL"]);
});

Deno.test("privacidad: isEmail rechaza lo que podría colarse en un enlace mailto:", () => {
  for (const ok of ["hola@yogapopup.es", "a.b+c@sub.dominio.com"]) assert.equal(isEmail(ok), true, ok);
  for (
    const bad of ["", "sin-arroba", "a@b", "a b@c.com", 'a"@b.com', "<x@y.com>", "javascript:alert(1)", null, undefined]
  ) {
    assert.equal(isEmail(bad), false, String(bad));
  }
});

// ------------------------------------------------------------------ el texto de la política
Deno.test("privacidad.html: contiene todo lo que exige el art. 13 del RGPD (no se puede borrar una sección por accidente)", () => {
  const html = read("privacidad.html");
  const sections = {
    responsable: "identidad y contacto del responsable",
    datos: "qué datos se tratan",
    finalidades: "fines y base jurídica",
    destinatarios: "destinatarios",
    transferencias: "transferencias internacionales",
    conservacion: "plazo de conservación",
    derechos: "derechos y reclamación ante la AEPD",
    dispositivo: "cookies / almacenamiento en el dispositivo",
    menores: "menores",
    cambios: "cambios de la política",
  };
  for (const [id, what] of Object.entries(sections)) {
    assert.match(html, new RegExp(`<h2 id="${id}">`), `falta la sección: ${what}`);
  }
  assert.match(html, /aepd\.es/, "debe indicar cómo reclamar ante la AEPD");
  for (const right of ["acceso", "rectificación", "supresión", "oposición", "limitación", "portabilidad"]) {
    assert.match(html, new RegExp(right, "i"), `falta el derecho de ${right}`);
  }
  for (const [key] of LEGAL_FIELDS) {
    assert.match(html, new RegExp(`data-legal="${key}"`), `falta el dato del responsable ${key}`);
  }
  for (const provider of ["Supabase", "Cloudflare", "Hostinger"]) {
    assert.match(html, new RegExp(provider), `falta el proveedor ${provider}`);
  }
  assert.match(html, /data-privacy-version/);
  assert.doesNotMatch(html, /\[COMPLETAR|TODO|lorem/i, "no puede quedar texto provisional en el HTML");
});

Deno.test("privacidad.html: los datos del titular NO están escritos en el HTML (salen de js/config.js)", () => {
  const html = read("privacidad.html");
  for (const v of ["B12345678", "hola@yogapopup.es"]) assert.ok(!html.includes(v));
  const script = read("js/pages/privacidad.js");
  assert.doesNotMatch(script, /innerHTML/, "los datos se insertan como texto, nunca como HTML");
});

Deno.test("privacidad: el sitio enlaza la política desde el pie y la configuración trae el valor por defecto", () => {
  assert.match(read("js/ui/layout.js"), /privacidad\.html/);
  assert.match(read("js/config.js"), /PRIVACY_URL:\s*'privacidad\.html'/);
});

Deno.test("privacidad.html: cada función que guarda datos personales está declarada (comentarios, reservas, pagos, progreso…)", () => {
  const html = read("privacidad.html").toLowerCase();
  const declared = {
    "comentarios públicos con tu nombre": ["si dejas un comentario", "con tu nombre", "aprueb"],
    "reservas de clases en vivo": ["al reservar una clase en vivo"],
    "compras y envío": ["al comprar un producto", "dirección de envío"],
    "suscripciones": ["si te suscribes"],
    "progreso de las clases": ["punto de cada clase"],
    "carrito en el navegador": ["tu carrito"],
    "profesores": ["si das clases"],
  };
  for (const [feature, needles] of Object.entries(declared)) {
    for (const n of needles) assert.ok(html.includes(n), `la política no menciona: ${feature} («${n}»)`);
  }
  assert.match(html, /publicar los comentarios/, "los comentarios también deben figurar entre las finalidades");
});
