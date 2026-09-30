import { el, icon } from '../lib/dom.js';
import * as session from '../lib/session.js';
import { page } from '../lib/env.js';
import { openAuth } from './auth-modal.js';
import { toast } from './toast.js';

/**
 * Activa el ícono "Mi cuenta" del encabezado ([data-account-toggle]):
 *  - sin sesión  -> abre el modal de acceso
 *  - con sesión  -> menú con la videoteca, mi cuenta y cerrar sesión
 */
let popover = null;

function close() {
  popover?.remove();
  popover = null;
  document.querySelectorAll('[data-account-toggle]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

function open(anchor) {
  close();
  const { user, profile } = session.getState();
  const name = profile?.display_name || user.email;
  const items = [
    el('div', { class: 'yp-account-who' }, el('strong', {}, name), profile?.display_name ? el('small', {}, user.email) : null),
    el('a', { class: 'yp-account-item', href: page('videoteca.html'), role: 'menuitem' }, icon('collection-play'), 'Videoteca'),
    // El enlace a /interno (session.isDeveloper()) se añade cuando esa página exista: no se muestra
    // ningún enlace a una página que todavía no está.
    session.isOwner()
      ? el('a', { class: 'yp-account-item', href: page('panel.html'), role: 'menuitem' }, icon('kanban'), 'Panel de negocio')
      : null,
    el('button', {
      type: 'button', class: 'yp-account-item', role: 'menuitem',
      onclick: async () => {
        close();
        try { await session.signOut(); toast('Sesión cerrada.', { type: 'info', ms: 2500 }); } catch { toast('No se pudo cerrar la sesión.', { type: 'error' }); }
      },
    }, icon('box-arrow-right'), 'Cerrar sesión'),
  ];
  popover = el('div', { class: 'yp-account-menu', role: 'menu' }, ...items);
  document.body.append(popover);
  const r = anchor.getBoundingClientRect();
  popover.style.top = `${r.bottom + 8}px`;
  popover.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  anchor.setAttribute('aria-expanded', 'true');
  popover.querySelector('a,button')?.focus?.();
}

function paint() {
  const logged = session.isLoggedIn();
  document.querySelectorAll('[data-account-toggle]').forEach((b) => {
    b.classList.toggle('has-session', logged);
    b.setAttribute('aria-label', logged ? 'Mi cuenta (sesión iniciada)' : 'Iniciar sesión o crear cuenta');
    b.setAttribute('aria-haspopup', logged ? 'true' : 'dialog');
  });
  if (!logged) close();
}

export function initAccountMenu() {
  document.querySelectorAll('[data-account-toggle]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!session.isLoggedIn()) return void openAuth();
      if (popover) close(); else open(b);
    });
  });
  document.addEventListener('click', (e) => { if (popover && !popover.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  window.addEventListener('resize', close);
  session.onChange(paint);
  paint();
}
