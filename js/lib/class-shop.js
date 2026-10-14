/**
 * Los videos se venden como los productos de la tienda. Piezas puras (sin DOM ni red), probadas en tests/web/class-shop.test.js.
 * El permiso real lo decide SIEMPRE el servidor (función `playback` y `payments_create_order`): esto solo decide qué botón se dibuja.
 */
import { normalizeMinTier } from './tiers.js';

/**
 * Los accesos de la persona (filas de `entitlements`) en una forma fácil de consultar.
 *   tier       el nivel más alto de sus suscripciones vigentes (null = sin suscripción)
 *   allAccess  true si tiene un acceso total manual (sin nivel): ve todo
 *   classes    Map id de video -> fecha en que vence su acceso (null = sin vencimiento)
 */
export function accessFromEntitlements(rows, { now = Date.now() } = {}) {
  const access = { tier: null, allAccess: false, classes: new Map() };
  for (const e of Array.isArray(rows) ? rows : []) {
    if (!e || (e.expires_at && Date.parse(e.expires_at) <= now)) continue; // vencido
    if (e.scope === 'all') {
      if (e.tier == null) access.allAccess = true;
      else access.tier = Math.max(access.tier ?? 0, Number(e.tier) || 0) || access.tier;
    } else if (e.scope === 'class' && e.class_id) {
      const prev = access.classes.get(e.class_id);
      const until = e.expires_at ?? null;
      // Si hay dos accesos al mismo video, vale el que dura más (null = para siempre).
      if (prev === undefined || until === null || (prev !== null && Date.parse(until) > Date.parse(prev))) access.classes.set(e.class_id, until);
    }
  }
  return access;
}

/**
 * ¿Qué se le ofrece a la persona de este video?
 *   free       video gratis: se ve sin pagar
 *   owned      lo compró y sigue vigente (30 días)
 *   included   su suscripción lo cubre
 *   buy        se puede comprar suelto (tiene precio)
 *   locked     es restringido y no se vende suelto: solo con suscripción
 * @param {object} cls  fila de classes (access_level, price_cents y, si se leyó, min_tier)
 * @param {ReturnType<typeof accessFromEntitlements>|null} access  null = sin sesión
 */
export function classOffer(cls, access) {
  if (cls.access_level !== 'restricted') return 'free';
  if (access) {
    if (access.classes.has(cls.id)) return 'owned';
    if (access.allAccess) return 'included';
    // Sin `min_tier` leído (no se pudo) no se asume que la suscripción lo cubra: el servidor lo confirma al reproducir.
    if (access.tier != null && cls.min_tier != null && access.tier >= normalizeMinTier(cls.min_tier)) return 'included';
  }
  return Number.isSafeInteger(cls.price_cents) && cls.price_cents > 0 ? 'buy' : 'locked';
}

/** Días que quedan de un video comprado (redondeado hacia arriba), o null si no vence. */
export function daysLeft(until, { now = Date.now() } = {}) {
  if (!until) return null;
  const ms = Date.parse(until) - now;
  return ms > 0 ? Math.ceil(ms / 86_400_000) : 0;
}

/** "Te quedan 12 días" · "Te queda 1 día" · "Vence hoy". */
export function daysLeftLabel(days) {
  if (days === null) return '';
  if (days <= 0) return 'Vence hoy';
  return days === 1 ? 'Te queda 1 día' : `Te quedan ${days} días`;
}
