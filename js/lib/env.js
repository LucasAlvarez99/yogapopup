/** Configuración leída de js/config.js + raíz del sitio (para armar enlaces relativos en cualquier página). */
const raw = window.YOGAPOPUP_CONFIG || {};
const trim = (u) => String(u || '').replace(/\/+$/, '');

export const cfg = Object.freeze({
  SUPABASE_URL: trim(raw.SUPABASE_URL),
  SUPABASE_ANON_KEY: String(raw.SUPABASE_ANON_KEY || ''),
  FUNCTIONS_URL: trim(raw.FUNCTIONS_URL || (raw.SUPABASE_URL ? `${trim(raw.SUPABASE_URL)}/functions/v1` : '')),
  PRIVACY_URL: String(raw.PRIVACY_URL || ''),
  /** Responsable del tratamiento: se muestra en privacidad.html. Texto plano (nunca HTML). */
  LEGAL: Object.freeze({
    NAME: String(raw.LEGAL?.NAME || '').trim().slice(0, 200),
    TAX_ID: String(raw.LEGAL?.TAX_ID || '').trim().slice(0, 40),
    ADDRESS: String(raw.LEGAL?.ADDRESS || '').trim().slice(0, 300),
    EMAIL: String(raw.LEGAL?.EMAIL || '').trim().slice(0, 120),
  }),
  PROGRESS_INTERVAL_SECONDS: Math.max(5, Number(raw.PROGRESS_INTERVAL_SECONDS) || 15),
});

/** false mientras config.js conserve los valores de ejemplo. */
export const isConfigured =
  /^https?:\/\//.test(cfg.SUPABASE_URL) && !/TU-PROYECTO/i.test(cfg.SUPABASE_URL) &&
  cfg.SUPABASE_ANON_KEY !== '' && !/TU-ANON/i.test(cfg.SUPABASE_ANON_KEY);

/** URL absoluta de la raíz del sitio (js/lib/ -> ../../). */
export const ROOT = new URL('../../', import.meta.url).href;
export const page = (name) => new URL(name, ROOT).href;
