import * as session from '../lib/session.js';
import { supabase } from '../lib/supabase.js';
import { listActiveProducts, listPublishedClasses } from '../lib/api.js';
import { messageFor } from '../lib/errors.js';
import { mount } from '../lib/dom.js';
import { initAuthUi } from '../ui/auth-modal.js';
import { initAccountMenu } from '../ui/account-menu.js';
import { classCard } from '../components/class-card.js';
import { productCard } from '../components/product-card.js';
import { addToCart, initCartUi } from '../ui/cart-drawer.js';
import { emptyState, errorState } from '../ui/states.js';
import { page } from '../lib/env.js';
import { el } from '../lib/dom.js';

/** Home: activa la cuenta y el carrito, y carga clases y productos reales (sin tarjetas de ejemplo). */
initAuthUi();
initAccountMenu();
initCartUi();
session.init();

const box = document.getElementById('homeVideos');

async function loadVideos() {
  if (!box) return;
  box.setAttribute('aria-busy', 'true');
  if (!supabase) {
    mount(box, el('div', { class: 'col-12' }, emptyState('Videoteca en preparación', 'Falta configurar la conexión con Supabase (js/config.js).')));
    box.setAttribute('aria-busy', 'false');
    return;
  }
  try {
    const items = await listPublishedClasses({ limit: 3 });
    if (items.length === 0) {
      mount(box, el('div', { class: 'col-12' }, emptyState('Muy pronto, nuevas clases', 'Estamos preparando la videoteca. Vuelve en unos días.',
        el('a', { class: 'btn btn-outline-brand btn-sm', href: page('videoteca.html') }, 'Ir a la videoteca'))));
    } else {
      mount(box, ...items.map((c) => classCard(c)));
    }
  } catch (err) {
    mount(box, el('div', { class: 'col-12' }, errorState(messageFor(err), loadVideos)));
  }
  box.setAttribute('aria-busy', 'false');
}
loadVideos();

const shopBox = document.getElementById('homeProducts');

/** Los primeros productos activos de la tienda (mismo orden que tienda.html). */
async function loadProducts() {
  if (!shopBox) return;
  shopBox.setAttribute('aria-busy', 'true');
  if (!supabase) {
    mount(shopBox, el('div', { class: 'col-12' }, emptyState('Tienda en preparación', 'Falta configurar la conexión con Supabase (js/config.js).')));
    shopBox.setAttribute('aria-busy', 'false');
    return;
  }
  try {
    const items = (await listActiveProducts()).slice(0, 8);
    if (items.length === 0) {
      mount(shopBox, el('div', { class: 'col-12' }, emptyState('Muy pronto, nuevos productos', 'Estamos preparando la tienda. Vuelve en unos días.')));
    } else {
      mount(shopBox, ...items.map((p) => productCard(p, { onAdd: addToCart })));
    }
  } catch (err) {
    mount(shopBox, el('div', { class: 'col-12' }, errorState(messageFor(err), loadProducts)));
  }
  shopBox.setAttribute('aria-busy', 'false');
}
loadProducts();
