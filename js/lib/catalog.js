/** Filtros del catálogo de la tienda (lógica pura, sin DOM: se prueba en tests/web). */
export const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** @param {Array<{title:string, description?:string|null, category?:string|null}>} products */
export function filterProducts(products, { q = "", category = "" } = {}) {
  const query = norm(q).trim();
  return products.filter((p) =>
    (!category || p.category === category) &&
    (!query || norm([p.title, p.description, p.category].filter(Boolean).join(" ")).includes(query))
  );
}

export function categoriesOf(products) {
  return [...new Set(products.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
}
