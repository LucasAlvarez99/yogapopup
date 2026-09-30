/** Configuración leída de js/config.js + raíz del sitio (para armar enlaces relativos en cualquier página). */
const raw = window.YOGAPOPUP_CONFIG || {};
const trim = (u) => String(u || '').replace(/\/+$/, '');

export const cfg = Object.freeze({
  SUPABASE_URL: trim(raw.SUPABASE_URL),
  SUPABASE_ANON_KEY: String(raw.SUPABASE_ANON_KEY || ''),
  FUNCTIONS_URL: trim(raw.FUNCTIONS_URL || (raw.SUPABASE_URL ? `${trim(raw.SUPABASE_URL)}/functions/v1` : '')),
  PRIVACY_URL: String(raw.PRIVACY_URL || ''),
  PROGRESS_INTERVAL_SECONDS: Math.max(5, Number(raw.PROGRESS_INTERVAL_SECONDS) || 15),
});

/** false mientras config.js conserve los valores de ejemplo. */
export const isConfigured =
  /^https?:\/\//.test(cfg.SUPABASE_URL) && !/TU-PROYECTO/i.test(cfg.SUPABASE_URL) &&
  cfg.SUPABASE_ANON_KEY !== '' && !/TU-ANON/i.test(cfg.SUPABASE_ANON_KEY);

/** URL absoluta de la raíz del sitio (js/lib/ -> ../../). */
export const ROOT = new URL('../../', import.meta.url).href;
export const page = (name) => new URL(name, ROOT).href;
