import * as session from '../lib/session.js';
import { renderLayout } from './layout.js';
import { initAuthUi } from './auth-modal.js';
import { initAccountMenu } from './account-menu.js';
import { initCartUi } from './cart-drawer.js';
import { initLanguage } from './lang-switcher.js';

/** Arranque común de las páginas nuevas: encabezado/pie, idioma, sesión, modal de acceso, menú de cuenta y carrito. */
export async function boot(active) {
  renderLayout(active);
  initAuthUi();
  initAccountMenu();
  initCartUi();
  initLanguage();
  return session.init();
}
