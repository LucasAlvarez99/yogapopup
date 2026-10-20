import { el } from '../lib/dom.js';

/**
 * Aviso que va junto a los botones de pago: enlaza las condiciones de compra y, si lo que se paga es contenido digital
 * (videos o suscripciones), avisa de que el acceso empieza de inmediato y por eso no hay desistimiento (art. 103.m TRLGDCU).
 * El enlace abre otra pestaña para no perder el carrito ni el pago en curso.
 *   digital   hay videos o una suscripción
 *   physical  hay productos físicos
 * Es solo un aviso: no concede ni bloquea nada (el acceso lo decide siempre el servidor al confirmar el pago).
 */
export function purchaseNotice({ digital = false, physical = false } = {}) {
  return el('p', { class: 'legal-note', role: 'note' },
    'Al pagar aceptas las ',
    el('a', { href: 'condiciones.html', target: '_blank', rel: 'noopener' }, 'condiciones de compra'),
    digital ? el('span', {}, 'En videos y suscripciones, el acceso empieza de inmediato y, una vez iniciado, pierdes el derecho de desistimiento.') : null,
    physical ? el('span', {}, 'En los productos físicos tienes 14 días para desistir.') : null);
}
