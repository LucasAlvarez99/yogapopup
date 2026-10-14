import * as session from '../lib/session.js';
import { listTiers } from '../lib/api.js';
import { paymentsEnabled, page } from '../lib/env.js';
import { messageFor } from '../lib/errors.js';
import { el, icon, mount } from '../lib/dom.js';
import { sortTiers, tierBenefitLines, tierPriceLabel } from '../lib/tiers.js';
import { openAuth } from './auth-modal.js';
import { errorState } from './states.js';

/** Una tarjeta de nivel de la home: nombre, precio, lo que da (los videos suman) y el botón. Todo sale de la base. */
function tierCard(t) {
  const available = paymentsEnabled && t.plan_ready === true;
  const choose = el('button', {
    type: 'button', class: `btn ${available ? 'btn-brand' : 'btn-soft'} w-100`, 'data-choose-tier': String(t.tier), disabled: !available,
    title: available ? null : 'Pronto vas a poder suscribirte',
  }, available ? 'Suscribirme' : 'Próximamente');
  choose.addEventListener('click', () => {
    if (!session.isLoggedIn()) return openAuth({ message: 'Creá tu cuenta o iniciá sesión para suscribirte.' });
    location.href = `${page('cuenta.html')}#accSubscription`; // ahí están los botones de PayPal de cada nivel
  });
  return el('article', { class: 'tier-card tier-card-home', 'data-tier': String(t.tier) },
    el('h3', { class: 'tier-name', translate: 'no' }, t.name),
    el('p', { class: 'tier-price' }, tierPriceLabel(t.price_cents)),
    el('ul', { class: 'tier-lines' }, ...tierBenefitLines(t).map((line) => el('li', {}, icon('check2'), ' ', line))),
    t.benefits ? el('p', { class: 'tier-benefits' }, t.benefits) : null,
    choose);
}

/** Dibuja los niveles de suscripción en `box` (la sección #suscripciones de la home). */
export async function mountHomeTiers(box) {
  if (!box) return;
  box.setAttribute('aria-busy', 'true');
  try {
    const tiers = sortTiers(await listTiers());
    if (tiers.length === 0) {
      mount(box, el('p', { class: 'text-muted mb-0' }, 'Pronto vas a poder suscribirte.'));
    } else {
      mount(box, ...tiers.map(tierCard));
    }
  } catch (err) {
    mount(box, errorState(messageFor(err), () => mountHomeTiers(box)));
  }
  box.setAttribute('aria-busy', 'false');
}
