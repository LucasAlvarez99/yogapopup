import { el, icon, mount } from '../lib/dom.js';
import { formatPrice } from '../lib/format.js';
import { paypalCaptureOrder, paypalCreateOrder } from '../lib/api.js';
import { cartToItems, classifyPaymentError, outcomeMessage } from '../lib/checkout.js';
import { AppError, messageFor } from '../lib/errors.js';
import { renderCheckoutButtons } from '../lib/paypal.js';
import { openAuth } from './auth-modal.js';
import { toast } from './toast.js';

/**
 * Pantalla de pago dentro del carrito: resumen + botones de PayPal.
 *   validation   resultado de validateCart (ya sin problemas)
 *   onBack()     volver al carrito
 *   onStale()    el carrito cambió en la base (stock, precio): hay que volver a leerlo
 *   onDone(status, kind)   el servidor confirmó ('paid') o dejó pendiente ('pending') el pago
 * El total mostrado es informativo: el cobro real lo calcula el servidor con los precios de la base.
 */
export function checkoutView({ validation, onBack, onStale, onDone }) {
  const status = el('p', { class: 'cart-note', role: 'status', 'aria-live': 'polite' }, 'Cargando PayPal…');
  const slot = el('div', { class: 'pp-buttons' });
  const back = el('button', { type: 'button', class: 'btn btn-soft w-100 mt-2', onclick: onBack }, icon('arrow-left'), ' Volver al carrito');

  const busy = (text) => {
    status.textContent = text;
    slot.style.opacity = text ? '.4' : '';
    slot.style.pointerEvents = text ? 'none' : '';
    back.disabled = !!text;
  };

  const lines = validation.lines.map((l) => el('li', { class: 'd-flex justify-content-between gap-2 py-1' },
    el('span', { translate: 'no' }, `${l.qty} × ${l.product.title}${l.size ? ` (talle ${l.size})` : ''}`),
    el('span', {}, formatPrice(l.lineCents))));

  function fail(err) {
    busy('');
    const kind = classifyPaymentError(err);
    if (kind === 'stale') { toast(messageFor(err), { type: 'error' }); return onStale(); }
    if (kind === 'login') return openAuth({ message: 'Tu sesión venció. Iniciá sesión para pagar.' });
    toast(err instanceof AppError ? messageFor(err) : 'PayPal no pudo procesar el pago. Probá de nuevo.', { type: 'error' });
  }

  renderCheckoutButtons(slot, {
    // El navegador solo manda QUÉ compra; precio, IVA y stock los resuelve el servidor (y reserva el stock).
    createOrder: async () => (await paypalCreateOrder(cartToItems(validation))).paypal_order_id,
    onApprove: async (orderId) => {
      busy('Confirmando tu pago…');
      try {
        const res = await paypalCaptureOrder(orderId);
        onDone(res.status, res.kind);
      } catch (err) {
        busy('');
        // Si PayPal ya cobró pero no pudimos confirmarlo, el webhook lo registra: que NO pague de nuevo.
        const unsure = !(err instanceof AppError) || ['network', 'internal_error', 'payment_provider_error', 'payment_review'].includes(err.code);
        if (unsure) toast('No pudimos confirmar tu pago. Si PayPal te lo cobró, lo registramos en unos minutos: no pagues de nuevo.', { type: 'info', ms: 10000 });
        else fail(err);
      }
    },
    onCancel: () => toast('Cancelaste el pago. No se te cobró nada.', { type: 'info' }),
    onError: fail,
  }).then(() => { status.textContent = ''; }).catch((err) => {
    status.textContent = '';
    mount(slot, el('p', { class: 'text-danger small', role: 'alert' }, icon('exclamation-triangle'), ' ', messageFor(err)));
  });

  return el('div', { class: 'cart-checkout' },
    el('h3', { class: 'h6' }, 'Resumen del pedido'),
    el('ul', { class: 'list-unstyled small mb-2' }, ...lines),
    el('div', { class: 'subtotal' }, el('span', {}, 'Total'), el('strong', { id: 'checkoutTotal' }, formatPrice(validation.subtotalCents))),
    validation.taxCents > 0 ? el('p', { class: 'cart-tax' }, `IVA incluido: ${formatPrice(validation.taxCents)}`) : null,
    el('p', { class: 'cart-note' }, icon('truck'), ' PayPal te pedirá la dirección de envío.'),
    status, slot, back);
}

/** Pantalla final tras el pago. */
export function doneView(status, kind, onClose) {
  const msg = outcomeMessage(status, kind);
  return el('div', { class: 'cart-empty', role: 'status' },
    icon(status === 'paid' ? 'check-circle' : 'hourglass-split'),
    el('h3', { class: 'h6' }, msg.title), el('p', {}, msg.text),
    el('button', { type: 'button', class: 'btn btn-brand btn-sm', onclick: onClose }, 'Cerrar'));
}
