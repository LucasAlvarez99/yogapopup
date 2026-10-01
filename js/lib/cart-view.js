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
      return "Ya no está disponible";
    case "reduced":
      return line.qty === 1 ? "Solo queda 1 unidad" : `Solo quedan ${line.qty} unidades`;
    default:
      return "";
  }
}

/** ¿Se puede subir la cantidad de esta línea? Nunca por encima del stock ni del tope por producto. */
export function canIncrease(line) {
  if (!line.product || (line.status !== "ok" && line.status !== "reduced")) return false;
  return line.qty < limitFor(line.product.stock);
}

/** Las líneas agotadas o que ya no existen solo se pueden quitar. */
export const isRemovableOnly = (line) => line.status === "soldout" || line.status === "unavailable";

/**
 * Qué pasó al tocar "Agregar al carrito", para avisar con el texto correcto.
 * @returns {{ kind: "success" | "info", text: string }}
 */
export function addFeedback(before, after, product) {
  const had = qtyOf(before, product.id);
  const now = qtyOf(after, product.id);
  if (now > had) return { kind: "success", text: `«${product.title}» se agregó al carrito.` };
  if (limitFor(product.stock) === 0) return { kind: "info", text: "Este producto está agotado." };
  if (had === 0) return { kind: "info", text: "El carrito no admite más productos distintos. Quita alguno para agregar este." };
  return { kind: "info", text: `Ya tienes el máximo disponible de «${product.title}» en el carrito.` };
}
