import { el, icon } from "../lib/dom.js";
import { formatPrice, stockInfo } from "../lib/format.js";
import { page } from "../lib/env.js";
import { priceBlock } from "./price.js";
import { hasSizes, productAvailability, sortedVariants, variantInfo } from "../lib/sizes.js";

const productHref = (p) => `${page("producto.html")}?id=${encodeURIComponent(p.id)}`;

/**
 * Botón "agregar al carrito". Las páginas le pasan `onAdd` (ver ui/cart-drawer.js). Si alguna no lo hace,
 * el botón se muestra deshabilitado ("Próximamente") en vez de simular una compra que no existe.
 *
 * Un producto CON TALLES no se agrega desde acá (falta elegir el talle): el botón lleva a su ficha.
 * Con `variant` (la ficha ya eligió uno) se agrega ese talle.
 */
export function addToCartButton(product, { onAdd = null, block = true, variant = null } = {}) {
  const cls = `btn btn-brand btn-sm${block ? " w-100" : ""}`;
  if (hasSizes(product) && !variant) {
    if (!productAvailability(product).available) return el("button", { type: "button", class: cls, disabled: true }, "Agotado");
    return el("a", { class: cls, href: productHref(product) }, icon("rulers"), " Elegir talle");
  }
  const { available } = variant ? variantInfo(variant) : stockInfo(product.stock);
  if (!available) return el("button", { type: "button", class: cls, disabled: true }, "Agotado");
  if (!onAdd) {
    return el(
      "button",
      { type: "button", class: cls, disabled: true, title: "La compra online llega pronto" },
      icon("bag-plus"),
      " Próximamente",
    );
  }
  return el(
    "button",
    { type: "button", class: cls, onclick: () => onAdd(product, variant) },
    icon("bag-plus"),
    " Agregar al carrito",
  );
}

/** Talles de la tarjeta: solo informativos (se eligen en la ficha). Los agotados van tachados. */
function sizeChips(p) {
  const sizes = sortedVariants(p);
  if (sizes.length === 0) return null;
  return el(
    "ul",
    { class: "size-chips", "aria-label": "Talles" },
    ...sizes.map((v) =>
      el("li", { class: `size-chip${variantInfo(v).available ? "" : " is-out"}`, title: variantInfo(v).available ? null : "Agotado" }, v.size)
    ),
  );
}

/** Tarjeta de producto con el mismo marcado que las de la home (.shop-card). */
export function productCard(p, { onAdd = null, col = "col-6 col-lg-3" } = {}) {
  const { available, label } = productAvailability(p);
  const media = p.image_url
    ? el("img", { src: p.image_url, alt: "", loading: "lazy", "data-hide-on-error": true })
    : el("i", { class: "bi bi-bag-heart", "aria-hidden": "true" });
  const href = productHref(p);
  return el(
    "article",
    { class: col },
    el(
      "div",
      { class: `shop-card${available ? "" : " is-soldout"}` },
      el(
        "a",
        { class: "shop-link", href, "aria-label": `${p.title}, ${formatPrice(p.price_cents)}` },
        el(
          "div",
          { class: "shop-media bg-mint" },
          media,
          !available ? el("span", { class: "tag tag-light shop-flag" }, "Agotado") : null,
        ),
      ),
      el(
        "div",
        { class: "shop-body" },
        p.category ? el("span", { class: "product-cat", translate: "no" }, p.category) : null,
        el("h3", { translate: "no" }, el("a", { href }, p.title)),
        priceBlock(p.price_cents, p.tax_rate_bps),
        sizeChips(p),
        label && available ? el("small", { class: "shop-stock" }, label) : null,
        addToCartButton(p, { onAdd }),
      ),
    ),
  );
}
