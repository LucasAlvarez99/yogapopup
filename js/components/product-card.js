import { el, icon } from "../lib/dom.js";
import { formatPrice, stockInfo } from "../lib/format.js";
import { page } from "../lib/env.js";

/**
 * Botón "agregar al carrito". Las páginas le pasan `onAdd` (ver ui/cart-drawer.js). Si alguna no lo hace,
 * el botón se muestra deshabilitado ("Próximamente") en vez de simular una compra que no existe.
 */
export function addToCartButton(product, { onAdd = null, block = true } = {}) {
  const { available } = stockInfo(product.stock);
  const cls = `btn btn-brand btn-sm${block ? " w-100" : ""}`;
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
    { type: "button", class: cls, onclick: () => onAdd(product) },
    icon("bag-plus"),
    " Agregar al carrito",
  );
}

/** Tarjeta de producto con el mismo marcado que las de la home (.shop-card). */
export function productCard(p, { onAdd = null, col = "col-6 col-lg-3" } = {}) {
  const { available, label } = stockInfo(p.stock);
  const media = p.image_url
    ? el("img", { src: p.image_url, alt: "", loading: "lazy", "data-hide-on-error": true })
    : el("i", { class: "bi bi-bag-heart", "aria-hidden": "true" });
  const href = `${page("producto.html")}?id=${encodeURIComponent(p.id)}`;
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
        p.category ? el("span", { class: "product-cat" }, p.category) : null,
        el("h3", {}, el("a", { href }, p.title)),
        el("strong", { class: "price" }, formatPrice(p.price_cents)),
        label && available ? el("small", { class: "shop-stock" }, label) : null,
        addToCartButton(p, { onAdd }),
      ),
    ),
  );
}
