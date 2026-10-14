import { adminClassPrices, adminListClasses, adminListOrders, adminListSubscriptions, adminSaveTier, adminSetClassPrice, listTiers, paypalReconcile } from '../lib/api.js';
import { parseTierDiscount, parseTierFreeClasses, parseTierPrice, parseTierText, tierName, tierPriceLabel, TIER_BENEFITS_MAX, TIER_NAME_MAX } from '../lib/tiers.js';
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

function subscriptionsTable(subs, tiers = []) {
  if (subs.length === 0) return el('p', { class: 'text-muted small' }, 'Todavía no hay suscripciones.');
  return el('div', { class: 'table-responsive' }, el('table', { class: 'table align-middle' },
    el('thead', {}, el('tr', {}, ...['Alta', 'Persona', 'Nivel', 'Estado', 'Acceso hasta', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...subs.map((s) => el('tr', {},
      el('td', {}, when(s.created_at)),
      el('td', { translate: 'no' }, person(s)),
      el('td', { translate: 'no' }, tierName(tiers, s.tier) || '—'),
      el('td', {}, badge(statusInfo(SUBSCRIPTION_STATUS, s.status))),
      el('td', {}, when(s.current_period_end)),
      el('td', { class: 'text-end' }, el('button', {
        type: 'button', class: 'btn btn-sm btn-outline-secondary',
        onclick: (e) => verify(e.currentTarget, { subscription_id: s.paypal_subscription_id }, 'Verificar'),
      }, 'Verificar')))))));
}

/** Descuento en puntos básicos -> lo que se escribe en el panel (500 -> "5", 750 -> "7,5"). */
const discountInput = (bps) => String((Number(bps) || 0) / 100).replace('.', ',');

/** Un nivel de suscripción: nombre, precio mensual, descuento, clases gratis y beneficios. Guardar un precio nuevo crea un plan nuevo en PayPal (lo hace el servidor). */
function tierEditor(t) {
  const name = el('input', { class: 'form-control form-control-sm', id: `tierName${t.tier}`, maxlength: TIER_NAME_MAX, value: t.name, 'aria-label': `Nombre del nivel ${t.tier}` });
  const price = el('input', { class: 'form-control form-control-sm', id: `tierPrice${t.tier}`, inputmode: 'decimal', value: centsToEurosInput(t.price_cents), 'aria-label': `Precio mensual del nivel ${t.tier} en euros` });
  const benefits = el('textarea', {
    class: 'form-control form-control-sm', id: `tierBenefits${t.tier}`, rows: 3, maxlength: TIER_BENEFITS_MAX,
    placeholder: 'Ej.: Todas las clases del nivel + una clase gratis al mes', 'aria-label': `Beneficios del nivel ${t.tier}`,
  }, t.benefits ?? '');
  const discount = el('input', { class: 'form-control form-control-sm', id: `tierDiscount${t.tier}`, inputmode: 'decimal', value: discountInput(t.discount_bps), placeholder: '0', 'aria-label': `Descuento en la tienda del nivel ${t.tier}, en porcentaje` });
  const freeClasses = el('input', { class: 'form-control form-control-sm', id: `tierFree${t.tier}`, inputmode: 'numeric', value: String(t.monthly_free_classes ?? 0), placeholder: '0', 'aria-label': `Clases virtuales gratis por mes del nivel ${t.tier}` });
  const save = el('button', { type: 'button', class: 'btn btn-sm btn-brand', id: `tierSave${t.tier}` }, 'Guardar');
  save.addEventListener('click', async () => {
    const text = parseTierText(name.value, benefits.value);
    if (!text.ok) return toast(text.error, { type: 'error' });
    const cents = parseTierPrice(price.value);
    if (!cents.ok) return toast(cents.error, { type: 'error' });
    const disc = parseTierDiscount(discount.value);
    if (!disc.ok) return toast(disc.error, { type: 'error' });
    const free = parseTierFreeClasses(freeClasses.value);
    if (!free.ok) return toast(free.error, { type: 'error' });
    save.disabled = true;
    try {
      const res = await adminSaveTier({ tier: t.tier, name: text.name, benefits: text.benefits, priceCents: cents.cents, discountBps: disc.bps, monthlyFreeClasses: free.count });
      toast(res.new_plan
        ? `Nivel guardado: desde ahora se cobra ${tierPriceLabel(cents.cents)}. Quienes ya están suscriptos conservan su precio actual.`
        : 'Nivel guardado.', { type: 'success' });
      if (isCurrent()) await load();
    } catch (err) {
      toast(messageFor(err), { type: 'error' });
      save.disabled = false;
    }
  });
  return el('div', { class: 'col-12 col-lg-4' }, el('div', { class: 'yp-card h-100', 'data-tier-editor': String(t.tier) },
    el('div', { class: 'd-flex justify-content-between align-items-center mb-2' },
      el('h3', { class: 'h6 m-0' }, `Nivel ${t.tier}`),
      el('span', { class: `badge text-bg-${t.plan_ready ? 'success' : 'warning'}` }, t.plan_ready ? 'Se puede contratar' : 'Guardalo para crear el plan')),
    el('label', { class: 'form-label small mb-1', for: name.id }, 'Nombre'), name,
    el('label', { class: 'form-label small mt-2 mb-1', for: price.id }, 'Precio mensual (€, IVA incluido)'), price,
    el('div', { class: 'row g-2 mt-0' },
      el('div', { class: 'col-6' }, el('label', { class: 'form-label small mt-2 mb-1', for: discount.id }, 'Descuento en la tienda (%)'), discount),
      el('div', { class: 'col-6' }, el('label', { class: 'form-label small mt-2 mb-1', for: freeClasses.id }, 'Clases gratis por mes'), freeClasses)),
    el('label', { class: 'form-label small mt-2 mb-1', for: benefits.id }, 'Otros beneficios (texto libre, se muestra al elegir el nivel)'), benefits,
    el('div', { class: 'text-end mt-3' }, save)));
}

function tiersSection(tiers) {
  if (tiers.length === 0) return el('p', { class: 'text-muted small' }, 'Los niveles todavía no están disponibles: falta aplicar la última migración de la base.');
  return el('div', { class: 'row g-3' }, ...tiers.map(tierEditor));
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
    const [orders, subs, classes, prices, tiers] = await Promise.all([adminListOrders(), adminListSubscriptions(), adminListClasses(), adminClassPrices(), listTiers()]);
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
      el('h2', { class: 'h5 mt-4' }, 'Planes de suscripción'),
      el('p', { class: 'small text-muted' }, 'Tres niveles mensuales. Si cambiás un precio, se crea un plan nuevo en PayPal: quienes ya están suscriptos siguen pagando el precio con el que se anotaron hasta que cancelen. En cada clase elegís en qué niveles se ve.'),
      tiersSection(tiers),
      el('h2', { class: 'h5 mt-4' }, 'Suscripciones'), subscriptionsTable(subs, tiers),
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
