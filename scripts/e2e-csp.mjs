/**
 * Corre la suite E2E contra el sitio CONSTRUIDO, con la misma Content-Security-Policy de producción.
 *
 *   npm run test:e2e:csp                    (toda la suite)
 *   npm run test:e2e:csp -- "reproductor"   (solo los tests cuyo nombre contenga ese texto)
 *
 * La política es idéntica a la real, salvo los dos hosts externos (Supabase y R2), que se cambian por los del backend
 * simulado de las pruebas (127.0.0.1). Si el sitio intenta cargar o ejecutar algo que la CSP prohíbe (un script o
 * estilo inline, un host no permitido…), el navegador lo bloquea, aparece como error de consola y el test falla.
 * Sirve de red de seguridad contra el cambio "inocente" que rompería el sitio en producción.
 *
 * Es un script de Node (no un one-liner de shell) para que funcione igual en Windows, macOS y Linux.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCsp, R2_HOSTS } from './lib/security-headers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-e2e');
// Puertos por defecto de startBackend() en tests/e2e/fake-backend.mjs: sitio 4173 · API 4174 · "R2" 4175.
const API = 'http://127.0.0.1:4174';
const CDN = 'http://127.0.0.1:4175';

const run = (args, env = {}) => spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

if (run([join(root, 'scripts', 'build-site.mjs')]).status !== 0) process.exit(1);

rmSync(out, { recursive: true, force: true });
cpSync(join(root, 'dist'), out, { recursive: true });

const csp = R2_HOSTS.reduce(
  (acc, host) => acc.replaceAll(host, CDN),
  buildCsp({ supabaseUrl: API, functionsUrl: `${API}/functions/v1` }, { forMeta: true }),
);
let pages = 0;
for (const f of readdirSync(out).filter((n) => n.endsWith('.html'))) {
  const path = join(out, f);
  const html = readFileSync(path, 'utf8');
  const patched = html.replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*(">)/, `$1${csp}$2`);
  if (patched === html) {
    console.error(`${f}: el build no incluyó la CSP; no se puede probar.`);
    process.exit(1);
  }
  writeFileSync(path, patched);
  pages++;
}
console.log(`\nE2E bajo CSP · ${pages} páginas · ${csp}\n`);

const filter = process.argv[2] ? [process.argv[2]] : [];
process.exit(run([join(root, 'tests', 'e2e', 'run.mjs'), ...filter], { E2E_SITE_ROOT: out }).status ?? 1);
