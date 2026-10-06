import { supabase } from "../lib/supabase.js";
import { getProduct, listActiveProducts } from "../lib/api.js";
import { messageFor } from "../lib/errors.js";
import { isUuid } from "../lib/format.js";
import { productAvailability, sortedVariants, variantInfo } from "../lib/sizes.js";
import { priceBlock } from "../components/price.js";
import { page } from "../lib/env.js";
import { el, icon, mount } from "../lib/dom.js";
import { boot } from "../ui/boot.js";
import { addToCartButton, productCard } from "../components/product-card.js";
import { addToCart } from "../ui/cart-drawer.js";
import { emptyState, errorState } from "../ui/states.js";

/** Ficha de un producto: ?id=<uuid>. Estados: cargando · no encontrado · error · producto. */
const root = document.getElementById("product");
const more = document.getElementById("productMore");
const productId = new URLSearchParams(location.search).get("id");

const backLink = () =>
  el("a", { class: "btn btn-outline-secondary btn-sm", href: page("tienda.html") }, "Volver a la tienda");

/**
 * Ficha del producto. Con talles: botones para elegir uno (los agotados quedan tachados y no se pueden elegir);
 * "Agregar al carrito" sin talle elegido no agrega nada y pide elegir uno.
 */
let selectedSize = null; // id del talle elegido
let needSize = false; // se intentó agregar sin elegir

function renderProduct(p) {
  document.title = `${p.title} · Yoga Pop Up`;
  const sizes = sortedVariants(p);
  const chosen = sizes.find((v) => v.id === selectedSize) ?? null;
  const overall = productAvailability(p);
  const chosenInfo = chosen ? variantInfo(chosen) : null;
  const label = sizes.length > 0 ? (chosenInfo?.available ? chosenInfo.label : "") : overall.label;
  const media = p.image_url
    ? el("img", { src: p.image_url, alt: p.title, "data-hide-on-error": true })
    : el("i", { class: "bi bi-bag-heart", "aria-hidden": "true" });

  const choose = (v) => {
    selectedSize = v.id;
    needSize = false;
    renderProduct(p);
    root.querySelector(".size-btn.is-selected")?.focus(); // el foco no se pierde al redibujar
  };
  const picker = sizes.length === 0 ? null : el(
    "div",
    { class: "size-picker", role: "group", "aria-labelledby": "sizeLabel" },
    el("p", { id: "sizeLabel", class: "size-label" }, "Talle: ", el("strong", {}, chosen ? chosen.size : "elige uno")),
    el(
      "div",
      { class: "size-options" },
      ...sizes.map((v) => {
        const out = !variantInfo(v).available;
        return el(
          "button",
          {
            type: "button",
            class: `size-btn${v.id === selectedSize ? " is-selected" : ""}${out ? " is-out" : ""}`,
            "aria-pressed": String(v.id === selectedSize),
            disabled: out,
            title: out ? "Agotado" : null,
            onclick: () => choose(v),
          },
          v.size,
        );
      }),
    ),
    needSize ? el("p", { class: "size-error", role: "alert" }, "Elige un talle para agregar el producto al carrito.") : null,
  );

  const addButton = sizes.length === 0
    ? addToCartButton(p, { onAdd: addToCart, block: false })
    : !overall.available
    ? el("button", { type: "button", class: "btn btn-brand btn-sm", disabled: true }, "Agotado")
    : el(
      "button",
      {
        type: "button",
        class: "btn btn-brand btn-sm",
        onclick: () => {
          if (!chosen) {
            needSize = true;
            renderProduct(p);
            root.querySelector(".size-picker")?.scrollIntoView({ block: "nearest" });
            return;
          }
          addToCart(p, chosen);
        },
      },
      icon("bag-plus"),
      " Agregar al carrito",
    );

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
        priceBlock(p.price_cents, p.tax_rate_bps, { large: true }),
        el("p", { class: "price-note" }, "IVA incluido"),
        !overall.available
          ? el("p", { class: "text-danger fw-semibold" }, "Agotado")
          : label
          ? el("p", { class: "text-muted", role: "status" }, label)
          : null,
        p.description ? el("p", { class: "producto-desc" }, p.description) : null,
        picker,
        el("div", { class: "d-flex gap-2 flex-wrap mt-3" }, addButton, backLink()),
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
      el("div", { class: "row g-4" }, ...others.map((o) => productCard(o, { onAdd: addToCart }))),
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
