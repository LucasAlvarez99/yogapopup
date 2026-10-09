import { listMyOrders } from '../lib/api.js';
import { describeOrder, partitionOrders } from '../lib/account-view.js';
import { messageFor } from '../lib/errors.js';
import { el, mount } from '../lib/dom.js';

function row(order) {
  const d = describeOrder(order);
  return el('li', { class: 'acc-row' },
    el('div', { class: 'acc-row-main' },
      el('div', { class: 'acc-row-title' }, el('span', { class: 'badge text-bg-light me-1' }, d.kind), d.summary),
      el('div', { class: 'acc-sub small text-muted' }, `${d.date} · ${d.total}`),
      d.status.note ? el('div', { class: 'acc-sub small text-muted' }, d.status.note) : null,
      d.refundNote ? el('div', { class: 'acc-sub small text-muted' }, d.refundNote) : null),
    el('div', { class: 'text-end' },
      el('span', { class: `badge text-bg-${d.status.tone}` }, d.status.label),
      d.classId ? el('div', {}, el('a', { class: 'small', href: `clase.html?id=${encodeURIComponent(d.classId)}` }, 'Ver clase')) : null));
}

/** "Mis compras" (Fase 24): pedidos de la tienda y clases sueltas con su estado. Los intentos sin completar quedan plegados. */
export function ordersCard() {
  const body = el('div', { 'aria-busy': 'true' }, el('p', { class: 'text-muted small' }, 'Cargando…'));
  const card = el('section', { class: 'yp-card', id: 'accOrders' }, el('h2', { class: 'yp-block-title' }, 'Mis compras'), body);
  (async () => {
    let parts;
    try { parts = partitionOrders(await listMyOrders()); }
    catch (err) { return mount(body, el('p', { class: 'text-danger small', role: 'alert' }, messageFor(err))); }
    body.setAttribute('aria-busy', 'false');
    if (parts.main.length === 0 && parts.incomplete.length === 0) {
      return mount(body, el('p', { class: 'text-muted' }, 'Todavía no hiciste compras.'),
        el('a', { class: 'btn btn-outline-brand btn-sm', href: 'tienda.html' }, 'Ir a la tienda'));
    }
    const incomplete = el('ul', { class: 'acc-list', id: 'accOrdersIncomplete', hidden: true }, ...parts.incomplete.map(row));
    const toggle = parts.incomplete.length
      ? el('button', {
        type: 'button', class: 'btn btn-link btn-sm px-0', 'aria-expanded': 'false',
        onclick: (e) => {
          const open = incomplete.hidden;
          incomplete.hidden = !open;
          e.currentTarget.setAttribute('aria-expanded', String(open));
          e.currentTarget.textContent = open ? 'Ocultar intentos sin completar' : `Ver intentos sin completar (${parts.incomplete.length})`;
        },
      }, `Ver intentos sin completar (${parts.incomplete.length})`)
      : null;
    mount(body,
      parts.main.length ? el('ul', { class: 'acc-list', id: 'accOrdersMain' }, ...parts.main.map(row)) : el('p', { class: 'text-muted' }, 'No tenés compras confirmadas.'),
      toggle, incomplete);
  })();
  return card;
}
