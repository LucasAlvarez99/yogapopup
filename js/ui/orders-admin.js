import { adminClassPrices, adminListClasses, adminListOrders, adminListSubscriptions, adminSetClassPrice, paypalReconcile } from '../lib/api.js';
import { messageFor } from '../lib/errors.js';
import { formatDate, formatPrice } from '../lib/format.js';
import { el, icon, mount } from '../lib/dom.js';
import { centsToEurosInput } from '../lib/product-form.js';
import {
  describeItems, ORDER_STATUS, parseClassPrice, reconcileMessage, reviewNoteText, shippingLines, statusInfo, SUBSCRIPTION_STATUS, sweepMessage,
} from '../lib/payments-view.js';
import { toast } from './toast.js';
import { emptyState, errorState, skeletonGrid } from './states.js';

/**
 * Pestaña "Pagos" del panel (Fase 22): pedidos, suscripciones, precios de las clases sueltas y "verificar de nuevo".
 * Solo muestra y dispara la conciliación: los cobros los registra el servidor tras consultar a PayPal.
 * La base (RLS) decide quién ve qué; esto solo ordena la interfaz.
 */
let root = null;
let isCurrent = () => true;

const badge = (info) => el('span', { class: `badge text-bg-${info.tone}` }, info.label);
const person = (row) => row.profiles?.display_name || 'Sin nombre';
const when = (iso) => (iso ? formatDate(iso) : '—');

async function verify(button, body, label) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = 'Verificando…';
  try {
    const res = await paypalReconcile(body);
    const msg = reconcileMessage(res.outcome ?? res.status);
    toast(msg.text, { type: msg.type });
    if (isCurrent()) await load();
  } catch (err) {
    toast(messageFor(err), { type: 'error' });
    button.disabled = false;
    button.textContent = old || label;
  }
}

