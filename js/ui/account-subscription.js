import { getMySubscription, paypalCancelSubscription } from '../lib/api.js';
import { describeSubscription } from '../lib/account-view.js';
import { paymentsEnabled } from '../lib/env.js';
import { messageFor } from '../lib/errors.js';
import { el, mount } from '../lib/dom.js';
import { toast } from './toast.js';
import { subscribeBox, subscriptionOffered } from './subscribe-box.js';

/**
 * "Mi suscripción" (Fases 19-20 y 25): plan, próximo cobro y cancelar. Cancelar NO corta el acceso:
 * dura hasta el final del período ya pagado.
 */
export function subscriptionCard() {
  const body = el('div', { 'aria-busy': 'true' }, el('p', { class: 'text-muted small' }, 'Cargando…'));
  const card = el('section', { class: 'yp-card', id: 'accSubscription' }, el('h2', { class: 'yp-block-title' }, 'Mi suscripción'), body);

  async function load() {
    let sub;
    try { sub = await getMySubscription(); }
    catch (err) { return mount(body, el('p', { class: 'text-danger small', role: 'alert' }, messageFor(err))); }
    body.setAttribute('aria-busy', 'false');
    const v = describeSubscription(sub);
    const offer = () => (subscriptionOffered()
      ? subscribeBox({ onActive: () => load() })
      : el('p', { class: 'small text-muted mb-0' }, paymentsEnabled ? 'Pronto vas a poder suscribirte.' : 'Las suscripciones llegan muy pronto.'));
    const cancel = v.canCancel
      ? el('button', {
        type: 'button', class: 'btn btn-sm btn-outline-secondary', id: 'cancelSubscription',
        onclick: async (e) => {
          const btn = e.currentTarget;
          const until = sub?.current_period_end ? new Date(sub.current_period_end).toLocaleDateString('es-ES') : 'el final del período pagado';
          if (!confirm(`¿Cancelar tu suscripción? Mantenés el acceso hasta ${until} y después no se te vuelve a cobrar.`)) return;
          btn.disabled = true;
          try { await paypalCancelSubscription(); toast('Cancelaste tu suscripción.', { type: 'info' }); await load(); }
          catch (err) { toast(messageFor(err), { type: 'error' }); btn.disabled = false; }
        },
      }, 'Cancelar suscripción')
      : null;
    mount(body,
      el('p', { class: v.details.length ? 'mb-1' : 'text-muted', 'data-state': v.state }, el('strong', {}, v.headline)),
      ...v.details.map((d) => el('p', { class: 'small text-muted mb-1' }, d)),
      cancel, v.canSubscribe ? offer() : null);
  }
  load();
  return card;
}
