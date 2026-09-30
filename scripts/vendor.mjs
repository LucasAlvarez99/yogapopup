#!/usr/bin/env node
/**
 * Copia a js/vendor/ las librerías de navegador (versiones fijas de package.json), para servirlas
 * desde el propio sitio: sin depender de un CDN, sin SRI que mantener y compatible con una CSP estricta.
 * Ejecutar con `npm run vendor` cuando se actualice alguna versión, y commitear el resultado.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "js", "vendor");
mkdirSync(join(out, "licenses"), { recursive: true });

const cssOut = join(root, "css", "vendor");
mkdirSync(join(cssOut, "fonts"), { recursive: true });

const libs = [
  { pkg: "bootstrap", file: "dist/js/bootstrap.bundle.min.js", as: "bootstrap.bundle.min.js" },
  { pkg: "@supabase/supabase-js", file: "dist/umd/supabase.js", as: "supabase.js" },
];

const versions = {};

// --- CSS y fuentes de íconos (van en css/vendor/, con la carpeta fonts/ al lado del CSS) ---
const strip = (t) => t.replace(/\n?\/[/*]# sourceMappingURL=.*?(\*\/)?\s*$/, "\n");
for (const { pkg, file, as } of [
  { pkg: "bootstrap", file: "dist/css/bootstrap.min.css", as: "bootstrap.min.css" },
  { pkg: "bootstrap-icons", file: "font/bootstrap-icons.min.css", as: "bootstrap-icons.min.css" },
]) {
  writeFileSync(join(cssOut, as), strip(readFileSync(join(root, "node_modules", pkg, file), "utf8")));
}
for (const f of ["bootstrap-icons.woff2", "bootstrap-icons.woff"]) {
  copyFileSync(join(root, "node_modules", "bootstrap-icons", "font", "fonts", f), join(cssOut, "fonts", f));
}

for (const { pkg, file, as } of libs) {
  const base = join(root, "node_modules", pkg);
  const meta = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
  versions[pkg] = { version: meta.version, license: meta.license, file: as };
  // Se quita el comentario sourceMappingURL: no se publican los .map y generaría un 404 en la consola.
  const code = strip(readFileSync(join(base, file), "utf8"));
  writeFileSync(join(out, as), code);
  try {
    copyFileSync(join(base, "LICENSE"), join(out, "licenses", `${pkg.replace("/", "_")}.LICENSE`));
  } catch { /* algunos paquetes no traen LICENSE en la raíz */ }
}
writeFileSync(join(out, "VERSIONS.json"), JSON.stringify(versions, null, 2) + "\n");
console.log("js/vendor actualizado:", Object.entries(versions).map(([k, v]) => `${k}@${v.version}`).join(", "));
