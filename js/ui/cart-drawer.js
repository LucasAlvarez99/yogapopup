import { el, icon, mount } from '../lib/dom.js';
import { cartCount, createCartStore, limitFor, qtyOf, validateCart } from '../lib/cart.js';
import { addFeedback, badgeText, canIncrease, isRemovableOnly, isVideoLine, lineNotice } from '../lib/cart-view.js';
import { accessFromEntitlements, classOffer } from '../lib/class-shop.js';
import { formatPrice } from '../lib/format.js';
import { cartOptionsFor } from '../lib/sizes.js';
import { getMyActiveTier, getShippingCents, listActiveProducts, listClassesByIds, listMyEntitlements, listShopClasses, listTiers } from '../lib/api.js';
import { discountedCents, discountLabel, tierDiscountBps } from '../lib/tiers.js';
import { messageFor } from '../lib/errors.js';
import { page, paymentsEnabled } from '../lib/env.js';
import { canCheckout } from '../lib/checkout.js';
import * as session from '../lib/session.js';
import { supabase } from '../lib/supabase.js';
import { toast } from './toast.js';
import { openAuth } from './auth-modal.js';
import { checkoutView, doneView } from './checkout-view.js';
import { askShipTo } from './shipping-modal.js';
import { errorState } from './states.js';

/**
 * Carrito de la interfaz (Fase 16): ícono con conteo en el encabezado + cajón lateral.
 *
 * El estado vive en `cartStore` (Fase 15: solo {id, qty} en localStorage). Los precios y el stock se piden a la base
 * cada vez que se abre el cajón y se validan con `validateCart`: lo guardado en el navegador nunca decide un precio.
 * Pago (Fases 17-18): con PayPal configurado (js/config.js > PAYPAL.CLIENT_ID), "Finalizar compra" abre dentro del cajón la
 * pantalla de pago (ui/checkout-view.js). Sin configurar, queda deshabilitado: no se simula una compra que no existe.
 */
export const cartStore = createCartStore({ target: window });

let ready = false;
let drawer = null; // <aside id="cartDrawer">
let titleCount = null;
let body = null;
let isOpen = false;
let products = null; // productos activos de la última lectura (null = todavía no hay)
let videos = []; // videos del carrito (con precio) de la última lectura
let ownedVideoIds = []; // videos del carrito a los que la persona ya tiene acceso
let seenIds = new Set(); // ids del carrito que ya se pidieron a la base
let loading = false;
let failure = null;
let generation = 0; // para descartar respuestas viejas si se pide de nuevo
let discountBps = 0; // descuento de la suscripción de la persona (solo para MOSTRAR: el servidor calcula el real)
let mode = 'cart'; // 'cart' | 'checkout' | 'done': mientras se paga, el cajón NO se redibuja (destruiría los botones de PayPal)

/**
 * Agrega una unidad de `product` al carrito y avisa con un mensaje (o el motivo por el que no se pudo).
 * Si el producto tiene talles, `variant` es el talle elegido: su stock es el que limita la cantidad.
 */
export function addToCart(product, variant = null) {
  const before = cartStore.get();
  const options = variant ? cartOptionsFor(variant) : { stock: product.stock };
  const after = cartStore.add(product.id, 1, options);
  const { kind, text } = addFeedback(before, after, product, { variant: variant?.id ?? null, size: variant?.size ?? null, stock: options.stock });
  toast(text, { type: kind });
  if (kind === 'success' && !cartStore.persistent) {
    toast('Este navegador no permite guardar el carrito: se perderá al cerrar la pestaña.', { type: 'info', ms: 7000 });
  }
}

/**
 * Agrega un VIDEO al carrito (una sola unidad: se ve durante 30 días). Avisa con un mensaje; si ya estaba, lo dice.
 * `c` es la fila de classes (solo se usa el título para el aviso: el precio lo lee el servidor al cobrar).
 */
export function addVideoToCart(c) {
  if (qtyOf(cartStore.get(), c.id) > 0) {
    toast(`«${c.title}» ya está en tu carrito.`, { type: 'info' });
    return false;
  }
  const after = cartStore.addClass(c.id);
  if (qtyOf(after, c.id) === 0) {
    toast('El carrito no admite más productos distintos. Quita alguno para agregar este.', { type: 'info' });
    return false;
  }
  toast(`«${c.title}» se agregó al carrito.`, { type: 'success' });
  if (!cartStore.persistent) toast('Este navegador no permite guardar el carrito: se perderá al cerrar la pestaña.', { type: 'info', ms: 7000 });
  return true;
}

