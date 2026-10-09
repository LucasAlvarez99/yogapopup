/**
 * Cabeceras de seguridad del sitio estático. Se generan en el build (y no a mano en .htaccess) porque la CSP depende
 * del proyecto de Supabase de cada despliegue; así no puede quedar desactualizada ni con un host de otro entorno.
 *
 * La CSP es estricta a propósito: el sitio no tiene scripts ni estilos inline, ni `innerHTML`, ni `eval`
 * (lo garantiza tests/web/csp.test.js). Si algún día hace falta una excepción, se agrega acá, explicada.
 */

/** Hosts de R2: la subida del video (PUT) y la reproducción (GET firmado) van directo del navegador a R2. */
export const R2_HOSTS = ['https://*.r2.cloudflarestorage.com'];

/** Imágenes externas que hoy usa el sitio de marketing (idealmente se alojan en assets/ y esto desaparece). */
export const EXTRA_IMG_HOSTS = ['https://images.unsplash.com'];

/**
 * Hosts de PayPal (SDK de botones). Solo se agregan cuando js/config.js tiene un PAYPAL.CLIENT_ID: sin pagos, la CSP sigue
 * sin permitir NADA de PayPal. El SDK carga scripts, abre iframes con los botones y se conecta a su API.
 * No se agrega 'unsafe-inline': si algún día los botones salen sin estilo, mirá la consola (violaciones de CSP) antes de aflojarla.
 */
export const PAYPAL_HOSTS = {
  script: ['https://*.paypal.com', 'https://*.paypalobjects.com'],
  frame: ['https://*.paypal.com'],
  connect: ['https://*.paypal.com', 'https://*.paypalobjects.com'],
  img: ['https://*.paypal.com', 'https://*.paypalobjects.com'],
};

export function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ supabaseUrl?: string, functionsUrl?: string, extraImgHosts?: string[], paypalClientId?: string }} opts
 * @param {{ forMeta?: boolean }} [mode] `frame-ancestors` se ignora en <meta>, así que en ese caso no se incluye.
 */
export function buildCsp({ supabaseUrl, functionsUrl, extraImgHosts = EXTRA_IMG_HOSTS, paypalClientId = '' } = {}, { forMeta = false } = {}) {
  const supabase = originOf(supabaseUrl);
  const functions = originOf(functionsUrl);
  const paypal = Boolean(paypalClientId);
  const connect = ["'self'", supabase, functions, ...R2_HOSTS, ...(paypal ? PAYPAL_HOSTS.connect : [])].filter(Boolean);
  const img = ["'self'", 'data:', 'blob:', supabase, ...extraImgHosts, ...(paypal ? PAYPAL_HOSTS.img : [])].filter(Boolean);

  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", ...(paypal ? PAYPAL_HOSTS.script : [])],
    'style-src': ["'self'"],
    'img-src': [...new Set(img)],
    'media-src': ["'self'", 'blob:', ...R2_HOSTS],
    'font-src': ["'self'"],
    'connect-src': [...new Set(connect)],
    'frame-src': paypal ? PAYPAL_HOSTS.frame : ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };
  if (!forMeta) directives['frame-ancestors'] = ["'none'"];
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

/** Bloque para .htaccess (Apache/LiteSpeed en Hostinger). */
export function htaccessSecurityBlock(cfg) {
  const csp = buildCsp(cfg);
  // El pago de PayPal abre una ventana emergente que tiene que poder hablar con la página: `same-origin` la cortaría
  // (el pago nunca se completa). `same-origin-allow-popups` mantiene el aislamiento salvo para las ventanas que abrimos nosotros.
  const coop = cfg?.paypalClientId ? 'same-origin-allow-popups' : 'same-origin';
  return `
# ---------------------------------------------------------------------------
# Cabeceras de seguridad · GENERADAS por scripts/build-site.mjs (no editar a mano en dist/)
# ---------------------------------------------------------------------------
<IfModule mod_headers.c>
  Header always set Content-Security-Policy "${csp}"
  Header always set X-Content-Type-Options "nosniff"
  Header always set X-Frame-Options "DENY"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set Permissions-Policy "camera=(), microphone=(), geolocation=(), usb=(), interest-cohort=()"
  Header always set Cross-Origin-Opener-Policy "${coop}"
  Header always set Strict-Transport-Security "max-age=31536000"
</IfModule>
`;
}

/** Inserta la CSP como <meta> (red de seguridad para hostings que ignoran .htaccess, p. ej. GitHub Pages). Idempotente. */
export function injectMetaCsp(html, cfg) {
  if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) return html;
  const tag = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(cfg, { forMeta: true })}">`;
  if (!/<meta charset[^>]*>/i.test(html)) throw new Error('La página no tiene <meta charset>: no se puede insertar la CSP.');
  return html.replace(/(<meta charset[^>]*>)/i, `$1\n  ${tag}`);
}

/** Lee window.YOGAPOPUP_CONFIG de js/config.js sin ejecutarlo. */
export function readFrontendConfig(source) {
  const pick = (key) => source.match(new RegExp(`${key}\\s*:\\s*'([^']*)'`))?.[1] ?? '';
  const paypalClientId = pick('CLIENT_ID');
  // Solo un Client ID con forma válida habilita los hosts de PayPal (termina dentro de una cabecera: nada de caracteres raros).
  return { supabaseUrl: pick('SUPABASE_URL'), functionsUrl: pick('FUNCTIONS_URL'), paypalClientId: /^[A-Za-z0-9_-]{10,200}$/.test(paypalClientId) ? paypalClientId : '' };
}
