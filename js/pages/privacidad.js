import { cfg } from '../lib/env.js';
import { el } from '../lib/dom.js';
import { boot } from '../ui/boot.js';
import { isEmail, PRIVACY_VERSION } from '../lib/legal.js';

/**
 * Política de privacidad: el texto es estático (privacidad.html); aquí solo se rellenan los datos del responsable
 * desde js/config.js (LEGAL), SIEMPRE como texto (nunca como HTML). Lo que falte se muestra como "pendiente de
 * completar" a la vista, para que no pase desapercibido antes de publicar.
 */
const pending = () => el('em', { class: 'yp-pending' }, '[pendiente de completar]');

for (const node of document.querySelectorAll('[data-legal]')) {
  const value = cfg.LEGAL[node.dataset.legal];
  if (!value) node.replaceChildren(pending());
  else if (node.dataset.legal === 'EMAIL' && isEmail(value)) node.replaceChildren(el('a', { href: `mailto:${value}` }, value));
  else node.textContent = value;
}

for (const node of document.querySelectorAll('[data-privacy-version]')) node.textContent = PRIVACY_VERSION;
for (const node of document.querySelectorAll('[data-privacy-date]')) {
  node.textContent = new Date(`${PRIVACY_VERSION}T12:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

boot(null);