// ------------------------------------------------------------------ ícono del encabezado

function renderBadge() {
  const count = cartCount(cartStore.get());
  const text = badgeText(count);
  document.querySelectorAll('[data-cart-count]').forEach((b) => {
    b.textContent = text;
    b.hidden = text === '';
  });
  document.querySelectorAll('[data-cart-toggle]').forEach((b) => {
    b.setAttribute('aria-label', count > 0 ? `Abrir carrito (${count} ${count === 1 ? 'unidad' : 'unidades'})` : 'Abrir carrito');
  });
}

// ------------------------------------------------------------------ cajón

function lineItem(line) {
  const video = isVideoLine(line);
  const p = video ? line.item : line.product;
  const title = p ? p.title : (video ? 'Video no disponible' : 'Producto no disponible');
  const notice = lineNotice(line);
  const removableOnly = isRemovableOnly(line);

  const thumb = el('div', { class: 'cart-thumb bg-mint' },
    (video ? p?.thumbnail_url : p?.image_url) ? el('img', { src: video ? p.thumbnail_url : p.image_url, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }) : icon(video ? 'play-circle' : 'bag-heart'));
  const heading = p
    ? el('a', { href: video ? `${page('clase.html')}?id=${encodeURIComponent(p.id)}` : `${page('producto.html')}?id=${encodeURIComponent(p.id)}` }, title)
    : title;
  const info = el('div', { class: 'cart-info' },
    el('h3', {}, heading),
    line.size ? el('small', { class: 'cart-size' }, `Talle: ${line.size}`) : null,
    video && line.status === 'ok' ? el('small', { class: 'cart-size' }, icon('play-circle'), ' Video · se ve durante 30 días') : null,
    notice ? el('small', { class: 'cart-issue' }, notice) : null,
    removableOnly ? null : el('strong', {}, formatPrice(line.lineCents)));
  const label = line.size ? `${title} (talle ${line.size})` : title;
  const remove = el('button', {
    type: 'button', class: 'cart-remove', 'aria-label': `Quitar ${label}`, onclick: () => cartStore.remove(line.id, line.variant),
  }, icon('x-lg'));

  const qty = (removableOnly || video) ? null : el('div', { class: 'qty', role: 'group', 'aria-label': `Cantidad de ${label}` },
    el('button', {
      type: 'button', 'aria-label': 'Una unidad menos', disabled: line.qty <= 1,
      onclick: () => cartStore.setQty(line.id, line.qty - 1, { stock: line.stock, variant: line.variant }),
    }, icon('dash')),
    el('span', { 'aria-live': 'polite' }, String(line.qty)),
    el('button', {
      type: 'button', 'aria-label': 'Una unidad más', disabled: !canIncrease(line),
      title: canIncrease(line) ? null : (limitFor(line.stock) > 0 ? 'Ya tienes el máximo disponible' : null),
      onclick: () => cartStore.setQty(line.id, line.qty + 1, { stock: line.stock, variant: line.variant }),
    }, icon('plus')));

  return el('li', { class: `cart-item${removableOnly ? ' is-broken' : ''}`, 'data-product-id': line.id, 'data-variant-id': line.variant ?? null, 'data-kind': video ? 'video' : 'product' }, thumb, info, remove, qty);
}

function emptyView() {
  return el('div', { class: 'cart-empty' },
    icon('bag'), el('p', {}, 'Tu carrito está vacío.'),
    el('div', { class: 'd-flex gap-2 justify-content-center flex-wrap' },
      el('a', { class: 'btn btn-outline-brand btn-sm', href: page('tienda.html') }, 'Ir a la tienda'),
      el('a', { class: 'btn btn-outline-brand btn-sm', href: page('videoteca.html') }, 'Ir a la videoteca')));
}

/** Descuento de la suscripción: se calcula por unidad, igual que el servidor, pero el importe final lo confirma PayPal. */
function discountRows(validation) {
  if (discountBps <= 0 || validation.subtotalCents <= 0) return null;
  const total = validation.lines.reduce((sum, l) => sum + discountedCents(l.unitCents, discountBps) * l.qty, 0);
  if (total >= validation.subtotalCents) return null;
  return el('div', { id: 'cartDiscountBox' },
    el('div', { class: 'subtotal text-success' },
      el('span', {}, `Descuento por tu suscripción (${discountLabel(discountBps)})`),
      el('strong', { id: 'cartDiscount' }, `-${formatPrice(validation.subtotalCents - total)}`)),
    el('div', { class: 'subtotal' }, el('span', {}, 'Total estimado'), el('strong', { id: 'cartTotalEstimated' }, formatPrice(total))));
}

