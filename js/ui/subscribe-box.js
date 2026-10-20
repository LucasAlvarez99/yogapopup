import { el, icon, mount } from '../lib/dom.js';
import { paymentsEnabled } from '../lib/env.js';
import { listTiers, paypalActivateSubscription, paypalCreateSubscription } from '../lib/api.js';
import { sellableTiers, tierBenefitLines, tierPriceLabel } from '../lib/tiers.js';
import { AppError, messageFor } from '../lib/errors.js';
import { renderSubscriptionButtons } from '../lib/paypal.js';
import { toast } from './toast.js';
import { purchaseNotice } from './legal-notice.js';

/** ¿Se ofrece la suscripción? Con pagos configurados sí; qué niveles se pueden contratar lo dice la base (ver tierPicker). */
export const subscriptionOffered = () => paymentsEnabled;

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
 * Botón de suscripción de PayPal para UN nivel. `onActive('active' | 'pending')` se llama cuando termina el alta.
 * Nunca decide nada por su cuenta: el plan (y su precio) lo fija el servidor según el nivel y el acceso lo concede el servidor.
 */
export function subscribeBox({ tier, onActive } = {}) {
  const status = el('p', { class: 'small text-muted mb-2', role: 'status' }, 'Cargando PayPal…');
  const slot = el('div', { class: 'pp-buttons' });
  const box = el('div', { class: 'pp-box' }, status, slot);

  const busy = (text) => { status.textContent = text; slot.style.opacity = text ? '.4' : ''; slot.style.pointerEvents = text ? 'none' : ''; };

  renderSubscriptionButtons(slot, {
    createSubscription: async () => (await paypalCreateSubscription(tier)).subscription_id,
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
    onError: (err) => toast(err instanceof AppError ? messageFor(err) : 'PayPal no pudo procesar la suscripción. Prueba de nuevo.', { type: 'error' }),
  }).then(() => { status.textContent = ''; }).catch((err) => {
    mount(box, el('p', { class: 'text-danger small', role: 'alert' }, icon('exclamation-triangle'), ' ', messageFor(err)));
  });
  return box;
}

/**
 * Los niveles que se pueden contratar, uno al lado del otro. Al elegir uno aparecen los botones de PayPal de ESE nivel
 * (con "Elegir otro nivel" para volver). Cambiar de nivel = cancelar la suscripción actual y contratar otra.
 *   allowedTiers  niveles de la clase que se quiere ver (si se conocen): solo se ofrecen esos
 */
export function tierPicker({ onActive, allowedTiers = null } = {}) {
  const box = el('div', { class: 'tier-picker', id: 'tierPicker', 'aria-busy': 'true' }, el('p', { class: 'small text-muted mb-0', role: 'status' }, 'Cargando suscripciones…'));
  // Se avisa SIEMPRE, antes de elegir: sin cuenta de PayPal no se puede pagar la suscripción.
  const paypalNotice = () => el('p', { class: 'tier-notice-inline', role: 'note' }, icon('paypal'), ' ', el('strong', {}, 'Necesitas una cuenta de PayPal para suscribirte.'),
    ' Por ahora es el único medio de pago de las suscripciones.');
  let tiers = [];

  const card = (t, children) => el('div', { class: 'tier-card', 'data-tier': String(t.tier) },
    el('h3', { class: 'tier-name', translate: 'no' }, t.name),
    el('p', { class: 'tier-price' }, tierPriceLabel(t.price_cents)),
    el('ul', { class: 'tier-lines' }, ...tierBenefitLines(t).map((line) => el('li', {}, icon('check2'), ' ', line))),
    t.benefits ? el('p', { class: 'tier-benefits' }, t.benefits) : null,
    ...children);

  function showList() {
    mount(box, paypalNotice(), el('div', { class: 'tier-grid' }, ...tiers.map((t) => card(t, [
      el('button', { type: 'button', class: 'btn btn-brand btn-sm w-100', 'data-choose-tier': String(t.tier), onclick: () => showPay(t) }, 'Elegir'),
    ]))));
  }
  function showPay(t) {
    mount(box,
      paypalNotice(),
      card(t, [subscribeBox({ tier: t.tier, onActive })]),
      purchaseNotice({ digital: true }),
      el('button', { type: 'button', class: 'btn btn-link btn-sm px-0 mt-2', id: 'tierBack', onclick: showList }, 'Elegir otro nivel'));
  }

  listTiers().then((rows) => {
    tiers = sellableTiers(rows, allowedTiers);
    box.setAttribute('aria-busy', 'false');
    if (tiers.length === 0) return mount(box, el('p', { class: 'small text-muted mb-0' }, 'Pronto vas a poder suscribirte.'));
    if (tiers.length === 1) return showPay(tiers[0]);
    showList();
  }).catch((err) => {
    box.setAttribute('aria-busy', 'false');
    mount(box, el('p', { class: 'text-danger small mb-0', role: 'alert' }, icon('exclamation-triangle'), ' ', messageFor(err)));
  });
  return box;
}
