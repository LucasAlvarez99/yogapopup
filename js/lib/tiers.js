import { eurosToCents } from './product-form.js';

/**
 * Niveles de suscripción (1, 2 y 3). Piezas puras: se prueban en tests/web/tiers.test.js.
 * El precio real lo fija el plan de PayPal (lo crea el servidor al guardar desde el panel); acá solo se arma lo que se muestra.
 */
export const TIERS = Object.freeze([1, 2, 3]);
export const TIER_NAME_MAX = 40; // iguales a los CHECK de subscription_tiers y a la Edge Function paypal-save-tier
export const TIER_BENEFITS_MAX = 400;
export const TIER_MIN_PRICE_CENTS = 100; // 1 €
export const TIER_MAX_PRICE_CENTS = 50000; // 500 €
export const TIER_MAX_DISCOUNT_BPS = 5000; // 50 %, igual que el CHECK de subscription_tiers y la Edge Function paypal-save-tier
export const TIER_MAX_FREE_CLASSES = 5;

/** Niveles ordenados y sin basura (una fila rara de la base no rompe la pantalla). */
export function sortTiers(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && TIERS.includes(r.tier) && Number.isSafeInteger(r.price_cents))
    .sort((a, b) => a.tier - b.tier);
}

/** Los niveles que se pueden contratar hoy: tienen plan en PayPal y, si se pide, entran en `allowed` (los niveles que ven una clase). */
export function sellableTiers(rows, allowed = null) {
  const only = Array.isArray(allowed) && allowed.length > 0 ? new Set(allowed) : null;
  return sortTiers(rows).filter((r) => r.plan_ready === true && (!only || only.has(r.tier)));
}

/** "10 € / mes" (sin decimales si el precio es redondo). */
export function tierPriceLabel(cents) {
  const euros = cents / 100;
  const text = Number.isInteger(euros) ? String(euros) : euros.toFixed(2).replace('.', ',');
  return `${text} € / mes`;
}

/**
 * Precio escrito en el panel -> céntimos. Un solo mensaje de error para todo lo inválido.
 * @returns {{ ok: true, cents: number } | { ok: false, error: string }}
 */
export function parseTierPrice(input) {
  const cents = eurosToCents(String(input ?? '').trim());
  if (cents === null || cents < TIER_MIN_PRICE_CENTS || cents > TIER_MAX_PRICE_CENTS) {
    return { ok: false, error: 'Escribe un precio mensual válido en euros, entre 1 y 500 (ej.: 10 o 12,50).' };
  }
  return { ok: true, cents };
}

/** Nombre y beneficios del formulario del panel. @returns {{ ok: true, name: string, benefits: string } | { ok: false, error: string }} */
export function parseTierText(name, benefits) {
  const n = String(name ?? '').trim();
  const b = String(benefits ?? '').trim();
  if (n.length < 1 || n.length > TIER_NAME_MAX) return { ok: false, error: `El nombre del nivel es obligatorio (hasta ${TIER_NAME_MAX} caracteres).` };
  if (b.length > TIER_BENEFITS_MAX) return { ok: false, error: `Los beneficios admiten hasta ${TIER_BENEFITS_MAX} caracteres.` };
  return { ok: true, name: n, benefits: b };
}

/** Nivel mínimo de una clase (1, 2 o 3). Cualquier otra cosa = 1: la ven todos los niveles. */
export function normalizeMinTier(value) {
  const n = Number(value);
  return TIERS.includes(n) ? n : 1;
}

/** Niveles que ven una clase con ese nivel mínimo. Son acumulativos: del mínimo al 3 (2 -> [2, 3]; el 3 ve siempre todo). */
export function tiersFromMin(minTier) {
  const min = normalizeMinTier(minTier);
  return TIERS.filter((n) => n >= min);
}

/** "Todos los niveles" · "Niveles 2 y 3" · "Solo nivel 3". Una clase libre no depende de ningún nivel. */
export function minTierLabel(minTier) {
  const min = normalizeMinTier(minTier);
  if (min === 1) return 'Todos los niveles';
  if (min === 2) return 'Niveles 2 y 3';
  return 'Solo nivel 3';
}

/** Nombre del nivel de una suscripción ("Plus"), o '' si no se conoce. */
export function tierName(rows, tier) {
  return sortTiers(rows).find((r) => r.tier === tier)?.name ?? '';
}

/** Descuento en puntos básicos -> "5 %" · "7,5 %". */
export function discountLabel(bps) {
  const pct = (Number(bps) || 0) / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0$/, '').replace('.', ',')} %`;
}

/** Descuento escrito en el panel ("5", "7,5", vacío = sin descuento) -> puntos básicos. @returns {{ ok: true, bps: number } | { ok: false, error: string }} */
export function parseTierDiscount(input) {
  const text = String(input ?? '').trim().replace(',', '.');
  if (text === '') return { ok: true, bps: 0 };
  const bad = { ok: false, error: 'Escribe el descuento como porcentaje, entre 0 y 50 (ej.: 5 o 7,5).' };
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text)) return bad;
  const bps = Math.round(Number(text) * 100);
  return bps > TIER_MAX_DISCOUNT_BPS ? bad : { ok: true, bps };
}

/** Clases gratis por mes escritas en el panel (vacío = 0). @returns {{ ok: true, count: number } | { ok: false, error: string }} */
export function parseTierFreeClasses(input) {
  const text = String(input ?? '').trim();
  if (text === '') return { ok: true, count: 0 };
  const count = Number(text);
  if (!/^\d{1,2}$/.test(text) || count > TIER_MAX_FREE_CLASSES) {
    return { ok: false, error: `Las clases gratis por mes van de 0 a ${TIER_MAX_FREE_CLASSES}.` };
  }
  return { ok: true, count };
}

/** Precio de una unidad con el descuento del nivel. Igual que payments_discounted_cents (nunca menos de 1 céntimo). */
export function discountedCents(cents, bps) {
  const off = Math.min(Math.max(Number(bps) || 0, 0), 10000);
  return Math.max(1, Math.round((cents * (10000 - off)) / 10000));
}

/** Descuento del nivel `tier` (puntos básicos), 0 si no se conoce. */
export function tierDiscountBps(rows, tier) {
  return sortTiers(rows).find((r) => r.tier === tier)?.discount_bps ?? 0;
}

/**
 * Lo que da cada nivel, listo para mostrar: los videos que ve (los niveles suman), el descuento y la clase gratis al mes.
 * Se arma con los datos de la base, así que cambiar el descuento en el panel cambia lo que se muestra.
 */
export function tierBenefitLines(t) {
  const lines = [];
  if (t.tier === 1) lines.push('Los videos del nivel 1');
  else if (t.tier === 2) lines.push('Los videos de los niveles 1 y 2');
  else lines.push('Todos los videos, sin excepciones');
  if (t.discount_bps > 0) lines.push(`${discountLabel(t.discount_bps)} de descuento en toda la tienda`);
  if (t.monthly_free_classes > 0) {
    lines.push(t.monthly_free_classes === 1 ? '1 clase virtual gratis por mes' : `${t.monthly_free_classes} clases virtuales gratis por mes`);
  }
  return lines;
}
