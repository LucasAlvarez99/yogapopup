import * as session from '../lib/session.js';
import { supabase } from '../lib/supabase.js';
import { listActiveProducts, listPublishedClasses } from '../lib/api.js';
import { messageFor } from '../lib/errors.js';
import { initAuthUi, openAuth } from '../ui/auth-modal.js';
import { initAccountMenu } from '../ui/account-menu.js';
import { initLanguage } from '../ui/lang-switcher.js';
import * as api from '../lib/api.js';
import { toast } from '../ui/toast.js';
import { mountTeachersAgenda } from '../components/teachers-agenda.js';
import { classCard } from '../components/class-card.js';
import { productCard } from '../components/product-card.js';
import { addToCart, initCartUi } from '../ui/cart-drawer.js';
import { emptyState, errorState } from '../ui/states.js';
import { loadPublicTestimonials, mountTestimonialForm } from '../ui/testimonials.js';
import { page } from '../lib/env.js';
import { el, mount } from '../lib/dom.js';

/** Home: activa la cuenta y el carrito, y carga cursos (= videos de R2, tabla `classes`) y productos reales (sin tarjetas de ejemplo). */
initAuthUi();
initAccountMenu();
initCartUi();
initLanguage();
session.init();

const box = document.getElementById('homeVideos');

async function loadVideos() {
  if (!box) return;
  box.setAttribute('aria-busy', 'true');
  if (!supabase) {
    mount(box, el('div', { class: 'col-12' }, emptyState('Cursos en preparación', 'Falta configurar la conexión con Supabase (js/config.js).')));
    box.setAttribute('aria-busy', 'false');
    return;
  }
  try {
    const items = await listPublishedClasses({ limit: 3 });
    if (items.length === 0) {
      mount(box, el('div', { class: 'col-12' }, emptyState('Muy pronto, nuevos cursos', 'Estamos preparando los cursos. Vuelve en unos días.',
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

// Practicá acompañado: carrusel de profesores + agenda de clases en vivo (datos reales; sin tarjetas de ejemplo).
const agendaBox = document.getElementById('homeAgenda');
if (agendaBox) {
  if (!supabase) {
    mount(agendaBox, emptyState('Clases en vivo en preparación', 'Falta configurar la conexión con Supabase (js/config.js).'));
    agendaBox.setAttribute('aria-busy', 'false');
  } else {
    mountTeachersAgenda(agendaBox, {
      api,
      auth: {
        isLoggedIn: session.isLoggedIn,
        openLogin: () => openAuth(),
        // Al iniciar o cerrar sesión se vuelve a pedir la agenda (para marcar "Reservada"); un refresco de token no.
        onChange: (fn) => session.onChange((_s, event) => { if (event !== 'SESSION_REFRESHED') fn(); }),
      },
      notify: toast,
    });
  }
}

// Comentarios de la comunidad (Fases 26-27): los aprobados reemplazan a las tarjetas de ejemplo; el formulario pide sesión.
loadPublicTestimonials(document.getElementById('homeTestimonials'));
mountTestimonialForm(document.getElementById('testimonialForm'), {});
