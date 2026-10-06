/**
 * Lógica de presentación del carrito (Fase 16), sin DOM: textos y reglas que la interfaz solo dibuja.
 * Se prueba en tests/web/cart-view.test.js.
 */
import { limitFor, qtyOf } from "./cart.js";

export const MAX_BADGE = 99;

/** Texto del globito del ícono: vacío si no hay nada, "99+" si son muchos. */
export function badgeText(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return "";
  return n > MAX_BADGE ? `${MAX_BADGE}+` : String(Math.floor(n));
}

/** Aviso de una línea de la validación ("" si está todo bien). */
export function lineNotice(line) {
  switch (line.status) {
    case "soldout":
      return "Agotado";
    case "unavailable":
      return line.variant ? "Ese talle ya no está disponible" : "Ya no está disponible";
    case "needs_size":
      return "Elige un talle";
    case "reduced":
      return line.qty === 1 ? "Solo queda 1 unidad" : `Solo quedan ${line.qty} unidades`;
    default:
      return "";
  }
}

/** ¿Se puede subir la cantidad de esta línea? Nunca por encima del stock ni del tope por producto. */
export function canIncrease(line) {
  if (!line.product || (line.status !== "ok" && line.status !== "reduced")) return false;
  // Con talles el límite es el stock del talle (`line.stock`); las líneas armadas a mano sin ese dato usan el del producto.
  return line.qty < limitFor("stock" in line ? line.stock : line.product.stock);
}

/** Las líneas agotadas o que ya no existen solo se pueden quitar. */
export const isRemovableOnly = (line) => line.status === "soldout" || line.status === "unavailable" || line.status === "needs_size";

/**
 * Qué pasó al tocar "Agregar al carrito", para avisar con el texto correcto.
 * @returns {{ kind: "success" | "info", text: string }}
 */
export function addFeedback(before, after, product, { variant = null, size = null, stock = product.stock } = {}) {
  const had = qtyOf(before, product.id, variant);
  const now = qtyOf(after, product.id, variant);
  const name = size ? `${product.title} (talle ${size})` : product.title;
  if (now > had) return { kind: "success", text: `«${name}» se agregó al carrito.` };
  if (limitFor(stock) === 0) return { kind: "info", text: size ? "Ese talle está agotado." : "Este producto está agotado." };
  if (had === 0) return { kind: "info", text: "El carrito no admite más productos distintos. Quita alguno para agregar este." };
  return { kind: "info", text: `Ya tienes el máximo disponible de «${name}» en el carrito.` };
}
