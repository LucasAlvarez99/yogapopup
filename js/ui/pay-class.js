import { el, icon, mount } from '../lib/dom.js';
import { formatPrice } from '../lib/format.js';
import { paypalCaptureOrder, paypalCreateOrder } from '../lib/api.js';
import { classToItems, outcomeMessage } from '../lib/checkout.js';
import { AppError, messageFor } from '../lib/errors.js';
import { renderCheckoutButtons } from '../lib/paypal.js';
import { toast } from './toast.js';

/**
 * Compra de UNA clase suelta con PayPal. `offer` = { price_cents } leído de la base solo para mostrarlo: el cobro
 * usa el precio que lee el servidor al crear el pedido (si cambió mientras tanto, PayPal muestra el nuevo importe).
 * `onPurchased()` se llama cuando el servidor confirmó el pago y concedió el acceso.
 */
export function buyClassBox({ classId, offer, onPurchased }) {
  const status = el('p', { class: 'small mb-2', role: 'status' }, 'Cargando PayPal…');
  const slot = el('div', { class: 'pp-buttons' });
  const box = el('div', { class: 'pp-box' },
    el('p', { class: 'fw-semibold mb-1' }, 'Comprar esta clase'),
    el('p', { class: 'mb-2' }, el('strong', {}, formatPrice(offer.price_cents)), el('span', { class: 'small ms-1' }, '· IVA incluido · acceso de por vida a esta clase')),
    status, slot);

  const busy = (text) => { status.textContent = text; slot.style.opacity = text ? '.4' : ''; slot.style.pointerEvents = text ? 'none' : ''; };

  renderCheckoutButtons(slot, {
    createOrder: async () => (await paypalCreateOrder(classToItems(classId))).paypal_order_id,
    onApprove: async (orderId) => {
      busy('Confirmando tu pago…');
      try {
        const res = await paypalCaptureOrder(orderId);
        busy('');
        const msg = outcomeMessage(res.status, 'class');
        toast(msg.title, { type: msg.type });
        if (res.status === 'paid') onPurchased?.();
        else mount(box, el('p', { role: 'status' }, icon('hourglass-split'), ' ', msg.text));
      } catch (err) {
        busy('');
        // Si PayPal ya cobró pero no pudimos confirmarlo, el webhook lo registra solo: se avisa que NO hay que pagar de nuevo.
        const unsure = !(err instanceof AppError) || ['network', 'internal_error', 'payment_provider_error', 'payment_review'].includes(err.code);
        toast(unsure ? 'No pudimos confirmar tu pago. Si PayPal te lo cobró, lo registramos en unos minutos: no pagues de nuevo.' : messageFor(err), { type: unsure ? 'info' : 'error', ms: 9000 });
      }
    },
    onCancel: () => toast('Cancelaste el pago. No se te cobró nada.', { type: 'info' }),
    onError: (err) => toast(err instanceof AppError ? messageFor(err) : 'PayPal no pudo procesar el pago. Probá de nuevo.', { type: 'error' }),
  }).then(() => { status.textContent = ''; }).catch((err) => {
    mount(box, el('p', { class: 'text-danger small', role: 'alert' }, icon('exclamation-triangle'), ' ', messageFor(err)));
  });
  return box;
}