function footer(validation) {
  const fix = validation.issues > 0
    ? el('div', { class: 'cart-alert', role: 'alert' },
      icon('exclamation-circle'),
      el('span', {}, 'Algo cambió desde que lo agregaste (un producto o un video).'),
      el('button', { type: 'button', class: 'btn btn-brand btn-sm', onclick: () => cartStore.replace(validation.fixedCart) }, 'Actualizar carrito'))
    : null;
  return el('div', { class: 'cart-footer mt-auto' },
    fix,
    el('div', { class: 'subtotal' }, el('span', {}, 'Subtotal'), el('strong', { id: 'cartSubtotal' }, formatPrice(validation.subtotalCents))),
    discountRows(validation),
    validation.taxCents > 0
      ? el('p', { class: 'cart-tax', id: 'cartTax' }, `IVA incluido: ${formatPrice(validation.taxCents)} · sin IVA: ${formatPrice(validation.netCents)}`)
      : null,
    validation.hasProducts ? el('p', { class: 'cart-note' }, icon('truck'), ' Todos nuestros productos se envían a domicilio.') : null,
    validation.hasClasses ? el('p', { class: 'cart-note' }, icon('play-circle'), ' Los videos se activan apenas se confirma el pago y los ves durante 30 días.') : null,
    paymentsEnabled
      ? el('button', {
        type: 'button', class: 'btn btn-brand w-100 mb-2', id: 'cartCheckout', disabled: !canCheckout(validation),
        title: canCheckout(validation) ? null : 'Actualizá tu carrito para poder pagar', onclick: () => startCheckout(validation),
      }, 'Finalizar compra ', icon('arrow-right'))
      // Sin PayPal configurado no se simula una compra que no existe.
      : el('button', { type: 'button', class: 'btn btn-brand w-100 mb-2', disabled: true, title: 'El pago online llega pronto' },
        'Finalizar compra ', icon('arrow-right')),
    paymentsEnabled ? null : el('p', { class: 'cart-note' }, 'El pago online llega muy pronto.'),
    el('button', { type: 'button', class: 'btn btn-soft w-100', onclick: () => cartStore.clear() }, 'Vaciar carrito'),
    cartStore.persistent ? null : el('p', { class: 'cart-note' }, 'Este navegador no permite guardar el carrito: se perderá al cerrar la pestaña.'));
}

async function startCheckout(validation) {
  if (!session.isLoggedIn()) return openAuth({ message: 'Iniciá sesión para pagar tu pedido.' });
  // Con productos físicos: primero el pop up con el domicilio (se guarda en el pedido) y el costo de envío vigente.
  let shipTo = null;
  let shippingCents = 0;
  if (validation.hasProducts) {
    try { shippingCents = await getShippingCents(); } catch (err) { return toast(messageFor(err), { type: 'error' }); }
    shipTo = await askShipTo({ email: session.getState().user?.email ?? '' });
    if (!shipTo) return; // lo cerró sin completar: sigue en el carrito
  }
  showCheckout(validation, shipTo, shippingCents);
}

function showCheckout(validation, shipTo, shippingCents) {
  mode = 'checkout';
  mount(body, checkoutView({
    validation, shipTo, shippingCents,
    onEditShipTo: async () => {
      const next = await askShipTo({ email: session.getState().user?.email ?? '' });
      if (next) showCheckout(validation, next, shippingCents);
    },
    onBack: backToCart,
    onStale: () => { backToCart(); refresh(); }, // el stock o un precio cambió: se vuelve a leer la base
    onDone: (status, kind) => finishCheckout(status, kind, validation.hasClasses && validation.hasProducts),
  }));
}

function backToCart() {
  mode = 'cart';
  renderDrawer();
}

function finishCheckout(status, kind, withVideos = false) {
  mode = 'done';
  // Pagado o a la espera de PayPal: el pedido ya existe en el servidor, el carrito local se vacía.
  if (status === 'paid' || status === 'pending') cartStore.clear();
  mount(body, doneView(status, kind, withVideos, () => {
    window.bootstrap?.Offcanvas.getInstance(drawer)?.hide();
    backToCart();
  }));
}

