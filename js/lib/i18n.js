/**
 * Traducción de la interfaz (es -> otros idiomas) SIN servicios externos: la CSP del sitio (script-src 'self') no
 * permite el widget de Google Translate, y además sus traducciones automáticas no se pueden revisar.
 *
 * Cómo funciona: el sitio se escribe en español (idioma de origen). Cada idioma es un diccionario en js/i18n/<código>.js
 * con `exact` (texto en español -> texto traducido) y `patterns` (para textos con datos, p. ej. «Con Manu»).
 * El motor recorre el DOM, traduce los nodos de texto y los atributos visibles (placeholder, aria-label, title, alt)
 * y vigila los cambios (MutationObserver): lo que las páginas pintan después —tarjetas, carrito, modales— se traduce solo,
 * sin tocar el código de cada página. El texto original se guarda, así que volver a español es exacto.
 *
 * Lo que NO se traduce: lo que escriben las personas (títulos y descripciones de clases y productos), el panel de gestión
 * (lo usa el equipo, en español) y la política de privacidad (texto legal: se traduce con revisión de un profesional).
 * Para sumar un idioma: crear js/i18n/<código>.js, registrarlo en LOADERS y en LANGS.
 */

export const STORAGE_KEY = 'yp-lang';
export const DEFAULT_LANG = 'es';
/** Nombre de cada idioma en SU idioma (así se muestra en el selector, nunca traducido). */
export const LANGS = Object.freeze({ es: 'Español', en: 'English' });
const LOADERS = { en: () => import('../i18n/en.js') };

const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);

export const isLang = (code) => Object.prototype.hasOwnProperty.call(LANGS, code);
/** Espacios (incluido el &nbsp;) colapsados: la clave del diccionario no depende de cómo se indentó el HTML. */
export const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Traduce un texto con un diccionario. Conserva los espacios de los extremos. Devuelve `null` si no hay traducción.
 * @param {string} source
 * @param {{ exact: Record<string,string>, patterns?: Array<[RegExp, string | ((...m: string[]) => string)]> }} dict
 */
export function translateWith(source, dict) {
  const key = norm(source);
  if (!key) return null;
  const lead = /^\s*/.exec(source)[0];
  const trail = /\s*$/.exec(source)[0];
  const exact = Object.prototype.hasOwnProperty.call(dict.exact, key) ? dict.exact[key] : null;
  if (exact !== null) return lead + exact + trail;
  for (const [re, out] of dict.patterns ?? []) {
    if (re.test(key)) return lead + key.replace(re, out) + trail;
  }
  return null;
}

/** Idioma inicial: ?lang=xx (para compartir un enlace) > el elegido antes > español. */
export function pickInitialLang(search = '', stored = null) {
  const fromUrl = new URLSearchParams(search).get('lang');
  if (fromUrl && isLang(fromUrl)) return fromUrl;
  if (stored && isLang(stored)) return stored;
  return DEFAULT_LANG;
}

// ---------------------------------------------------------------------------------------------------- estado
let current = DEFAULT_LANG;
let dict = null;
let observer = null;
let applying = false;
const listeners = new Set();
const missing = new Set();
/** @type {WeakMap<Text, {src:string,out:string,lang:string}>} */
const textRec = new WeakMap();
/** @type {WeakMap<Element, Map<string,{src:string,out:string,lang:string}>>} */
const attrRec = new WeakMap();

export const getLang = () => current;
export const onLangChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
/** Textos con letras que se quedaron sin traducir en el idioma actual (para detectar huecos del diccionario). */
export const getMissing = () => [...missing].sort();

const translatable = (el) => !el?.closest?.('[translate="no"], [data-no-translate]');

function convert(src, lang) {
  if (lang === DEFAULT_LANG || !dict) return src;
  const out = translateWith(src, dict);
  if (out === null) {
    if (/\p{L}{2,}/u.test(src)) missing.add(norm(src));
    return src;
  }
  return out;
}

function applyText(node) {
  const el = node.parentElement;
  if (!el || SKIP_TAGS.has(el.tagName) || !translatable(el)) return;
  let rec = textRec.get(node);
  if (rec && node.data === rec.out && rec.lang === current) return; // ya está al día
  // Si la página cambió el texto desde la última vez, lo nuevo es el texto original.
  const src = rec && node.data === rec.out ? rec.src : node.data;
  const out = convert(src, current);
  if (node.data !== out) node.data = out;
  textRec.set(node, { src, out, lang: current });
}

function applyAttrs(el) {
  if (!translatable(el)) return;
  let recs = attrRec.get(el);
  for (const name of ATTRS) {
    const value = el.getAttribute(name);
    if (value === null) continue;
    const rec = recs?.get(name);
    if (rec && value === rec.out && rec.lang === current) continue;
    const src = rec && value === rec.out ? rec.src : value;
    const out = convert(src, current);
    if (value !== out) el.setAttribute(name, out);
    if (!recs) attrRec.set(el, (recs = new Map()));
    recs.set(name, { src, out, lang: current });
  }
}

function applyTree(root) {
  if (root.nodeType === Node.TEXT_NODE) return applyText(root);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  if (SKIP_TAGS.has(root.tagName)) return;
  applyAttrs(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) applyText(n);
    else if (!SKIP_TAGS.has(n.tagName)) applyAttrs(n);
  }
}

function applyAll() {
  applying = true;
  try {
    applyTree(document.documentElement);
    document.documentElement.lang = current;
  } finally {
    applying = false;
  }
}

function onMutations(records) {
  if (applying || current === DEFAULT_LANG) return;
  applying = true;
  try {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach(applyTree);
      else if (r.type === 'characterData') applyText(r.target);
      else if (r.type === 'attributes') applyAttrs(r.target);
    }
  } finally {
    applying = false;
    observer?.takeRecords(); // lo que escribimos nosotros no vuelve a procesarse
  }
}

function startObserver() {
  if (observer || typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver(onMutations);
  observer.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS,
  });
}

function remember(lang) {
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* sin almacenamiento: vale solo para esta visita */ }
}

/** Cambia el idioma de la página y lo recuerda. Si el diccionario no carga, se queda en español. */
export async function setLang(lang, { persist = true } = {}) {
  if (!isLang(lang)) return current;
  if (lang !== DEFAULT_LANG && !(lang in LOADERS)) return current;
  let next = null;
  if (lang !== DEFAULT_LANG) {
    try { next = (await LOADERS[lang]()).default; } catch { return current; }
  }
  dict = next;
  current = lang;
  missing.clear();
  applyAll();
  startObserver();
  if (persist) remember(lang);
  listeners.forEach((fn) => fn(lang));
  return current;
}

/** Arranque: elige el idioma inicial y lo aplica. Llamar una vez por página, después de dibujar el encabezado. */
export async function initI18n() {
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* ignorado */ }
  const lang = pickInitialLang(globalThis.location?.search ?? '', stored);
  startObserver();
  if (lang === DEFAULT_LANG) {
    document.documentElement.lang = DEFAULT_LANG;
    return current;
  }
  return setLang(lang, { persist: false });
}
