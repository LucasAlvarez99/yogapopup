import assert from "node:assert/strict";
import {
  buildCsp,
  htaccessSecurityBlock,
  injectMetaCsp,
  originOf,
  R2_HOSTS,
  readFrontendConfig,
} from "../../scripts/lib/security-headers.mjs";
import { el } from "../../js/lib/dom.js";

const ROOT = new URL("../../", import.meta.url);
const read = (rel) => Deno.readTextFileSync(new URL(rel, ROOT));
const pages = [...Deno.readDirSync(ROOT)].filter((e) => e.isFile && e.name.endsWith(".html")).map((e) => e.name);

function* jsFiles(dir) {
  for (const e of Deno.readDirSync(new URL(dir, ROOT))) {
    if (e.name === "vendor") continue;
    if (e.isDirectory) yield* jsFiles(`${dir}${e.name}/`);
    else if (e.name.endsWith(".js")) yield `${dir}${e.name}`;
  }
}

const CFG = { supabaseUrl: "https://abc.supabase.co", functionsUrl: "https://abc.supabase.co/functions/v1" };

// ------------------------------------------------------------------ el sitio es compatible con una CSP estricta
Deno.test("CSP: ninguna página tiene scripts inline, manejadores on*=, style= ni recursos de código externos", () => {
  assert.ok(pages.length >= 7, "se encontraron las páginas");
  for (const p of pages) {
    const html = read(p);
    for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
      assert.match(m[1], /\bsrc=/i, `${p}: <script> inline`);
      assert.doesNotMatch(m[1], /\bsrc=["']?(https?:)?\/\//i, `${p}: script externo`);
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${p}: manejador de evento inline (onclick=…)`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${p}: atributo style inline`);
    assert.doesNotMatch(html, /<style\b/i, `${p}: <style> inline`);
    assert.doesNotMatch(html, /javascript:/i, `${p}: URL javascript:`);
    assert.doesNotMatch(html, /<link[^>]+rel=["']stylesheet["'][^>]+href=["']https?:/i, `${p}: CSS externo`);
    assert.doesNotMatch(html, /<iframe|<object|<embed/i, `${p}: contenido incrustado`);
  }
});

Deno.test("CSP: el JS propio no usa nada que una CSP estricta (o el XSS) rompa", () => {
  let n = 0;
  for (const f of jsFiles("js/")) {
    n++;
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // sin comentarios
    assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=/, `${f}: innerHTML`);
    assert.doesNotMatch(src, /insertAdjacentHTML|document\.write/, `${f}: HTML dinámico`);
    assert.doesNotMatch(src, /\beval\s*\(|new Function\s*\(/, `${f}: eval`);
    assert.doesNotMatch(src, /setTimeout\(\s*['"`]|setInterval\(\s*['"`]/, `${f}: temporizador con texto`);
    assert.doesNotMatch(src, /setAttribute\(\s*['"]style['"]/, `${f}: style por setAttribute (la CSP lo bloquea)`);
    assert.doesNotMatch(src, /createElement\(\s*['"]style['"]/, `${f}: <style> dinámico`);
    assert.doesNotMatch(src, /createElement\(\s*['"]script['"]/, `${f}: script dinámico`);
  }
  assert.ok(n > 20, `se revisaron ${n} archivos`);
});

Deno.test("dom.el: 'style' se aplica por la API de estilos (permitida por la CSP), no con setAttribute", () => {
  class FakeNode {
    constructor(tag) {
      this.tag = tag;
      this.attrs = {};
      this.style = { cssText: "" };
      this.dataset = {};
    }
    setAttribute(k, v) {
      this.attrs[k] = v;
    }
    addEventListener() {}
    append() {}
  }
  globalThis.Node = FakeNode;
  globalThis.document = { createElement: (t) => new FakeNode(t), createTextNode: (t) => t };
  const node = el("span", { class: "tag", style: "position:static", id: "x" }, "hola");
  assert.equal(node.style.cssText, "position:static");
  assert.equal(node.attrs.style, undefined, "no debe pasar por setAttribute");
  assert.equal(node.attrs.id, "x");
  assert.equal(node.className, "tag");
});

// ------------------------------------------------------------------ la CSP generada
Deno.test("buildCsp: política estricta, con solo los hosts que el sitio necesita", () => {
  const csp = buildCsp(CFG);
  const d = Object.fromEntries(csp.split("; ").map((x) => [x.split(" ")[0], x.split(" ").slice(1)]));
  assert.deepEqual(d["default-src"], ["'self'"]);
  assert.deepEqual(d["script-src"], ["'self'"]);
  assert.deepEqual(d["style-src"], ["'self'"]);
  assert.deepEqual(d["object-src"], ["'none'"]);
  assert.deepEqual(d["frame-src"], ["'none'"]);
  assert.deepEqual(d["frame-ancestors"], ["'none'"]);
  assert.deepEqual(d["base-uri"], ["'self'"]);
  assert.deepEqual(d["form-action"], ["'self'"]);
  assert.ok(d["connect-src"].includes("https://abc.supabase.co"));
  assert.ok(d["connect-src"].includes(R2_HOSTS[0]), "la subida del video va directo a R2");
  assert.ok(d["media-src"].includes(R2_HOSTS[0]), "la reproducción viene firmada desde R2");
  assert.ok(d["img-src"].includes("https://abc.supabase.co"), "miniaturas e imágenes de producto");
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*(?!\.r2)|http:/, "nada de comodines salvo R2");
});

Deno.test("buildCsp: una URL inválida o no segura no abre ningún host", () => {
  for (const bad of ["", "no-es-url", "javascript:alert(1)", "http://sitio-ajeno.com", "ftp://x.com"]) {
    const csp = buildCsp({ supabaseUrl: bad, functionsUrl: bad });
    assert.doesNotMatch(csp, /sitio-ajeno|javascript|ftp:/, bad);
    assert.match(csp, /connect-src 'self' https:\/\/\*\.r2\.cloudflarestorage\.com/);
  }
  assert.equal(originOf("http://localhost:54321/functions/v1"), "http://localhost:54321");
  assert.equal(originOf("http://127.0.0.1:54321"), "http://127.0.0.1:54321");
  assert.equal(originOf("http://localhost.evil.com"), null);
});

Deno.test("buildCsp: la versión <meta> omite frame-ancestors (los navegadores lo ignoran ahí)", () => {
  assert.match(buildCsp(CFG), /frame-ancestors 'none'/);
  assert.doesNotMatch(buildCsp(CFG, { forMeta: true }), /frame-ancestors/);
});

Deno.test("injectMetaCsp: inserta la CSP una sola vez, justo tras <meta charset>", () => {
  const html = `<!doctype html><html><head>\n  <meta charset="utf-8">\n  <title>x</title></head><body></body></html>`;
  const once = injectMetaCsp(html, CFG);
  assert.equal(once.match(/Content-Security-Policy/g).length, 1);
  assert.ok(once.indexOf("Content-Security-Policy") < once.indexOf("<title>"));
  assert.equal(injectMetaCsp(once, CFG), once, "idempotente");
  assert.throws(() => injectMetaCsp("<html><head></head></html>", CFG), /charset/);
});

Deno.test("injectMetaCsp: funciona con TODAS las páginas reales", () => {
  for (const p of pages) assert.match(injectMetaCsp(read(p), CFG), /http-equiv="Content-Security-Policy"/, p);
});

Deno.test("htaccessSecurityBlock: trae CSP, nosniff, anti-iframe, referrer y HSTS", () => {
  const b = htaccessSecurityBlock(CFG);
  for (
    const h of [
      "Content-Security-Policy",
      'X-Content-Type-Options "nosniff"',
      'X-Frame-Options "DENY"',
      "Referrer-Policy",
      "Permissions-Policy",
      "Strict-Transport-Security",
    ]
  ) assert.ok(b.includes(h), h);
  assert.match(b, /<IfModule mod_headers\.c>[\s\S]*<\/IfModule>/);
  assert.ok(!/"[^"]*"[^"\n]*"[^"\n]*Content-Security/.test(b), "las comillas de la CSP no rompen la directiva");
});

Deno.test("readFrontendConfig: lee el config.js real del repo", () => {
  const cfg = readFrontendConfig(read("js/config.js"));
  assert.ok(originOf(cfg.supabaseUrl), "SUPABASE_URL válida en js/config.js");
  assert.ok(cfg.functionsUrl.startsWith(cfg.supabaseUrl));
  assert.deepEqual(readFrontendConfig(""), { supabaseUrl: "", functionsUrl: "" });
});
