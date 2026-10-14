import { el, icon } from '../lib/dom.js';
import { formatMinutes, levelLabel } from '../lib/format.js';
import { page } from '../lib/env.js';
import { priceBlock } from './price.js';
import { classOffer, daysLeft, daysLeftLabel } from '../lib/class-shop.js';

const hrefOf = (c) => `${page('clase.html')}?id=${encodeURIComponent(c.id)}`;

/**
 * Tarjeta de un video de la videoteca, con el mismo marcado que las de la tienda (.shop-card): foto, categoría, título,
 * precio con IVA y el botón que corresponde:
 *   comprar suelto -> "Agregar al carrito" (o "En el carrito" si ya está)    ·  gratis / comprado / incluido -> "Ver video"
 *   solo con suscripción -> "Ver cómo acceder"
 * @param {object} c       fila de classes con precio
 * @param {{ access?: object|null, inCart?: boolean, onAdd?: (c: object) => void, col?: string }} [opts]
 */
export function classShopCard(c, { access = null, inCart = false, onAdd = null, col = 'col-md-6 col-lg-4' } = {}) {
  const offer = classOffer(c, access);
  const media = c.thumbnail_url
    ? el('img', { src: c.thumbnail_url, alt: '', loading: 'lazy', 'data-hide-on-error': true })
    : el('i', { class: 'bi bi-flower1', 'aria-hidden': 'true' });
  const href = hrefOf(c);
  const cls = 'btn btn-brand btn-sm w-100';

  let note = null;
  let action;
  if (offer === 'buy') {
    action = inCart
      ? el('button', { type: 'button', class: cls, disabled: true, 'data-in-cart': 'true' }, icon('check2'), ' En el carrito')
      : onAdd
        ? el('button', { type: 'button', class: cls, 'data-add-video': c.id, onclick: () => onAdd(c) }, icon('bag-plus'), ' Agregar al carrito')
        : el('button', { type: 'button', class: cls, disabled: true, title: 'La compra online llega pronto' }, icon('bag-plus'), ' Próximamente');
    note = el('small', { class: 'shop-stock' }, 'Se ve durante 30 días');
  } else if (offer === 'locked') {
    action = el('a', { class: cls, href }, icon('lock'), ' Ver cómo acceder');
    note = el('small', { class: 'shop-stock' }, 'Incluido con suscripción');
  } else {
    action = el('a', { class: cls, href }, icon('play-fill'), ' Ver video');
    if (offer === 'owned') note = el('small', { class: 'shop-stock' }, daysLeftLabel(daysLeft(access.classes.get(c.id))) || 'Es tuyo');
    else if (offer === 'included') note = el('small', { class: 'shop-stock' }, 'Incluido en tu suscripción');
    else note = el('small', { class: 'shop-stock' }, 'Gratis');
  }

  return el('article', { class: col },
    el('div', { class: 'shop-card video-shop-card', 'data-offer': offer },
      el('a', { class: 'shop-link', href, 'aria-label': c.title },
        el('div', { class: 'shop-media bg-mint' },
          media,
          el('span', { class: 'video-play', 'aria-hidden': 'true' }, icon('play-fill')),
          c.duration_seconds ? el('span', { class: 'tag tag-light shop-flag' }, formatMinutes(c.duration_seconds)) : null)),
      el('div', { class: 'shop-body' },
        el('span', { class: 'product-cat', translate: 'no' }, c.category || levelLabel(c.level)),
        el('h3', { translate: 'no' }, el('a', { href }, c.title)),
        offer === 'buy' ? priceBlock(c.price_cents, c.tax_rate_bps) : null,
        note,
        action)));
}
