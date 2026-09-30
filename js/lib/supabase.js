import { cfg, isConfigured } from './env.js';

/**
 * Cliente único de Supabase (librería servida desde js/vendor/supabase.js).
 * Es null mientras js/config.js tenga los valores de ejemplo: las páginas lo detectan y lo explican.
 */
export const supabase = isConfigured && window.supabase
  ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'yogapopup-auth' },
  })
  : null;