function renderDrawer() {
  if (!drawer) return;
  const cart = cartStore.get();
  titleCount.textContent = String(cartCount(cart));
  if (mode !== 'cart') return;
  body.setAttribute('aria-busy', String(loading));

  if (cart.items.length === 0) return mount(body, emptyView());
  if (products === null && loading) return mount(body, el('p', { class: 'cart-note', role: 'status' }, 'Cargando tu carrito…'));
  if (products === null) return mount(body, errorState(failure ? messageFor(failure) : 'No pudimos cargar tu carrito.', refresh));

  const validation = validateCart(cart, products, { classes: videos, ownedIds: ownedVideoIds });
  mount(body, el('ul', { class: 'cart-list', id: 'cartList' }, ...validation.lines.map(lineItem)), footer(validation));
}

/** Lee los productos activos de la base (precio y stock reales) y vuelve a dibujar. */
async function refresh() {
  if (!supabase) {
    failure = new Error('Falta configurar la conexión con Supabase (js/config.js).');
    products = null;
    return renderDrawer();
  }
  const mine = ++generation;
  loading = true;
  failure = null;
  renderDrawer();
  let next = null;
  let error = null;
  let nextDiscount = 0;
  let nextVideos = [];
  let nextOwned = [];
  try {
    next = await listActiveProducts();
    const videoIds = cartStore.get().items.filter((i) => i.t === 'c').map((i) => i.id);
    if (videoIds.length) nextVideos = await listClassesByIds(videoIds);
  } catch (err) {
    error = err;
  }
  // Videos que ya tiene (compra vigente o suscripción que los cubre): se avisan y no se cobran dos veces.
  if (!error && nextVideos.length && session.isLoggedIn()) {
    try {
      const access = accessFromEntitlements(await listMyEntitlements());
      const full = new Map((await listShopClasses({ withTier: true })).map((c) => [c.id, c]));
      nextOwned = nextVideos.filter((v) => ['owned', 'included'].includes(classOffer(full.get(v.id) ?? v, access))).map((v) => v.id);
    } catch { nextOwned = []; }
  }
  // El descuento es un aviso: si no se puede leer, el carrito se muestra igual (sin descuento).
  if (!error && session.isLoggedIn()) {
    try {
      const tier = await getMyActiveTier();
      if (tier) nextDiscount = tierDiscountBps(await listTiers(), tier);
    } catch { nextDiscount = 0; }
  }
  if (mine !== generation) return; // llegó una respuesta más nueva
  discountBps = nextDiscount;
  videos = error ? [] : nextVideos;
  ownedVideoIds = nextOwned;
  loading = false;
  products = error ? null : next; // si falló, no se muestran precios viejos
  failure = error;
  seenIds = new Set(cartStore.get().items.map((i) => i.id));
  renderDrawer();
}

function onCartChange() {
  renderBadge();
  if (mode !== 'cart') return; // pagando: no se toca la pantalla de pago
  if (!isOpen) return renderDrawer();
  // Con el cajón abierto: si apareció un producto que todavía no se pidió, se vuelve a leer; si no, solo se redibuja.
  if (!loading && cartStore.get().items.some((i) => !seenIds.has(i.id))) return refresh();
  renderDrawer();
}

function buildDrawer() {
  drawer = document.getElementById('cartDrawer');
  if (!drawer) {
    drawer = el('aside', { id: 'cartDrawer' });
    document.body.append(drawer);
  }
  drawer.className = 'offcanvas offcanvas-end cart-drawer';
  drawer.setAttribute('tabindex', '-1');
  drawer.setAttribute('aria-labelledby', 'cartTitle');
  titleCount = el('span', { id: 'cartTitleCount' }, '0');
  body = el('div', { class: 'offcanvas-body d-flex flex-column', 'aria-live': 'polite' });
  drawer.replaceChildren(
    el('div', { class: 'offcanvas-header' },
      el('h2', { class: 'offcanvas-title', id: 'cartTitle' }, 'Tu carrito (', titleCount, ')'),
      el('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'offcanvas', 'aria-label': 'Cerrar' })),
    body);
  drawer.addEventListener('show.bs.offcanvas', () => {
    isOpen = true;
    mode = 'cart';
    refresh();
  });
  drawer.addEventListener('hidden.bs.offcanvas', () => {
    isOpen = false;
    mode = 'cart'; // al cerrar y abrir de nuevo se vuelve al carrito (un pago a medias se libera solo en el servidor)
  });
}

/** Activa el ícono (conteo) y el cajón del carrito. Se puede llamar más de una vez. */
export function initCartUi() {
  if (ready) return;
  ready = true;
  buildDrawer();
  renderBadge();
  renderDrawer();
  cartStore.subscribe(onCartChange);
}
