import assert from "node:assert/strict";

/**
 * Revisiones estáticas de seguridad sobre TODO el repositorio (no sobre una función): fallan si alguien pega un secreto
 * por descuido, sube un .env o abre un enlace externo sin `rel="noopener"`.
 */
const ROOT = new URL("../../", import.meta.url);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-e2e", "vendor", ".temp"]);
const SKIP_FILES = new Set(["package-lock.json", "deno.lock"]);
const TEXT = /\.(js|mjs|ts|html|css|json|md|sql|sh|toml|txt|example|htaccess)$|^\.env\.example$|^\.htaccess$/;

function* walk(dir = "") {
  for (const e of Deno.readDirSync(new URL(dir, ROOT))) {
    if (e.isDirectory) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(`${dir}${e.name}/`);
    } else if (!SKIP_FILES.has(e.name)) yield `${dir}${e.name}`;
  }
}
const files = [...walk()];
const textFiles = files.filter((f) => TEXT.test(f.split("/").pop()));
const read = (f) => Deno.readTextFileSync(new URL(f, ROOT));
const isTest = (f) => f.startsWith("tests/") || /\.test\.(ts|js|sql)$/.test(f);

// Un supabase/.env LOCAL es normal (ahí viven tus secretos): lo importante es que git lo ignore.
Deno.test("seguridad: .gitignore protege supabase/.env y .env", () => {
  const ignore = read(".gitignore");
  assert.match(ignore, /^supabase\/\.env$/m);
  assert.match(ignore, /^\.env$/m);
});

const SECRET_PATTERNS = [
  ["clave privada", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Access Key de AWS/R2 (AKIA…)", /\bAKIA[0-9A-Z]{16}\b/],
  [
    "clave secreta de Stripe/Supabase (sk_live / sb_secret_)",
    /\b(sk_live_[A-Za-z0-9]{10,}|sb_secret_[A-Za-z0-9_-]{10,})/,
  ],
  ["secreto de R2 con valor", /R2_SECRET_ACCESS_KEY\s*=\s*[A-Za-z0-9/+]{20,}/],
  ["secreto de PayPal con valor", /PAYPAL_CLIENT_SECRET\s*=\s*[A-Za-z0-9_-]{20,}/],
  ["token de GitHub", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
];

Deno.test("seguridad: ningún archivo del proyecto contiene una credencial real", () => {
  const hits = [];
  for (const f of textFiles.filter((x) => !isTest(x))) {
    const body = read(f);
    for (const [name, re] of SECRET_PATTERNS) if (re.test(body)) hits.push(`${f}: ${name}`);
  }
  assert.deepEqual(hits, []);
});

Deno.test("seguridad: todo JWT incrustado en el código es de rol 'anon' (la única clave pública permitida)", () => {
  const jwt = /eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g;
  const bad = [];
  for (const f of textFiles.filter((x) => !isTest(x))) {
    for (const m of read(f).matchAll(jwt)) {
      let role = "?";
      try {
        role = JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/"))).role;
      } catch { /* no era un JWT */ }
      if (role !== "anon") bad.push(`${f}: JWT con rol ${role}`);
    }
  }
  assert.deepEqual(bad, [], "un JWT que no es 'anon' (p. ej. service_role) NUNCA va en el repo");
});

Deno.test("seguridad: todo enlace que abre otra pestaña lleva rel=noopener", () => {
  const bad = [];
  for (const f of textFiles.filter((x) => /\.(html|js)$/.test(x) && !isTest(x))) {
    const body = read(f);
    for (const m of body.matchAll(/<a\b[^>]*target=["']_blank["'][^>]*>/g)) {
      if (!/rel=["'][^"']*noopener/.test(m[0])) bad.push(`${f}: ${m[0].slice(0, 80)}`);
    }
    for (const m of body.matchAll(/\{[^{}]*target:\s*['"]_blank['"][^{}]*\}/g)) {
      if (!/rel:\s*['"][^'"]*noopener/.test(m[0])) bad.push(`${f}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(bad, []);
});

Deno.test("seguridad: las funciones Edge no leen secretos de la URL ni los devuelven en las respuestas", () => {
  const bad = [];
  for (const f of textFiles.filter((x) => x.startsWith("supabase/functions/") && x.endsWith(".ts") && !isTest(x))) {
    const body = read(f);
    if (/searchParams\.get\(["'](secret|client_secret|token|key)["']\)/.test(body)) {
      bad.push(`${f}: secreto por query string`);
    }
    if (/json\([^)]*(CLIENT_SECRET|clientSecret|secretAccessKey|SERVICE_ROLE)/.test(body)) {
      bad.push(`${f}: devuelve un secreto`);
    }
  }
  assert.deepEqual(bad, []);
});
