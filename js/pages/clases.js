import * as session from '../lib/session.js';
import { supabase } from '../lib/supabase.js';
import * as api from '../lib/api.js';
import { messageFor } from '../lib/errors.js';
import { page } from '../lib/env.js';
import { el, icon, mount } from '../lib/dom.js';
import { boot } from '../ui/boot.js';
import { toast } from '../ui/toast.js';
import { openAuth } from '../ui/auth-modal.js';
import { mountTeachersAgenda } from '../components/teachers-agenda.js';
import { classShopCard } from '../components/class-shop-card.js';
import { addVideoToCart, cartStore } from '../ui/cart-drawer.js';
import { accessFromEntitlements } from '../lib/class-shop.js';
import { emptyState, errorState, skeletonGrid } from '../ui/states.js';
import { tierName } from '../lib/tiers.js';

/**
 * Clases: la agenda de clases en vivo (profesores + calendario) y "Mis videos": los videos que la persona compró
 * (30 días cada uno) y los que ya venció, que puede volver a comprar. El acceso real lo decide siempre el servidor.
 */
const agendaBox = document.getElementById('classesAgenda');
const videosBox = document.getElementById('myVideos');

function loadAgenda() {
  if (!supabase) {
    mount(agendaBox, emptyState('Clases en vivo en preparación', 'Falta configurar la conexión con Supabase (js/config.js).'));
    return agendaBox.setAttribute('aria-busy', 'false');
  }
  mountTeachersAgenda(agendaBox, {
    api,
    auth: {
      isLoggedIn: session.isLoggedIn,
      openLogin: () => openAuth(),
      onChange: (fn) => session.onChange((_s, event) => { if (event !== 'SESSION_REFRESHED') fn(); }),
    },
    notify: toast,
  });
}

let mine = null; // { access, active: [], expired: [], tierLabel }

function section(title, note, cards) {
  return el('div', { class: 'mb-5' },
    el('h3', { class: 'h5 mb-1' }, title),
    note ? el('p', { class: 'text-muted small mb-3' }, note) : null,
    el('div', { class: 'row g-4' }, ...cards));
}

function renderVideos() {
  videosBox.setAttribute('aria-busy', 'false');
  const { access, active, expired, tierLabel } = mine;
  const inCart = new Set(cartStore.get().items.map((i) => i.id));
  const card = (c) => classShopCard(c, { access, inCart: inCart.has(c.id), onAdd: addVideoToCart });
  const parts = [];
  if (tierLabel) {
    parts.push(el('p', { class: 'yp-card d-flex gap-2 align-items-center mb-4', role: 'note' }, icon('stars'),
      el('span', {}, `Tu suscripción ${tierLabel} incluye videos sin comprarlos uno por uno. `,
        el('a', { href: page('videoteca.html') }, 'Verlos en la videoteca'))));
  }
  if (active.length) parts.push(section('Para ver ahora', 'Cada video comprado se ve durante 30 días.', active.map(card)));
  if (expired.length) parts.push(section('Vencieron', 'Pasaron los 30 días. Si querés verlos otra vez, volvé a comprarlos.', expired.map(card)));
  if (!active.length && !expired.length) {
    parts.push(emptyState('Todavía no compraste videos', 'Los videos que compres, uno por uno o junto con productos, aparecen acá durante 30 días.',
      el('a', { class: 'btn btn-brand btn-sm', href: page('videoteca.html') }, 'Ir a la videoteca')));
  }
  mount(videosBox, ...parts);
}

async function loadVideos() {
  videosBox.setAttribute('aria-busy', 'true');
  if (!supabase) return mount(videosBox, emptyState('Videos en preparación', 'Falta configurar la conexión con Supabase (js/config.js).'));
  if (!session.isLoggedIn()) {
    mine = null;
    videosBox.setAttribute('aria-busy', 'false');
    return mount(videosBox, emptyState('Iniciá sesión para ver tus videos', 'Acá aparecen los videos que compraste y cuántos días te quedan.',
      el('button', { type: 'button', class: 'btn btn-brand btn-sm', id: 'loginCta', onclick: () => openAuth() }, 'Iniciar sesión')));
  }
  mount(videosBox, skeletonGrid(3));
  try {
    const rows = await api.listMyEntitlements();
    const access = accessFromEntitlements(rows);
    const ids = [...new Set(rows.filter((r) => r.scope === 'class' && r.class_id).map((r) => r.class_id))];
    const classes = ids.length ? await api.listShopClasses({ withTier: true }).then((all) => all.filter((c) => ids.includes(c.id))) : [];
    const active = classes.filter((c) => access.classes.has(c.id));
    const expired = classes.filter((c) => !access.classes.has(c.id));
    // Primero los que vencen antes (los que más urgen).
    const until = (c) => Date.parse(access.classes.get(c.id) ?? '') || Infinity;
    active.sort((a, b) => until(a) - until(b));
    let tierLabel = '';
    if (access.tier) tierLabel = tierName(await api.listTiers().catch(() => []), access.tier) || `nivel ${access.tier}`;
    else if (access.allAccess) tierLabel = 'actual';
    mine = { access, active, expired, tierLabel };
    renderVideos();
  } catch (err) {
    mount(videosBox, errorState(messageFor(err), loadVideos));
    videosBox.setAttribute('aria-busy', 'false');
  }
}

await boot('clases');
session.onChange((_s, event) => { if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') loadVideos(); });
cartStore.subscribe(() => { if (mine) renderVideos(); });
loadAgenda();
await loadVideos();
