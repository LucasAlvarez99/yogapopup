import { el, icon, mount } from '../lib/dom.js';
import { cartCount, createCartStore, limitFor, validateCart } from '../lib/cart.js';
import { addFeedback, badgeText, canIncrease, isRemovableOnly, lineNotice } from '../lib/cart-view.js';
import { formatPrice } from '../lib/format.js';
import { cartOptionsFor } from '../lib/sizes.js';
import { listActiveProducts } from '../lib/api.js';
import { messageFor } from '../lib/errors.js';
import { page } from '../lib/env.js';
import { supabase } from '../lib/supabase.js';
import { toast } from './toast.js';
import { errorState } from './states.js';

/**
 * Carrito de la interfaz (Fase 16): ícono con conteo en el encabezado + cajón lateral.
 *
 * El estado vive en `cartStore` (Fase 15: solo {id, qty} en localStorage). Los precios y el stock se piden a la base
 * cada vez que se abre el cajón y se validan con `validateCart`: lo guardado en el navegador nunca decide un precio.
 * El pago llega en las Fases 17-18, por eso "Finalizar compra" queda deshabilitado.
 */
export const cartStore = createCartStore({ target: window });

let ready = false;
let drawer = null; // <aside id="cartDrawer">
let titleCount = null;
let body = null;
let isOpen = false;
let products = null; // productos activos de la última lectura (null = todavía no hay)
let seenIds = new Set(); // ids del carrito que ya se pidieron a la base
let loading = false;
let failure = null;
let generation = 0; // para descartar respuestas viejas si se pide de nuevo

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
  const p = line.product;
  const title = p ? p.title : 'Producto no disponible';
  const notice = lineNotice(line);
  const removableOnly = isRemovableOnly(line);

  const thumb = el('div', { class: 'cart-thumb bg-mint' },
    p?.image_url ? el('img', { src: p.image_url, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }) : icon('bag-heart'));
  const heading = p
    ? el('a', { href: `${page('producto.html')}?id=${encodeURIComponent(p.id)}` }, title)
    : title;
  const info = el('div', { class: 'cart-info' },
    el('h3', {}, heading),
    line.size ? el('small', { class: 'cart-size' }, `Talle: ${line.size}`) : null,
    notice ? el('small', { class: 'cart-issue' }, notice) : null,
    removableOnly ? null : el('strong', {}, formatPrice(line.lineCents)));
  const label = line.size ? `${title} (talle ${line.size})` : title;
  const remove = el('button', {
    type: 'button', class: 'cart-remove', 'aria-label': `Quitar ${label}`, onclick: () => cartStore.remove(line.id, line.variant),
  }, icon('x-lg'));

  const qty = removableOnly ? null : el('div', { class: 'qty', role: 'group', 'aria-label': `Cantidad de ${label}` },
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

  return el('li', { class: `cart-item${removableOnly ? ' is-broken' : ''}`, 'data-product-id': line.id, 'data-variant-id': line.variant ?? null }, thumb, info, remove, qty);
}

function emptyView() {
  return el('div', { class: 'cart-empty' },
    icon('bag'), el('p', {}, 'Tu carrito está vacío.'),
    el('a', { class: 'btn btn-outline-brand btn-sm', href: page('tienda.html') }, 'Ir a la tienda'));
}

function footer(validation) {
  const fix = validation.issues > 0
    ? el('div', { class: 'cart-alert', role: 'alert' },
      icon('exclamation-circle'),
      el('span', {}, 'Algunos productos cambiaron desde que los agregaste.'),
      el('button', { type: 'button', class: 'btn btn-brand btn-sm', onclick: () => cartStore.replace(validation.fixedCart) }, 'Actualizar carrito'))
    : null;
  return el('div', { class: 'cart-footer mt-auto' },
    fix,
    el('div', { class: 'subtotal' }, el('span', {}, 'Subtotal'), el('strong', { id: 'cartSubtotal' }, formatPrice(validation.subtotalCents))),
    validation.taxCents > 0
      ? el('p', { class: 'cart-tax', id: 'cartTax' }, `IVA incluido: ${formatPrice(validation.taxCents)} · sin IVA: ${formatPrice(validation.netCents)}`)
      : null,
    // El pago online llega en las Fases 17-18: hasta entonces no se simula una compra que no existe.
    el('button', { type: 'button', class: 'btn btn-brand w-100 mb-2', disabled: true, title: 'El pago online llega pronto' },
      'Finalizar compra ', icon('arrow-right')),
    el('p', { class: 'cart-note' }, 'El pago online llega muy pronto.'),
    el('button', { type: 'button', class: 'btn btn-soft w-100', onclick: () => cartStore.clear() }, 'Vaciar carrito'),
    cartStore.persistent ? null : el('p', { class: 'cart-note' }, 'Este navegador no permite guardar el carrito: se perderá al cerrar la pestaña.'));
}

function renderDrawer() {
  if (!drawer) return;
  const cart = cartStore.get();
  titleCount.textContent = String(cartCount(cart));
  body.setAttribute('aria-busy', String(loading));

  if (cart.items.length === 0) return mount(body, emptyView());
  if (products === null && loading) return mount(body, el('p', { class: 'cart-note', role: 'status' }, 'Cargando tu carrito…'));
  if (products === null) return mount(body, errorState(failure ? messageFor(failure) : 'No pudimos cargar tu carrito.', refresh));

  const validation = validateCart(cart, products);
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
  try {
    next = await listActiveProducts();
  } catch (err) {
    error = err;
  }
  if (mine !== generation) return; // llegó una respuesta más nueva
  loading = false;
  products = error ? null : next; // si falló, no se muestran precios viejos
  failure = error;
  seenIds = new Set(cartStore.get().items.map((i) => i.id));
  renderDrawer();
}

function onCartChange() {
  renderBadge();
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
    refresh();
  });
  drawer.addEventListener('hidden.bs.offcanvas', () => {
    isOpen = false;
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
