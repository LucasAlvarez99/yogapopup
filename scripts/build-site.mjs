#!/usr/bin/env node
/**
 * Arma dist/ con SOLO los archivos públicos del sitio. Esa carpeta es lo único que se publica
 * (GitHub Pages / Hostinger): por construcción no puede llevarse .env, supabase/, scripts/,
 * tests/ ni node_modules.
 *
 * El sitio ya vive tal cual se publica: los .html están en la RAÍZ del repo junto a css/, js/
 * y assets/, así que abrirlo con cualquier servidor estático (npm run dev, Live Server) muestra
 * exactamente lo mismo que el sitio publicado. Este script solo copia la lista blanca de abajo.
 *
 * Incluye: los *.html de la raíz, las carpetas css/, js/ y assets/, y el .htaccess.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const PUBLIC_DIRS = ["css", "js", "assets"];

const pages = readdirSync(root).filter((f) => f.endsWith(".html"));
if (!pages.includes("index.html")) throw new Error(`No hay index.html en ${root}: ¿se movieron las páginas de lugar?`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

const copied = [];
for (const f of pages) {
  cpSync(join(root, f), join(dist, f));
  copied.push(f);
}
for (const d of PUBLIC_DIRS) {
  if (!existsSync(join(root, d))) throw new Error(`Falta la carpeta pública ${d}/ en ${root}`);
  cpSync(join(root, d), join(dist, d), { recursive: true, filter: (src) => !/\.(map|example\.js)$/.test(src) });
  copied.push(`${d}/`);
}
// El .htaccess viaja con el sitio (Hostinger lo lee desde la raíz publicada; GitHub Pages lo ignora).
cpSync(join(root, ".htaccess"), join(dist, ".htaccess"));
copied.push(".htaccess");

console.log(`dist/ listo: ${copied.join(", ")}`);
console.log("Publicar el CONTENIDO de dist/, no la carpeta del proyecto.");
