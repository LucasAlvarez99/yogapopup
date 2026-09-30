import { supabase } from "../lib/supabase.js";
import { getProduct, listActiveProducts } from "../lib/api.js";
import { messageFor } from "../lib/errors.js";
import { formatPrice, isUuid, stockInfo } from "../lib/format.js";
import { page } from "../lib/env.js";
import { el, mount } from "../lib/dom.js";
import { boot } from "../ui/boot.js";
import { addToCartButton, productCard } from "../components/product-card.js";
import { emptyState, errorState } from "../ui/states.js";

/** Ficha de un producto: ?id=<uuid>. Estados: cargando · no encontrado · error · producto. */
const root = document.getElementById("product");
const more = document.getElementById("productMore");
const productId = new URLSearchParams(location.search).get("id");

const backLink = () =>
  el("a", { class: "btn btn-outline-secondary btn-sm", href: page("tienda.html") }, "Volver a la tienda");

function renderProduct(p) {
  document.title = `${p.title} · Yoga Pop Up`;
  const { available, label } = stockInfo(p.stock);
  const media = p.image_url
    ? el("img", { src: p.image_url, alt: p.title, "data-hide-on-error": true })
    : el("i", { class: "bi bi-bag-heart", "aria-hidden": "true" });
  mount(
    root,
    el(
      "div",
      { class: "row g-5 align-items-start" },
      el("div", { class: "col-md-6" }, el("div", { class: "shop-media shop-media-lg bg-mint" }, media)),
      el(
        "div",
        { class: "col-md-6" },
        p.category ? el("span", { class: "product-cat" }, p.category) : null,
        el("h1", { class: "producto-title" }, p.title),
        el("p", { class: "producto-price" }, formatPrice(p.price_cents)),
        !available
          ? el("p", { class: "text-danger fw-semibold" }, "Agotado")
          : label
          ? el("p", { class: "text-muted" }, label)
          : null,
        p.description ? el("p", { class: "producto-desc" }, p.description) : null,
        el("div", { class: "d-flex gap-2 flex-wrap mt-3" }, addToCartButton(p, { block: false }), backLink()),
      ),
    ),
  );
}

async function renderMore() {
  try {
    const others = (await listActiveProducts()).filter((x) => x.id !== productId).slice(0, 4);
    if (others.length === 0) return;
    mount(
      more,
      el("h2", { class: "yp-block-title" }, "También te puede gustar"),
      el("div", { class: "row g-4" }, ...others.map((o) => productCard(o))),
    );
  } catch { /* opcional: si falla, simplemente no se muestra */ }
}

async function load() {
  mount(root, el("div", { class: "yp-skeleton", "aria-busy": "true", "aria-label": "Cargando producto" }));
  if (!supabase) {
    return mount(
      root,
      emptyState("Tienda en preparación", "Falta configurar la conexión con Supabase (js/config.js).", backLink()),
    );
  }
  if (!isUuid(productId)) {
    return mount(root, emptyState("Producto no encontrado", "El enlace no es válido.", backLink()));
  }
  let p;
  try {
    p = await getProduct(productId);
  } catch (err) {
    return mount(root, errorState(messageFor(err), load));
  }
  if (!p) return mount(root, emptyState("Producto no encontrado", "Puede que ya no esté disponible.", backLink()));
  renderProduct(p);
  await renderMore();
}

await boot("tienda");
await load();
