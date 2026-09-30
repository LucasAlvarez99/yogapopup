import * as session from '../lib/session.js';
import { renderLayout } from './layout.js';
import { initAuthUi } from './auth-modal.js';
import { initAccountMenu } from './account-menu.js';

/** Arranque común de las páginas nuevas: encabezado/pie, sesión, modal de acceso y menú de cuenta. */
export async function boot(active) {
  renderLayout(active);
  initAuthUi();
  initAccountMenu();
  return session.init();
}
