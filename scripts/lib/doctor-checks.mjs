/**
 * Comprobaciones de configuración (puras, sin red ni archivos): reciben datos y devuelven resultados.
 * Cada resultado: { level: 'ok' | 'warn' | 'fail', name, detail }
 * Las usa scripts/doctor.mjs; están probadas en tests/web/doctor.test.js.
 */
const ok = (name, detail = '') => ({ level: 'ok', name, detail });
const warn = (name, detail) => ({ level: 'warn', name, detail });
const fail = (name, detail) => ({ level: 'fail', name, detail });

const PLACEHOLDER = /TU-PROYECTO|TU-ANON|TU-DOMINIO|REEMPLAZAR|xxxx|example\.com/i;

/** Decodifica el payload de un JWT sin verificarlo (solo para inspeccionar el rol declarado). */
export function jwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return null; }
}

/** js/config.js (público). @param {object} cfg  window.YOGAPOPUP_CONFIG */
export function checkFrontendConfig(cfg = {}) {
  const out = [];
  const url = String(cfg.SUPABASE_URL || '');
  const key = String(cfg.SUPABASE_ANON_KEY || '');

  if (!url || PLACEHOLDER.test(url)) out.push(fail('js/config.js · SUPABASE_URL', 'sigue con el valor de ejemplo'));
  else if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
    out.push(warn('js/config.js · SUPABASE_URL', `formato inesperado (${url}); ¿dominio propio?`));
  } else out.push(ok('js/config.js · SUPABASE_URL', url));

  if (!key || PLACEHOLDER.test(key)) out.push(fail('js/config.js · SUPABASE_ANON_KEY', 'sigue con el valor de ejemplo'));
  else {
    const payload = key.startsWith('eyJ') ? jwtPayload(key) : null;
    if (key.startsWith('sb_secret_') || payload?.role === 'service_role') {
      out.push(fail('js/config.js · SUPABASE_ANON_KEY', '¡ES UNA CLAVE SECRETA (service role)! Va SOLO en el backend. Cámbiala YA y rota la clave en Supabase.'));
    } else if (payload && payload.role !== 'anon') {
      out.push(warn('js/config.js · SUPABASE_ANON_KEY', `el rol declarado es "${payload.role}", se esperaba "anon"`));
    } else out.push(ok('js/config.js · SUPABASE_ANON_KEY', 'clave pública'));
  }

  const fn = String(cfg.FUNCTIONS_URL || '');
  if (fn && url && !PLACEHOLDER.test(url) && !fn.startsWith(url)) out.push(warn('js/config.js · FUNCTIONS_URL', 'no cuelga de SUPABASE_URL'));
  if (!cfg.PRIVACY_URL) out.push(warn('js/config.js · PRIVACY_URL', 'vacío: el registro NO pide aceptar la política de privacidad (RGPD). Complétalo antes de abrir el registro.'));
  return out;
}

/** supabase/.env (secretos del backend). @param {Record<string,string>} env */
export function checkBackendEnv(env = {}) {
  const out = [];
  const need = (k) => String(env[k] || '').trim();

  const accountId = need('R2_ACCOUNT_ID');
  out.push(!accountId ? fail('R2_ACCOUNT_ID', 'falta') : ok('R2_ACCOUNT_ID', accountId));

  for (const k of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    out.push(need(k) ? ok(k, 'presente') : fail(k, 'falta'));
  }

  const bucket = need('R2_BUCKET');
  if (!bucket) out.push(fail('R2_BUCKET', 'falta'));
  else if (/^https?:\/\//.test(bucket) || bucket.includes('/')) out.push(fail('R2_BUCKET', 'debe ser solo el nombre del bucket, sin URL ni barras'));
  else out.push(ok('R2_BUCKET', bucket));

  const origins = need('ALLOWED_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.length === 0) out.push(fail('ALLOWED_ORIGINS', 'vacío: el navegador no podrá llamar a las funciones (CORS)'));
  else {
    const bad = origins.filter((o) => PLACEHOLDER.test(o));
    const notOrigin = origins.filter((o) => !/^https?:\/\/[^/]+$/.test(o));
    if (bad.length) out.push(fail('ALLOWED_ORIGINS', `todavía tiene valores de ejemplo: ${bad.join(', ')}`));
    else if (notOrigin.length) out.push(fail('ALLOWED_ORIGINS', `un origen es "https://dominio" sin ruta ni barra final: ${notOrigin.join(', ')}`));
    else if (origins.includes('*')) out.push(fail('ALLOWED_ORIGINS', '"*" no es seguro para producción'));
    else {
      out.push(ok('ALLOWED_ORIGINS', origins.join(', ')));
      if (origins.some((o) => /localhost|127\.0\.0\.1/.test(o))) out.push(warn('ALLOWED_ORIGINS', 'incluye localhost: quítalo en producción'));
      if (!origins.every((o) => o.startsWith('https://') || /localhost|127\.0\.0\.1/.test(o))) out.push(warn('ALLOWED_ORIGINS', 'hay orígenes sin https'));
    }
  }
  return out;
}

/** Resultado de GET /auth/v1/settings (información útil para el equipo). */
export function describeAuthSettings(s = {}) {
  const out = [];
  if (s.external?.email === false) out.push(fail('Auth · registro por correo', 'está DESACTIVADO en Supabase'));
  else out.push(ok('Auth · registro por correo', 'activado'));
  out.push(s.disable_signup ? warn('Auth · altas nuevas', 'están desactivadas: nadie podrá registrarse') : ok('Auth · altas nuevas', 'permitidas'));
  out.push(s.mailer_autoconfirm
    ? warn('Auth · confirmación de correo', 'NO se exige: cualquiera puede registrarse con un correo ajeno. Actívala antes de abrir el registro.')
    : ok('Auth · confirmación de correo', 'se exige (los usuarios reciben un enlace)'));
  return out;
}

export function summarize(results) {
  const c = { ok: 0, warn: 0, fail: 0 };
  for (const r of results) c[r.level]++;
  return c;
}
