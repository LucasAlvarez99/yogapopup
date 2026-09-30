import { el, icon } from '../lib/dom.js';
import { page } from '../lib/env.js';
import { SOCIAL_LINKS } from '../lib/social-links.js';

/** Encabezado y pie de las páginas nuevas: mismo marcado y clases que index.html. */
const NAV = [
  ['Inicio', 'index.html#inicio', 'inicio'],
  ['Cursos', 'index.html#cursos', 'cursos'],
  ['Clases', 'index.html#clases', 'clases'],
  ['Videoteca', 'videoteca.html', 'videoteca'],
  ['Merchandising', 'tienda.html', 'tienda'],
  ['Sobre nosotros', 'index.html#nosotros', 'nosotros'],
];

const brand = (cls = '') => el('a', { class: `brand ${cls}`.trim(), href: page('index.html'), 'aria-label': 'Yoga Pop Up' },
  el('span', { class: 'brand-mark' }, el('img', { src: page('assets/logo-claro.png'), alt: '', width: 360, height: 379 })),
  el('span', { class: 'brand-text' }, 'Yoga Pop Up'));

/** @param {string} active  'videoteca' | 'cuenta' | ... */
export function renderLayout(active) {
  const header = document.getElementById('siteHeader');
  if (header) {
    const navItem = ([label, href, key]) => el('li', { class: 'nav-item' },
      el('a', { class: `nav-link${key === active ? ' active' : ''}`, href: page(href), 'aria-current': key === active ? 'page' : null }, label));

    const menuButton = el('button', {
      class: 'icon-btn d-lg-none', type: 'button', 'data-bs-toggle': 'collapse', 'data-bs-target': '#mainMenu',
      'aria-controls': 'mainMenu', 'aria-expanded': 'false', 'aria-label': 'Abrir menú',
    }, icon('list'));
    const accountLink = el('a', { class: 'icon-btn', href: page('cuenta.html'), 'aria-label': 'Mi cuenta', 'data-account-toggle': true }, icon('person'));
    const actions = el('div', { class: 'd-flex align-items-center gap-1 order-lg-3' }, menuButton, accountLink);
    const menu = el('div', { class: 'collapse navbar-collapse order-lg-2', id: 'mainMenu' },
      el('ul', { class: 'navbar-nav mx-lg-auto gap-lg-2' }, ...NAV.map(navItem)));

    header.className = 'site-header sticky-top';
    header.replaceChildren(el('nav', { class: 'navbar navbar-expand-lg' },
      el('div', { class: 'container-xl' }, brand('navbar-brand'), actions, menu)));
  }

  const footer = document.getElementById('siteFooter');
  if (footer) {
    const col = (title, label, items) => el('nav', { class: 'col-6 col-lg-3', 'aria-label': label },
      el('h4', {}, title),
      el('ul', {}, ...items.map(([text, href]) => el('li', {}, el('a', { href: page(href) }, text)))));
    const socials = el('div', { class: 'col-lg-3' },
      el('h4', {}, 'Seguinos'),
      el('div', { class: 'socials' }, ...SOCIAL_LINKS.map(({ label, href, iconName }) =>
        el('a', { href, target: '_blank', rel: 'noopener', 'aria-label': label }, icon(iconName)))));
    footer.className = 'site-footer';
    footer.replaceChildren(el('div', { class: 'container-xl' },
      el('div', { class: 'row g-4 align-items-start' },
        el('div', { class: 'col-lg-6' }, brand(),
          el('p', { class: 'footer-note' }, 'Yoga & Conexión. Te acompañamos a habitar tu cuerpo con presencia, libertad y disfrute.')),
        col('Yoga Pop Up', 'Navegación', NAV.slice(0, 4)),
        col('Más', 'Más', NAV.slice(4)),
        socials),
      el('p', { class: 'copyright' }, `© ${new Date().getFullYear()} Yoga Pop Up. Todos los derechos reservados.`)));
  }
}
