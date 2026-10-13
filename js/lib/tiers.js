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

/** Niveles ordenados y sin basura (una fila rara de la base no rompe la pantalla). */
export function sortTiers(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && TIERS.includes(r.tier) && Number.isSafeInteger(r.price_cents))
    .sort((a, b) => a.tier - b.tier);
}

/** Los niveles que se pueden contratar hoy: tienen plan en PayPal y, si se pide, entran en `allowed` (niveles de una clase). */
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
    return { ok: false, error: 'Escribí un precio mensual válido en euros, entre 1 y 500 (ej.: 10 o 12,50).' };
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

/** Niveles marcados en el formulario de una clase (números sueltos, sin repetir, ordenados). Vacío = inválido. */
export function normalizeClassTiers(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(Number).filter((n) => TIERS.includes(n)))].sort((a, b) => a - b);
}

/** "Todos los niveles" · "Nivel 3" · "Niveles 2 y 3". Una clase libre no depende de ningún nivel. */
export function classTiersLabel(tiers) {
  const t = normalizeClassTiers(tiers);
  if (t.length === 0 || t.length === TIERS.length) return 'Todos los niveles';
  if (t.length === 1) return `Nivel ${t[0]}`;
  return `Niveles ${t.slice(0, -1).join(', ')} y ${t.at(-1)}`;
}

/** Nombre del nivel de una suscripción ("Plus"), o '' si no se conoce. */
export function tierName(rows, tier) {
  return sortTiers(rows).find((r) => r.tier === tier)?.name ?? '';
}
