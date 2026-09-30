#!/usr/bin/env node
/**
 * Revisa que la configuración esté lista para un despliegue real.
 *
 *   npm run doctor            revisa js/config.js y supabase/.env (sin red)
 *   npm run doctor:online     además prueba el proyecto Supabase real (funciones, CORS, privacidad de columnas)
 *
 * Variables opcionales (para probar otro entorno sin editar archivos):
 *   YP_SUPABASE_URL  YP_ANON_KEY  YP_FUNCTIONS_URL  YP_ORIGINS="https://a.com,https://b.com"
 * Sale con código 1 si algo está en rojo.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { checkBackendEnv, checkFrontendConfig, describeAuthSettings, summarize } from './lib/doctor-checks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const online = process.argv.includes('--online');
const E = process.env;

function readFrontendConfig() {
  const file = join(root, 'js', 'config.js');
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox);
  return { ...sandbox.window.YOGAPOPUP_CONFIG };
}
function readEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const cfg = readFrontendConfig();
if (E.YP_SUPABASE_URL) cfg.SUPABASE_URL = E.YP_SUPABASE_URL;
if (E.YP_ANON_KEY) cfg.SUPABASE_ANON_KEY = E.YP_ANON_KEY;
cfg.FUNCTIONS_URL = E.YP_FUNCTIONS_URL || (E.YP_SUPABASE_URL ? `${E.YP_SUPABASE_URL}/functions/v1` : cfg.FUNCTIONS_URL);

const backendEnv = readEnvFile(join(root, 'supabase', '.env'));
const overrideOrigins = E.YP_ORIGINS ? E.YP_ORIGINS.split(',').map((s) => s.trim()) : null;
const results = [...checkFrontendConfig(cfg)];
// Con YP_SUPABASE_URL se está probando otro entorno: no se juzga el supabase/.env local.
if (!E.YP_SUPABASE_URL) results.push(...checkBackendEnv(backendEnv));
const origins = overrideOrigins || String(backendEnv.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

const R = (level, name, detail = '') => results.push({ level, name, detail });

async function onlineChecks() {
  const base = cfg.SUPABASE_URL, key = cfg.SUPABASE_ANON_KEY, fn = cfg.FUNCTIONS_URL;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const get = async (url, init = {}) => {
    try { return await fetch(url, { signal: AbortSignal.timeout(10000), ...init }); } catch (e) { return { status: 0, error: e.message }; }
  };

  const health = await get(`${fn}/health`);
  health.status === 200 ? R('ok', 'Función health', '200 (la base responde)') : R('fail', 'Función health', `estado ${health.status} ${health.error || ''}: ¿se desplegaron las funciones? (npm run sb:deploy)`);

  const settings = await get(`${base}/auth/v1/settings`, { headers });
  if (settings.status === 200) results.push(...describeAuthSettings(await settings.json()));
  else R('warn', 'Auth · ajustes', `no se pudieron leer (estado ${settings.status})`);

  const cat = await get(`${base}/rest/v1/classes?select=id&limit=1`, { headers });
  cat.status === 200 ? R('ok', 'Catálogo público (RLS)', 'el catálogo publicado se lee sin sesión') : R('fail', 'Catálogo público (RLS)', `estado ${cat.status}: ¿se aplicaron las migraciones? (npm run sb:db-push)`);

  // Privacidad: pedir la key de R2 desde el navegador DEBE estar denegado.
  const priv = await get(`${base}/rest/v1/classes?select=r2_object_key&limit=1`, { headers });
  [401, 403].includes(priv.status)
    ? R('ok', 'Columna de R2 oculta', `denegada al navegador (${priv.status})`)
    : R('fail', 'Columna de R2 oculta', `¡el navegador PUEDE leer r2_object_key (estado ${priv.status})! Revisa los privilegios por columna.`);

  const auth = await get(`${fn}/playback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  auth.status === 401 ? R('ok', 'playback sin sesión', '401 (correcto)') : R('fail', 'playback sin sesión', `estado ${auth.status}: debía ser 401`);

  for (const origin of origins.length ? origins : []) {
    const pre = await get(`${fn}/playback`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,apikey' } });
    const allow = pre.headers?.get?.('access-control-allow-origin');
    if (allow === origin) R('ok', `CORS ${origin}`, 'permitido');
    else if (allow === '*') R('warn', `CORS ${origin}`, 'la función responde "*" (mejor un origen exacto)');
    else R('fail', `CORS ${origin}`, `no permitido (recibido: ${allow || 'nada'}). Revisa ALLOWED_ORIGINS y vuelve a ejecutar npm run sb:secrets`);
  }
  if (origins.length === 0) R('warn', 'CORS', 'sin orígenes que probar (define ALLOWED_ORIGINS o YP_ORIGINS)');
}

if (online) {
  if (results.some((r) => r.name.startsWith('js/config.js · SUPABASE') && r.level === 'fail')) R('fail', 'Pruebas en línea', 'omitidas: primero completa js/config.js');
  else await onlineChecks();
}

const icon = { ok: '✓', warn: '!', fail: '✗' };
console.log(`\nYogaPop Up · doctor${online ? ' (en línea)' : ''}\n`);
for (const r of results) console.log(`  ${icon[r.level]} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const c = summarize(results);
console.log(`\n${c.ok} bien · ${c.warn} avisos · ${c.fail} errores\n`);
process.exit(c.fail ? 1 : 0);
