import { el } from "../lib/dom.js";
import { priceParts } from "../lib/tax.js";

/**
 * Precio con IVA incluido y, al lado y más chico, el precio sin IVA ("35,00 €  28,93 € sin IVA").
 * Un producto exento (0 %) no repite la cifra. `large` usa el tamaño de la ficha de producto.
 */
export function priceBlock(cents, rateBps, { large = false } = {}) {
  const { price, net } = priceParts(cents, rateBps);
  return el(
    "div",
    { class: `price-row${large ? " price-row-lg" : ""}` },
    el("strong", { class: large ? "producto-price" : "price" }, price),
    net ? el("small", { class: "price-net" }, `${net} sin IVA`) : null,
  );
}
