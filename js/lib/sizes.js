import { stockInfo } from "./format.js";

/**
 * Talles de los productos (Fase 14 bis). Lógica pura, sin DOM ni red.
 *
 * Un producto con talles guarda el stock EN CADA TALLE (el stock del producto se ignora). Misma convención de siempre:
 * stock `null` = no se controla, 0 = agotado. Las reglas de validación repiten las de la base
 * (save_product_variants): la base es la que manda, esto solo evita el viaje y da un mensaje claro.
 */
export const MAX_SIZES = 20;
export const MAX_SIZE_LENGTH = 20;
export const MAX_SIZE_STOCK = 1_000_000;
/** Atajos del panel (el resto se escribe a mano). */
export const SIZE_PRESETS = Object.freeze(["XS", "S", "M", "L", "XL", "2XL", "3XL", "Única"]);

/** Talles del producto en el orden en que se muestran (los de la base ya vienen con `sort_order`). */
export function sortedVariants(product) {
  const list = Array.isArray(product?.product_variants) ? product.product_variants : [];
  return list
    .filter((v) => v && typeof v.id === "string" && typeof v.size === "string" && v.size !== "")
    .map((v, i) => ({ v, i }))
    .sort((a, b) => (Number(a.v.sort_order) || 0) - (Number(b.v.sort_order) || 0) || a.i - b.i)
    .map(({ v }) => v);
}

export const hasSizes = (product) => sortedVariants(product).length > 0;

export const findVariant = (product, id) =>
  typeof id === "string" ? sortedVariants(product).find((v) => v.id.toLowerCase() === id.toLowerCase()) ?? null : null;

/** Disponibilidad de UN talle. @returns {{ available: boolean, label: string }} */
export const variantInfo = (variant) => stockInfo(variant?.stock);

/**
 * Disponibilidad del producto entero: con talles, hay si queda stock en alguno; sin talles, la de siempre.
 * @returns {{ hasSizes: boolean, available: boolean, label: string }}
 */
export function productAvailability(product) {
  const sizes = sortedVariants(product);
  if (sizes.length === 0) return { hasSizes: false, ...stockInfo(product?.stock) };
  return { hasSizes: true, available: sizes.some((v) => variantInfo(v).available), label: "" };
}

/** Lo que se pasa al carrito para un talle: su id y su stock (el que limita la cantidad). */
export const cartOptionsFor = (variant) => ({ variant: variant.id, stock: variant.stock });

/** "S · M · L" (para listas y tarjetas). */
export const sizesSummary = (product) => sortedVariants(product).map((v) => v.size).join(" · ");

const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Valida las filas del editor del panel y las deja listas para `save_product_variants`.
 * `stock` vacío = no se controla; un número entero de 0 a 1.000.000 = unidades.
 * @param {Array<{ size: string, stock?: string|number|null }>} rows
 * @returns {{ value: Array<{ size: string, stock: number|null }> } | { error: string }}
 */
export function validateSizeRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length > MAX_SIZES) return { error: `Un producto admite hasta ${MAX_SIZES} talles.` };
  const seen = new Set();
  const value = [];
  for (const row of list) {
    const size = String(row?.size ?? "").trim().replace(/\s+/g, " ");
    if (size === "") return { error: "Hay un talle sin nombre. Escribe el talle (por ejemplo M) o quita la fila." };
    if (size.length > MAX_SIZE_LENGTH) return { error: `El talle «${size.slice(0, 12)}…» es muy largo (máximo ${MAX_SIZE_LENGTH} caracteres).` };
    if (CONTROL.test(size)) return { error: "Un talle tiene caracteres no válidos." };
    const key = size.toLowerCase();
    if (seen.has(key)) return { error: `El talle «${size}» está repetido.` };
    seen.add(key);

    const raw = row?.stock;
    const text = raw === null || raw === undefined ? "" : String(raw).trim();
    let stock = null;
    if (text !== "") {
      if (!/^\d{1,7}$/.test(text) || Number(text) > MAX_SIZE_STOCK) {
        return { error: `El stock del talle ${size} debe ser un número entero (o déjalo vacío si no se controla).` };
      }
      stock = Number(text);
    }
    value.push({ size, stock });
  }
  return { value };
}
