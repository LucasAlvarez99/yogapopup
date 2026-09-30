/**
 * Fase 14 · Panel de productos: lógica PURA del formulario (sin DOM ni red), para poder probarla en Deno.
 *
 * Regla de la Fase 12: el precio viaja y se guarda en CÉNTIMOS de euro (entero, nunca float).
 * Quien edita escribe euros ("19,99"); acá se convierte con aritmética de enteros, sin pasar por decimales.
 */

/** Tope: `price_cents` es integer en Postgres (máx. 2 147 483 647). Se deja un margen amplio. */
export const MAX_PRICE_CENTS = 99_999_999; // 999.999,99 €
export const MAX_STOCK = 1_000_000;

/**
 * "19,99" | "19.99" | "19" | " 19,9 € " -> 1999 | 1999 | 1900 | 1990. Devuelve null si no es un precio válido.
 * Se rechazan a propósito los separadores de miles ("1.999,50") y los tres decimales ("1.999"): son
 * ambiguos entre formato español e inglés y un error de precio se cobra de verdad.
 */
export function eurosToCents(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).replace(/€|eur/gi, '').trim();
  const m = /^(\d{1,6})(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
  return cents <= MAX_PRICE_CENTS ? cents : null;
}

/** 1999 -> "19,99" · 1900 -> "19" (para rellenar el campo al editar, sin símbolo de moneda). */
export function centsToEurosInput(cents) {
  if (cents === null || cents === undefined || cents === '') return ''; // Number(null) === 0: no confundir "sin precio" con gratis
  const n = Number(cents);
  if (!Number.isInteger(n) || n < 0) return '';
  const euros = Math.floor(n / 100);
  const rest = n % 100;
  return rest === 0 ? String(euros) : `${euros},${String(rest).padStart(2, '0')}`;
}

/** "" -> null (sin control de stock) · "12" -> 12 · "-1" / "2,5" / "abc" -> undefined (inválido). */
export function parseStock(input) {
  const s = String(input ?? '').trim();
  if (s === '') return null;
  if (!/^\d{1,7}$/.test(s)) return undefined;
  const n = Number(s);
  return n <= MAX_STOCK ? n : undefined;
}

/**
 * Valida los campos crudos del formulario y arma el objeto que se guarda en `products`.
 * @returns {{ value: object } | { error: string }}
 */
export function buildProductInput(raw) {
  const title = String(raw.title ?? '').trim();
  if (!title) return { error: 'El título es obligatorio.' };
  if (title.length > 150) return { error: 'El título admite hasta 150 caracteres.' };

  const description = String(raw.description ?? '').trim();
  if (description.length > 5000) return { error: 'La descripción admite hasta 5000 caracteres.' };

  const category = String(raw.category ?? '').trim();
  if (category.length > 60) return { error: 'La categoría admite hasta 60 caracteres.' };

  const price_cents = eurosToCents(raw.price);
  if (price_cents === null) {
    return { error: 'Ingresá un precio válido en euros, por ejemplo 19,99 (sin separador de miles).' };
  }

  const stock = parseStock(raw.stock);
  if (stock === undefined) return { error: 'El stock debe ser un número entero, o quedar vacío si no se controla.' };

  const sortText = String(raw.sort_order ?? '').trim();
  if (sortText !== '' && !/^-?\d{1,9}$/.test(sortText)) return { error: 'El orden debe ser un número entero.' };

  return {
    value: {
      title,
      description: description || null,
      category: category || null,
      price_cents,
      stock,
      sort_order: sortText === '' ? 0 : Number(sortText),
      is_active: Boolean(raw.is_active),
    },
  };
}

/**
 * Ruta del objeto dentro del bucket a partir de la URL PÚBLICA que guardamos en `image_url`.
 * Devuelve null si la URL no es de nuestro bucket o la ruta es sospechosa: así nunca se borra algo ajeno
 * ni se sale de la carpeta del bucket (mismo criterio que `thumbnailPathFromUrl` en el backend).
 */
export function storagePathFromPublicUrl(url, bucket) {
  const marker = `/storage/v1/object/public/${bucket}/`;
  const s = String(url ?? '');
  const i = s.indexOf(marker);
  if (i < 0) return null;
  let path;
  try {
    path = decodeURIComponent(s.slice(i + marker.length).split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (!path || path.startsWith('/') || path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  return path;
}
