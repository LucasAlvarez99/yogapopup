/**
 * Presentación de pedidos y suscripciones para el panel (sin DOM): textos y reglas que la interfaz solo dibuja.
 * Se prueba en tests/web/payments-view.test.js.
 */
import { eurosToCents } from './product-form.js';

export const MAX_CLASS_PRICE_CENTS = 10_000_000; // igual que el CHECK de classes.price_cents

export const ORDER_STATUS = Object.freeze({
  created: { label: 'Sin pagar', tone: 'secondary' },
  pending: { label: 'Pago pendiente', tone: 'warning' },
  paid: { label: 'Pagado', tone: 'success' },
  failed: { label: 'Falló', tone: 'danger' },
  cancelled: { label: 'Cancelado', tone: 'secondary' },
  refunded: { label: 'Reembolsado', tone: 'dark' },
});

export const SUBSCRIPTION_STATUS = Object.freeze({
  approval_pending: { label: 'Sin aprobar', tone: 'secondary' },
  active: { label: 'Activa', tone: 'success' },
  suspended: { label: 'Pago pendiente', tone: 'warning' },
  cancelled: { label: 'Cancelada', tone: 'secondary' },
  expired: { label: 'Vencida', tone: 'secondary' },
});

export const statusInfo = (table, status) => table[status] ?? { label: String(status ?? ''), tone: 'secondary' };

/** Qué le pasa a un pedido que pide revisión (lo escribe la base) y qué tiene que hacer quien gestiona. */
export function reviewNoteText(note) {
  switch (note) {
    case 'amount_mismatch': return 'PayPal cobró un importe distinto al del pedido. No se dio por pagado: revisalo en PayPal.';
    case 'paid_without_stock': return 'Se cobró cuando ya no había stock (pago tardío). Hay que reembolsar o conseguir el producto.';
    default: return note ? 'Este pedido necesita una revisión.' : '';
  }
}

/** "2 × Mat (talle M), 1 × Bloque" */
export function describeItems(items = []) {
  return items.map((i) => `${i.qty} × ${i.title}${i.size ? ` (talle ${i.size})` : ''}`).join(', ');
}

/** Dirección de envío de PayPal en líneas de texto (vacío si no hay). */
export function shippingLines(shipping) {
  if (!shipping || typeof shipping !== 'object') return [];
  const place = [shipping.postal_code, shipping.city].filter(Boolean).join(' ');
  const region = [shipping.region, shipping.country_code].filter(Boolean).join(', ');
  return [shipping.name, shipping.address_line_1, shipping.address_line_2, place, region].filter(Boolean).map(String);
}

/** Resultado de "verificar de nuevo" (paypal-reconcile) en una frase. */
export function reconcileMessage(outcome) {
  switch (outcome) {
    case 'paid': return { type: 'success', text: 'Verificado: el pedido está pagado.' };
    case 'already_paid': return { type: 'info', text: 'El pedido ya estaba pagado. No cambió nada.' };
    case 'pending': return { type: 'info', text: 'PayPal todavía no confirmó el cobro.' };
    case 'failed': return { type: 'info', text: 'El pago fue rechazado. Se liberó el stock.' };
    case 'cancelled': return { type: 'info', text: 'Nadie pagó este pedido: se canceló y se liberó el stock.' };
    case 'open': return { type: 'info', text: 'Sigue sin pagar en PayPal.' };
    case 'mismatch': return { type: 'error', text: 'El cobro no coincide con el pedido: queda marcado para revisar.' };
    case 'ok': return { type: 'success', text: 'Suscripción verificada con PayPal.' };
    case 'wrong_plan': case 'wrong_user': return { type: 'error', text: 'Esta suscripción no corresponde al plan o a la persona: no se concedió acceso.' };
    default: return { type: 'info', text: 'Verificado.' };
  }
}

/** Resumen del barrido de conciliación. */
export function sweepMessage(r) {
  const parts = [];
  if (r.paid) parts.push(`${r.paid} pagado${r.paid === 1 ? '' : 's'}`);
  if (r.cancelled) parts.push(`${r.cancelled} cancelado${r.cancelled === 1 ? '' : 's'} (stock liberado)`);
  if (r.failed) parts.push(`${r.failed} rechazado${r.failed === 1 ? '' : 's'}`);
  if (r.errors) parts.push(`${r.errors} con error (reintentá)`);
  return parts.length ? `Conciliación: ${parts.join(', ')}.` : `Conciliación: nada pendiente (${r.checked ?? 0} pedidos revisados).`;
}

/**
 * Precio de venta suelta que escribe quien gestiona ("12,10") -> céntimos, o null si está vacío (= no se vende suelta).
 * @returns {{ ok: true, cents: number|null } | { ok: false, error: string }}
 */
export function parseClassPrice(input) {
  const text = String(input ?? '').trim();
  if (text === '') return { ok: true, cents: null };
  const cents = eurosToCents(text);
  if (cents === null || cents < 1 || cents > MAX_CLASS_PRICE_CENTS) {
    return { ok: false, error: 'Escribí un precio válido en euros (ej.: 12,50), o dejalo vacío para no vender la clase suelta.' };
  }
  return { ok: true, cents };
}
