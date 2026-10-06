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

/**
 * ¿El error indica que la base AÚN NO tiene las migraciones de talles e IVA (relación `product_variants` o columna
 * `tax_rate_bps` inexistentes)? El sitio se publica solo con cada push, pero la base se actualiza a mano: si la web llega
 * primero, la tienda no debe romperse; vuelve a pedir los datos con las columnas de antes.
 */
export const isSchemaBehind = (error) => Boolean(error) && ["PGRST200", "PGRST204", "42703", "42P01"].includes(error.code);
