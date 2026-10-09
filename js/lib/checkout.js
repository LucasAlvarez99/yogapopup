/**
 * Lógica pura del pago (sin DOM ni red): qué se manda al servidor y qué se le dice a la persona.
 * Se prueba en tests/web/checkout.test.js.
 */
import { AppError } from './errors.js';

/**
 * Líneas del carrito validado -> lo que se manda a `paypal-create-order`. Solo id, talle y cantidad: el PRECIO no
 * viaja (el servidor lo lee de la base). Devuelve [] si el carrito tiene algo que arreglar o está vacío.
 */
export function cartToItems(validation) {
  if (!validation || !validation.ok) return [];
  return validation.lines.map((l) => ({ type: 'product', id: l.id, variant_id: l.variant ?? null, qty: l.qty }));
}

/** Una clase suelta. */
export const classToItems = (classId) => [{ type: 'class', id: classId }];

/** ¿Se puede mostrar el botón de pagar? (carrito válido, con algo adentro y con el total a cobrar) */
export const canCheckout = (validation) => !!validation && validation.ok === true && validation.subtotalCents > 0;

/** Qué mensaje mostrar tras intentar cobrar. `status` es el de `paypal-capture-order`. */
export function outcomeMessage(status, kind) {
  if (status === 'paid') {
    return kind === 'class'
      ? { type: 'success', title: '¡Listo, la clase es tuya!', text: 'Ya podés verla cuando quieras.' }
      : { type: 'success', title: '¡Gracias por tu compra!', text: 'Te enviaremos el pedido a la dirección que indicaste en PayPal.' };
  }
  if (status === 'pending') {
    return { type: 'info', title: 'Estamos esperando la confirmación de PayPal', text: 'Cuando se confirme el pago, te lo vamos a reflejar acá. No hace falta que pagues de nuevo.' };
  }
  return { type: 'error', title: 'No pudimos completar el pago', text: 'No se te cobró nada. Probá de nuevo.' };
}

/**
 * Errores del flujo de pago que dejan la compra abierta (se puede reintentar sin recargar) vs. los que obligan a
 * revisar el carrito. `stale` = los datos del carrito cambiaron: hay que volver a leerlo.
 */
export function classifyPaymentError(err) {
  const code = err instanceof AppError ? err.code : '';
  if (['insufficient_stock', 'product_unavailable', 'class_unavailable', 'invalid_cart', 'size_required'].includes(code)) return 'stale';
  if (['already_owned', 'already_subscribed'].includes(code)) return 'owned';
  if (code === 'unauthenticated') return 'login';
  if (['payments_unavailable', 'payments_not_configured'].includes(code)) return 'unavailable';
  return 'retry';
}
