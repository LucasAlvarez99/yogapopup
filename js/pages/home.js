import * as session from '../lib/session.js';
import { supabase } from '../lib/supabase.js';
import { listPublishedClasses } from '../lib/api.js';
import { messageFor } from '../lib/errors.js';
import { mount } from '../lib/dom.js';
import { initAuthUi } from '../ui/auth-modal.js';
import { initAccountMenu } from '../ui/account-menu.js';
import { classCard } from '../components/class-card.js';
import { emptyState, errorState } from '../ui/states.js';
import { page } from '../lib/env.js';
import { el } from '../lib/dom.js';

/** Home: activa la cuenta y carga las últimas clases publicadas (datos reales, sin tarjetas de ejemplo). */
initAuthUi();
initAccountMenu();
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
