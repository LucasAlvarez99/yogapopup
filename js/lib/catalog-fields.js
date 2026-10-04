/**
 * Reglas comunes de los campos "Categoría" y "Orden" de los formularios del panel (productos y clases).
 * Puras (sin DOM) para poder probarlas: ver tests/web/catalog-fields.test.js.
 *
 * Por qué existen: sin explicación ni validación, se escribían números en "Categoría" (aparecían sueltos sobre las
 * tarjetas de la tienda), "ropa" y "Ropa" quedaban como dos categorías distintas, y en las clases un "Orden" no
 * entero ("1,5") se convertía en silencio o rompía el guardado.
 */

export const CATEGORY_HINT_PRODUCT =
  'Texto que agrupa los productos en la tienda, por ejemplo: Ropa, Accesorios. Sin números: para ordenar está el campo Orden.';
export const CATEGORY_HINT_CLASS =
  'Texto que agrupa las clases en la videoteca, por ejemplo: Vinyasa, Meditación. Sin números: para ordenar está el campo Orden.';
export const SORT_HINT =
  'Número entero: el menor aparece primero (0 por defecto). Si dos tienen el mismo número, va primero el más reciente.';

/** Compara sin importar mayúsculas, tildes ni espacios repetidos ("Ropa" = "ropa " = "RÓPA"). */
const keyOf = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Quita espacios sobrantes y repetidos. */
export const cleanCategory = (raw) => String(raw ?? '').replace(/\s+/g, ' ').trim();

const isCapitalized = (c) => c[0] !== c[0].toLowerCase();
const looksNumeric = (c) => c !== '' && /^[\d\s.,]+$/.test(c);

/**
 * Motivo por el que una categoría no vale, o null. Una categoría solo de números casi seguro es un error (el número
 * de orden va en "Orden"). Si la categoría YA era así y no se toca (`previous`), no se bloquea: así no se impide
 * editar el precio de un producto antiguo; se avisa cuando se la cambie.
 */
export function categoryProblem(raw, { previous = null } = {}) {
  const c = cleanCategory(raw);
  if (looksNumeric(c) && c !== cleanCategory(previous)) {
    return 'La categoría es un texto (por ejemplo, Ropa o Accesorios), no un número. Para ordenar usa el campo Orden.';
  }
  return null;
}

/** Si ya existe una categoría igual (sin importar mayúsculas/tildes), se usa SU grafía: "ropa" pasa a ser "Ropa". */
export function canonicalCategory(raw, known = []) {
  const c = cleanCategory(raw);
  if (!c) return '';
  return known.find((k) => keyOf(cleanCategory(k)) === keyOf(c)) ?? c;
}

/**
 * Categorías ya usadas (para sugerirlas): sin repetidas, con la grafía más frecuente de cada una (a igualdad, la que
 * empieza con mayúscula), ordenadas, y sin las
 * que son solo números (errores antiguos que no conviene seguir sugiriendo).
 */
export function knownCategories(items) {
  const groups = new Map(); // clave -> Map(grafía -> veces)
  for (const item of items ?? []) {
    const c = cleanCategory(item?.category);
    if (!c || looksNumeric(c)) continue;
    const spellings = groups.get(keyOf(c)) ?? new Map();
    spellings.set(c, (spellings.get(c) ?? 0) + 1);
    groups.set(keyOf(c), spellings);
  }
  return [...groups.values()]
    .map((spellings) => [...spellings.entries()].sort((a, b) =>
      b[1] - a[1] // la grafía más usada
      || Number(isCapitalized(b[0])) - Number(isCapitalized(a[0])) // a igualdad, la que empieza con mayúscula
      || a[0].localeCompare(b[0], 'es'))[0][0])
    .sort((a, b) => a.localeCompare(b, 'es'));
}

/** "Orden": vacío = 0; si no, un entero. @returns {{ value: number } | { error: string }} */
export function parseSortOrder(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: 0 };
  if (!/^-?\d{1,9}$/.test(s)) return { error: 'El orden debe ser un número entero, por ejemplo 0, 1 o 2.' };
  return { value: Number(s) };
}
