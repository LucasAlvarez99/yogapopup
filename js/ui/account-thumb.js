import { el } from '../lib/dom.js';

/**
 * Miniatura cuadrada de una compra o de un video en curso (como en un historial de compras). Si la foto no carga,
 * se cambia sola por la predeterminada. `more` > 0 agrega una marca "+N" (pedido con varias líneas).
 * @param {{ src: string, fallback: string, kind?: 'product'|'class', more?: number }} t
 */
export function thumb({ src, fallback, kind = 'product', more = 0 }) {
  const img = el('img', { src, alt: '', loading: 'lazy', width: 64, height: 64 });
  img.addEventListener('error', () => {
    if (fallback && !img.src.endsWith(fallback)) img.src = fallback;
    else img.remove();
  });
  return el('div', { class: `acc-thumb acc-thumb-${kind}`, 'aria-hidden': 'true' },
    img,
    kind === 'class' ? el('i', { class: 'bi bi-play-fill acc-thumb-play' }) : null,
    more > 0 ? el('span', { class: 'acc-thumb-more' }, `+${more}`) : null);
}
