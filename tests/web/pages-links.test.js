import assert from "node:assert/strict";

/**
 * Guarda de las páginas: los .html viven en la RAÍZ del repo, exactamente como se publican
 * (GitHub Pages, Hostinger) y como los sirve `npm run dev` o Live Server. Por eso, dentro de un .html:
 *   - un enlace a otra página es `videoteca.html` (relativo, sin `/` inicial: así también funciona
 *     en GitHub Pages, donde el sitio vive bajo /nombre-del-repo/);
 *   - un recurso es `css/app.css`, `js/...`, `assets/...`;
 *   - un ancla `#x` debe existir como id en la misma página.
 * Los `href="#"` (marcadores de páginas que todavía no existen) no se validan a propósito.
 */
const ROOT = new URL("../../", import.meta.url);
const pageFiles = [...Deno.readDirSync(ROOT)].filter((e) => e.isFile && e.name.endsWith(".html")).map((e) => e.name)
  .sort();
const exists = (rel) => {
  try {
    return Deno.statSync(new URL(rel, ROOT)).isFile;
  } catch {
    return false;
  }
};

Deno.test("raíz: hay páginas que revisar y está la home", () => {
  assert.ok(pageFiles.length >= 7, `se esperaban al menos 7 páginas, hay ${pageFiles.length}`);
  assert.ok(pageFiles.includes("index.html"), "falta index.html");
});

Deno.test("raíz: no queda una carpeta pages/ con páginas duplicadas", () => {
  assert.equal(exists("pages/index.html"), false, "pages/ ya no debe existir: las páginas viven en la raíz");
});

for (const name of pageFiles) {
  Deno.test(`${name}: recursos y enlaces internos existen`, () => {
    const html = Deno.readTextFileSync(new URL(name, ROOT));
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const broken = [];
    for (const [, ref] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      if (/^(https?:|\/\/|mailto:|tel:|data:|javascript:)/.test(ref) || ref === "#") continue;
      if (ref.startsWith("#")) {
        if (!ids.has(ref.slice(1))) broken.push(`ancla ${ref} sin destino en la página`);
        continue;
      }
      if (ref.startsWith("/")) {
        broken.push(`${ref} es una ruta absoluta: se rompe en GitHub Pages (usar ruta relativa, sin "/" inicial)`);
        continue;
      }
      if (!exists(ref.split("#")[0].split("?")[0])) broken.push(`${ref} no existe`);
    }
    assert.deepEqual(broken, [], `enlaces rotos en ${name}:\n${broken.join("\n")}`);
  });
}
