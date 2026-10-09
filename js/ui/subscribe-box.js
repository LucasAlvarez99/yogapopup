import { el, icon, mount } from '../lib/dom.js';
import { cfg, paymentsEnabled } from '../lib/env.js';
import { paypalActivateSubscription, paypalCreateSubscription } from '../lib/api.js';
import { AppError, messageFor } from '../lib/errors.js';
import { renderSubscriptionButtons } from '../lib/paypal.js';
import { toast } from './toast.js';

/** ¿Se ofrece la suscripción? Hay pagos configurados Y el sitio declaró el plan (PAYPAL.PLAN_LABEL). */
export const subscriptionOffered = () => paymentsEnabled && cfg.PAYPAL.PLAN_LABEL !== '';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Tras aprobar en PayPal, el servidor consulta a PayPal. PayPal puede tardar unos segundos en pasar la suscripción
 * de "pendiente" a "activa": se reintenta unas veces y, si no llega, el webhook la activa solo.
 * @returns {Promise<'active'|'pending'>}
 */
export async function confirmSubscription(subscriptionId, { tries = 4, delayMs = 2500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await paypalActivateSubscription(subscriptionId);
    if (res.status === 'active') return 'active';
    if (i < tries - 1) await wait(delayMs);
  }
  return 'pending';
}

/**
 * Botón de suscripción de PayPal. `onActive('active' | 'pending')` se llama cuando termina el alta.
 * Nunca decide nada por su cuenta: el plan lo fija el servidor y el acceso lo concede el servidor.
 */
export function subscribeBox({ onActive } = {}) {
  const status = el('p', { class: 'small text-muted mb-2', role: 'status' }, 'Cargando PayPal…');
  const slot = el('div', { class: 'pp-buttons' });
  const box = el('div', { class: 'pp-box' }, cfg.PAYPAL.PLAN_LABEL ? el('p', { class: 'fw-semibold mb-2' }, cfg.PAYPAL.PLAN_LABEL) : null, status, slot);

  const busy = (text) => { status.textContent = text; slot.style.opacity = text ? '.4' : ''; slot.style.pointerEvents = text ? 'none' : ''; };

  renderSubscriptionButtons(slot, {
    createSubscription: async () => (await paypalCreateSubscription()).subscription_id,
    onApprove: async (subscriptionId) => {
      busy('Confirmando tu suscripción…');
      try {
        const result = await confirmSubscription(subscriptionId);
        busy('');
        toast(result === 'active' ? '¡Listo! Tu suscripción está activa.' : 'Recibimos tu suscripción. Se activa en unos minutos.', { type: result === 'active' ? 'success' : 'info' });
        onActive?.(result);
      } catch (err) {
        busy('');
        toast(messageFor(err), { type: 'error' });
      }
    },
    onCancel: () => toast('Cancelaste el alta. No se te cobró nada.', { type: 'info' }),
    onError: (err) => toast(err instanceof AppError ? messageFor(err) : 'PayPal no pudo procesar la suscripción. Probá de nuevo.', { type: 'error' }),
  }).then(() => { status.textContent = ''; }).catch((err) => {
    mount(box, el('p', { class: 'text-danger small', role: 'alert' }, icon('exclamation-triangle'), ' ', messageFor(err)));
  });
  return box;
}
