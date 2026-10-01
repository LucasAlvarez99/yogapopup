import { supabase } from "../lib/supabase.js";
import { listActiveProducts } from "../lib/api.js";
import { messageFor } from "../lib/errors.js";
import { categoriesOf, filterProducts } from "../lib/catalog.js";
import { el, mount } from "../lib/dom.js";
import { boot } from "../ui/boot.js";
import { productCard } from "../components/product-card.js";
import { addToCart } from "../ui/cart-drawer.js";
import { emptyState, errorState, skeletonGrid } from "../ui/states.js";

/** Tienda: catálogo real de productos activos, con búsqueda y filtro por categoría. */
const filters = { q: "", category: "" };
let products = [];

const gridBox = document.getElementById("shopGrid");
const filtersBox = document.getElementById("shopFilters");

function renderFilters() {
  const cats = categoriesOf(products);
  const chip = (label, value) =>
    el("button", {
      type: "button",
      class: "yp-chip",
      "aria-pressed": String(filters.category === value),
      onclick: () => {
        filters.category = value;
        renderFilters();
        renderGrid();
      },
    }, label);
  mount(
    filtersBox,
    el("input", {
      type: "search",
      class: "form-control",
      placeholder: "Buscar productos…",
      "aria-label": "Buscar productos",
      value: filters.q,
      oninput: (e) => {
        filters.q = e.target.value;
        renderGrid();
      },
    }),
    cats.length
      ? el(
        "div",
        { class: "yp-chips", role: "group", "aria-label": "Categorías" },
        chip("Todas", ""),
        ...cats.map((c) => chip(c, c)),
      )
      : null,
  );
  filtersBox.hidden = products.length === 0;
}

function renderGrid() {
  const list = filterProducts(products, filters);
  if (list.length === 0) {
    return mount(
      gridBox,
      products.length === 0
        ? emptyState("Todavía no hay productos", "Estamos preparando la tienda. Vuelve pronto.")
        : emptyState("No encontramos productos con esos filtros", "Prueba con otra búsqueda o categoría."),
    );
  }
  mount(gridBox, el("div", { class: "row g-4" }, ...list.map((p) => productCard(p, { onAdd: addToCart }))));
}

async function load() {
  mount(gridBox, skeletonGrid());
  filtersBox.hidden = true;
  if (!supabase) {
    return mount(
      gridBox,
      emptyState("Tienda en preparación", "Falta configurar la conexión con Supabase (js/config.js)."),
    );
  }
  try {
    products = await listActiveProducts();
  } catch (err) {
    return mount(gridBox, errorState(messageFor(err), load));
  }
  renderFilters();
  renderGrid();
}

await boot("tienda");
await load();
