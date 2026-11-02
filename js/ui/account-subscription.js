import { getMySubscription, listTiers, paypalCancelSubscription } from '../lib/api.js';
import { tierName } from '../lib/tiers.js';
import { describeSubscription } from '../lib/account-view.js';
import { paymentsEnabled } from '../lib/env.js';
import { messageFor } from '../lib/errors.js';
import { el, mount } from '../lib/dom.js';
import { toast } from './toast.js';
import { subscriptionOffered, tierPicker } from './subscribe-box.js';

/** Ventana con los planes de suscripción (la misma lista y el mismo pago con PayPal de la home). Se arma al abrir y se descarta al cerrar. */
function openPlans(onActive) {
  if (!window.bootstrap?.Modal) { location.href = 'index.html#suscripciones'; return; }
  const body = el('div', { class: 'modal-body' });
  const modal = el('div', { class: 'modal fade yp-plans', tabindex: -1, 'aria-labelledby': 'plansTitle', 'aria-hidden': 'true' },
    el('div', { class: 'modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg' },
      el('div', { class: 'modal-content' },
        el('div', { class: 'modal-header' },
          el('h2', { class: 'modal-title h5', id: 'plansTitle' }, 'Suscripciones'),
          el('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'modal', 'aria-label': 'Cerrar' })),
        body)));
  document.body.append(modal);
  const bs = window.bootstrap.Modal.getOrCreateInstance(modal);
  modal.addEventListener('hidden.bs.modal', () => { bs.dispose(); modal.remove(); });
  mount(body, tierPicker({ onActive: (result) => { bs.hide(); onActive?.(result); } }));
  bs.show();
}

const tierLine = (sub, rows) => {
  const name = tierName(rows, sub?.tier);
  return name ? el('p', { class: 'small mb-1' }, 'Nivel: ', el('strong', { translate: 'no' }, name)) : null;
};

/**
 * "Mi suscripción" (Fases 19-20 y 25): plan, próximo cobro y cancelar. Cancelar NO corta el acceso:
 * dura hasta el final del período ya pagado.
 */
export function subscriptionCard() {
  const body = el('div', { 'aria-busy': 'true' }, el('p', { class: 'text-muted small' }, 'Cargando…'));
  const card = el('section', { class: 'yp-card', id: 'accSubscription' }, el('h2', { class: 'yp-block-title' }, 'Mi suscripción'), body);

  async function load() {
    let sub;
    let tierRows = [];
    try { [sub, tierRows] = await Promise.all([getMySubscription(), listTiers().catch(() => [])]); }
    catch (err) { return mount(body, el('p', { class: 'text-danger small', role: 'alert' }, messageFor(err))); }
    body.setAttribute('aria-busy', 'false');
    const v = describeSubscription(sub);
    const plansButton = () => (subscriptionOffered()
      ? el('button', { type: 'button', class: 'btn btn-brand btn-sm', id: 'viewPlans', onclick: () => openPlans(() => load()) }, 'Ver suscripciones')
      : el('p', { class: 'small text-muted mb-0' }, paymentsEnabled ? 'Pronto vas a poder suscribirte.' : 'Las suscripciones llegan muy pronto.'));
    // Sin suscripción (nunca tuvo o ya terminó): solo el aviso y un botón; los planes se ven en una ventana aparte.
    const emptyState = () => el('div', { 'data-state': v.state },
      el('p', { class: 'mb-3' }, el('strong', {}, v.headline)), plansButton());
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
    if (v.state === 'none' || v.state === 'ended') return mount(body, emptyState());
    mount(body,
      el('p', { class: v.details.length ? 'mb-1' : 'text-muted', 'data-state': v.state }, el('strong', {}, v.headline)),
      v.canCancel || v.state === 'cancelled' ? tierLine(sub, tierRows) : null,
      ...v.details.map((d) => el('p', { class: 'small text-muted mb-1' }, d)),
      cancel, v.canSubscribe ? plansButton() : null);
  }
  load();
  return card;
}