function ordersTable(orders) {
  if (orders.length === 0) return emptyState('Todavía no hay pedidos', 'Cuando alguien compre, va a aparecer acá.');
  const rows = orders.map((o) => {
    const ship = shippingLines(o.shipping);
    const canVerify = o.status === 'created' || o.status === 'pending' || o.needs_review;
    return el('tr', { class: o.needs_review ? 'table-warning' : '', 'data-order-id': o.id },
      el('td', {}, when(o.created_at)),
      el('td', { translate: 'no' }, person(o)),
      el('td', {},
        el('div', { translate: 'no' }, describeItems(o.order_items)),
        o.kind === 'class' ? el('small', { class: 'text-muted' }, 'Clase suelta') : null,
        ship.length ? el('details', { class: 'small mt-1' }, el('summary', {}, 'Dirección de envío'), ...ship.map((l) => el('div', { translate: 'no' }, l))) : null,
        o.needs_review ? el('div', { class: 'small text-danger mt-1' }, icon('exclamation-triangle'), ` ${reviewNoteText(o.review_note)}`) : null),
      el('td', { class: 'text-nowrap' }, formatPrice(o.total_cents),
        o.refunded_cents > 0 ? el('div', { class: 'small text-muted' }, `Reembolsado: ${formatPrice(o.refunded_cents)}`) : null),
      el('td', {}, badge(statusInfo(ORDER_STATUS, o.status))),
      el('td', { class: 'text-end' }, canVerify
        ? el('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', onclick: (e) => verify(e.currentTarget, { order_id: o.id }, 'Verificar de nuevo') }, 'Verificar de nuevo')
        : null));
  });
  return el('div', { class: 'table-responsive' }, el('table', { class: 'table align-middle' },
    el('thead', {}, el('tr', {}, ...['Fecha', 'Persona', 'Pedido', 'Total', 'Estado', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows)));
}

function subscriptionsTable(subs) {
  if (subs.length === 0) return el('p', { class: 'text-muted small' }, 'Todavía no hay suscripciones.');
  return el('div', { class: 'table-responsive' }, el('table', { class: 'table align-middle' },
    el('thead', {}, el('tr', {}, ...['Alta', 'Persona', 'Estado', 'Acceso hasta', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...subs.map((s) => el('tr', {},
      el('td', {}, when(s.created_at)),
      el('td', { translate: 'no' }, person(s)),
      el('td', {}, badge(statusInfo(SUBSCRIPTION_STATUS, s.status))),
      el('td', {}, when(s.current_period_end)),
      el('td', { class: 'text-end' }, el('button', {
        type: 'button', class: 'btn btn-sm btn-outline-secondary',
        onclick: (e) => verify(e.currentTarget, { subscription_id: s.paypal_subscription_id }, 'Verificar'),
      }, 'Verificar')))))));
}

function priceRow(cls, cents) {
  const input = el('input', {
    class: 'form-control form-control-sm', style: 'max-width:9rem', inputmode: 'decimal', placeholder: 'No se vende suelta',
    value: centsToEurosInput(cents), 'aria-label': `Precio de ${cls.title} en euros`,
  });
  const save = el('button', { type: 'button', class: 'btn btn-sm btn-brand' }, 'Guardar');
  save.addEventListener('click', async () => {
    const parsed = parseClassPrice(input.value);
    if (!parsed.ok) return toast(parsed.error, { type: 'error' });
    save.disabled = true;
    try {
      await adminSetClassPrice(cls.id, parsed.cents);
      toast(parsed.cents === null ? 'La clase ya no se vende suelta.' : `Precio guardado: ${formatPrice(parsed.cents)} (IVA incluido).`, { type: 'success' });
    } catch (err) {
      toast(messageFor(err), { type: 'error' });
    } finally {
      save.disabled = false;
    }
  });
  return el('tr', {}, el('td', { translate: 'no' }, cls.title),
    el('td', {}, el('div', { class: 'd-flex gap-2 align-items-center' }, input, el('span', { class: 'small text-muted' }, '€ con IVA'))), el('td', { class: 'text-end' }, save));
}

function pricesTable(classes, prices) {
  const sellable = classes.filter((c) => c.access_level === 'restricted');
  if (sellable.length === 0) {
    return el('p', { class: 'text-muted small' }, 'Solo las clases con acceso "restringido" se pueden vender sueltas. Cambiá el acceso de una clase para ofrecerla.');
  }
  return el('div', { class: 'table-responsive' }, el('table', { class: 'table align-middle' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Clase restringida'), el('th', {}, 'Precio de venta suelta'), el('th', {}, ''))),
    el('tbody', {}, ...sellable.map((c) => priceRow(c, prices[c.id] ?? null)))));
}

async function load() {
  if (!root || !isCurrent()) return;
  mount(root, skeletonGrid(3));
  try {
    const [orders, subs, classes, prices] = await Promise.all([adminListOrders(), adminListSubscriptions(), adminListClasses(), adminClassPrices()]);
    if (!isCurrent()) return;
    const review = orders.filter((o) => o.needs_review).length;
    const sweep = el('button', { type: 'button', class: 'btn btn-sm btn-outline-brand' }, icon('arrow-repeat'), ' Conciliar pendientes');
    sweep.addEventListener('click', async () => {
      sweep.disabled = true;
      try {
        const r = await paypalReconcile({ sweep: true });
        toast(sweepMessage(r), { type: r.errors ? 'error' : 'success' });
        if (isCurrent()) await load();
      } catch (err) {
        toast(messageFor(err), { type: 'error' });
        sweep.disabled = false;
      }
    });
    mount(root,
      review > 0 ? el('div', { class: 'alert alert-warning', role: 'alert' }, icon('exclamation-triangle'), ` ${review === 1 ? '1 pedido necesita' : `${review} pedidos necesitan`} tu revisión (marcados en amarillo).`) : null,
      el('div', { class: 'd-flex justify-content-between align-items-center flex-wrap gap-2 mb-2' },
        el('h2', { class: 'h5 m-0' }, 'Pedidos'), sweep),
      el('p', { class: 'small text-muted' }, 'Los pedidos sin pagar liberan su stock solos pasada una hora. "Verificar de nuevo" consulta a PayPal y deja el pedido como corresponde.'),
      ordersTable(orders),
      el('h2', { class: 'h5 mt-4' }, 'Suscripciones'), subscriptionsTable(subs),
      el('h2', { class: 'h5 mt-4' }, 'Precio de las clases sueltas'),
      el('p', { class: 'small text-muted' }, 'Precio final con IVA incluido. Vacío = la clase solo se ve con suscripción. Cada cambio queda registrado.'),
      pricesTable(classes, prices));
  } catch (err) {
    if (isCurrent()) mount(root, errorState(messageFor(err), load));
  }
}

export function showOrdersAdmin(target, opts = {}) {
  root = target;
  isCurrent = opts.isCurrent ?? (() => true);
  return load();
}
