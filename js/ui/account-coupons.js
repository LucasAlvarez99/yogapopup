import { claimFreeClassCoupons, liveAgenda, listMyFreeClassCoupons, redeemFreeClassCoupon } from '../lib/api.js';
import { couponEligibleSessions, describeCoupons } from '../lib/account-view.js';
import { arDay, arTime } from '../lib/agenda.js';
import { messageFor } from '../lib/errors.js';
import { el, icon, mount } from '../lib/dom.js';
import { toast } from './toast.js';

const DAYS_AHEAD = 60;

/**
 * "Mi clase virtual gratis": el cupón del mes de los niveles con clases gratis (hoy el 3). Se emite solo al entrar acá
 * (la base no duplica) y se canjea reservando una clase virtual de la agenda. Lo que no se usa en el mes se pierde.
 * La tarjeta queda oculta si la persona no tiene un nivel con clases gratis.
 */
export function couponsCard() {
  const body = el('div', { 'aria-busy': 'true' }, el('p', { class: 'text-muted small' }, 'Cargando…'));
  const card = el('section', { class: 'yp-card', id: 'accCoupons', hidden: true }, el('h2', { class: 'yp-block-title' }, 'Mi clase virtual gratis'), body);

  async function pickSession(coupon, slot) {
    mount(slot, el('p', { class: 'small text-muted mb-0', role: 'status' }, 'Buscando clases virtuales…'));
    let sessions;
    try {
      const now = new Date();
      sessions = couponEligibleSessions(await liveAgenda({ from: now.toISOString(), to: new Date(now.getTime() + DAYS_AHEAD * 86_400_000).toISOString() }));
    } catch (err) { return mount(slot, el('p', { class: 'text-danger small mb-0', role: 'alert' }, messageFor(err))); }
    if (sessions.length === 0) {
      return mount(slot, el('p', { class: 'small text-muted mb-0' }, 'Todavía no hay clases virtuales con lugar en los próximos días. Vuelve a mirar pronto: tu cupón vale hasta fin de mes.'));
    }
    mount(slot, el('ul', { class: 'acc-list', id: 'couponSessions' }, ...sessions.map((s) => {
      const when = new Date(s.starts_at);
      const use = el('button', { type: 'button', class: 'btn btn-sm btn-brand', 'data-session': s.id }, 'Reservar gratis');
      use.addEventListener('click', async () => {
        use.disabled = true;
        try {
          await redeemFreeClassCoupon(coupon.id, s.id);
          toast('¡Listo! Reservaste tu clase virtual gratis.', { type: 'success' });
          setTimeout(() => location.reload(), 900); // "Mis próximas clases" también se actualiza
        } catch (err) {
          toast(messageFor(err), { type: 'error' });
          use.disabled = false;
        }
      });
      return el('li', { class: 'acc-row' },
        el('div', { class: 'acc-row-main' },
          el('div', { class: 'acc-row-title', translate: 'no' }, s.title),
          el('div', { class: 'acc-sub small text-muted' }, `${arDay(when)} · ${arTime(when)}`)),
        el('div', { class: 'text-end' }, use));
    })));
  }

  (async () => {
    let coupons;
    try {
      await claimFreeClassCoupons().catch(() => 0); // si la base todavía no tiene la migración, simplemente no hay cupón
      coupons = describeCoupons(await listMyFreeClassCoupons());
    } catch { return; } // la tarjeta queda oculta: un cupón que no se puede leer no debe ensuciar la cuenta
    if (coupons.length === 0) return;
    card.hidden = false;
    body.setAttribute('aria-busy', 'false');
    mount(body, ...coupons.map((c) => {
      if (c.state === 'used') {
        return el('p', { class: 'mb-1', 'data-state': 'used' }, icon('check-circle'), ' Ya usaste tu clase virtual gratis de este mes. El mes que viene tienes otra.');
      }
      const slot = el('div', { class: 'mt-2' });
      const open = el('button', { type: 'button', class: 'btn btn-brand btn-sm', id: 'useCoupon', onclick: (e) => { e.currentTarget.hidden = true; pickSession(c, slot); } }, 'Usar mi clase gratis');
      return el('div', { 'data-state': 'available' },
        el('p', { class: 'mb-1' }, icon('gift'), ' ', el('strong', {}, 'Tienes 1 clase virtual gratis este mes.')),
        el('p', { class: 'small text-muted mb-2' }, `Puedes usarla hasta el ${c.until}. Si no la usas, se pierde: no se acumula para el mes siguiente.`),
        open, slot);
    }));
  })();
  return card;
}
