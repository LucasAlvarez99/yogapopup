import { formatPrice } from "./format.js";

/**
 * IVA INCLUIDO en el precio (Fase 17). El precio que se guarda y se cobra es siempre el que ve la persona; el IVA
 * solo sirve para mostrar el precio sin IVA al lado y, más adelante, para facturar. Todo en céntimos y con enteros.
 *
 * Tipo por defecto: 21 % (general en España, incluida Ibiza). Los tipos reales de cada producto los confirma la gestoría.
 */
export const DEFAULT_TAX_BPS = 2100;
export const MAX_TAX_BPS = 2500;

/** Tipos que ofrece el panel (los de España; la gestoría confirma cuál va en cada producto). */
export const TAX_OPTIONS = Object.freeze([
  { bps: 2100, label: "21 % (general)" },
  { bps: 1000, label: "10 % (reducido)" },
  { bps: 400, label: "4 % (superreducido)" },
  { bps: 0, label: "0 % (exento)" },
]);

/** Puntos básicos válidos (entero 0..2500); cualquier otra cosa vuelve al tipo general. */
export const normalizeRate = (bps) => (Number.isInteger(bps) && bps >= 0 && bps <= MAX_TAX_BPS ? bps : DEFAULT_TAX_BPS);

/** 2100 -> "21 %" · 1050 -> "10,5 %" */
export const formatRate = (bps) => `${String(normalizeRate(bps) / 100).replace(".", ",")} %`;

/**
 * Separa un precio con IVA incluido en base + IVA. La base se redondea al céntimo más cercano y el IVA es la diferencia,
 * así base + IVA suman SIEMPRE exactamente el precio.
 * 3500 a 21 % -> base 2893 (28,93 €) + IVA 607. Un precio inválido da null (nunca un número inventado).
 */
export function splitTax(grossCents, rateBps = DEFAULT_TAX_BPS) {
  if (!Number.isSafeInteger(grossCents) || grossCents < 0) return null;
  const rate = normalizeRate(rateBps);
  const divisor = 10000 + rate;
  const netCents = Math.floor((grossCents * 20000 + divisor) / (2 * divisor)); // = round(gross * 10000 / divisor)
  return { grossCents, netCents, taxCents: grossCents - netCents, rateBps: rate };
}

/**
 * Textos del precio para mostrar: el precio grande y, al lado y más chico, el precio sin IVA.
 * Un producto exento (0 %) no repite la misma cifra: `net` queda vacío.
 * @returns {{ price: string, net: string, rateLabel: string }}
 */
export function priceParts(grossCents, rateBps = DEFAULT_TAX_BPS) {
  const parts = splitTax(grossCents, rateBps);
  if (!parts) return { price: "", net: "", rateLabel: "" };
  return {
    price: formatPrice(parts.grossCents),
    net: parts.rateBps > 0 ? formatPrice(parts.netCents) : "",
    rateLabel: formatRate(parts.rateBps),
  };
}
