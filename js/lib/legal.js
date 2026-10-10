import { cfg, page } from './env.js';

/**
 * Versión VIGENTE de la política de privacidad (AAAA-MM-DD). Súbela cada vez que el texto de privacidad.html cambie
 * de fondo (nuevos datos, nuevos proveedores, nuevos fines: p. ej. al activar los pagos). Se guarda junto con la
 * aceptación de cada persona, para poder demostrar QUÉ texto aceptó y CUÁNDO (el RGPD exige poder acreditarlo).
 */
export const PRIVACY_VERSION = '2026-10-10'; // 2026-10-10: comentarios públicos de la comunidad · 2026-10-08: pagos con PayPal (pedidos, dirección de envío, suscripciones)

/** Datos que viajan con el registro cuando la persona marcó la casilla. Fecha y hora las pone el SERVIDOR, no el navegador. */
export function consentMetadata(accepted) {
  return accepted ? { privacy_version: PRIVACY_VERSION } : {};
}

/**
 * URL de la política: absoluta (https) o relativa al sitio. Cualquier otra cosa (javascript:, data:, //otro-sitio…)
 * se descarta: el enlace de la casilla de registro nunca puede ejecutar código.
 */
export function privacyHref(url = cfg.PRIVACY_URL) {
  const u = String(url || '').trim();
  if (/^https:\/\/[^\s]+$/i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?$/i.test(u)) return u;
  if (/^[A-Za-z0-9_\-./]+$/.test(u) && !u.startsWith('/') && !u.includes('..')) return page(u);
  return '';
}

/** Datos del responsable (js/config.js → LEGAL), con la forma que usa privacidad.html. */
export const LEGAL_FIELDS = [
  ['NAME', 'Nombre o razón social'],
  ['TAX_ID', 'NIF/CIF'],
  ['ADDRESS', 'Domicilio'],
  ['EMAIL', 'Correo de contacto'],
];

export const isEmail = (v) => /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(String(v || ''));
