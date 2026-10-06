import { el } from '../lib/dom.js';
import { LANGS, getLang, initI18n, onLangChange, setLang } from '../lib/i18n.js';

/**
 * Selector de idioma del encabezado. Se dibuja en cada `[data-lang-slot]` (index.html y ui/layout.js lo incluyen).
 * Es un <select> nativo: accesible por teclado y lector de pantalla sin código extra. Cada <option> lleva `translate="no"`
 * para que el motor no traduzca los nombres de los idiomas (cada uno se muestra en el suyo).
 */
export async function initLanguage() {
  document.querySelectorAll('[data-lang-slot]').forEach((slot) => {
    const select = el('select', {
      class: 'lang-select', 'aria-label': 'Idioma', title: 'Idioma',
      onchange: (e) => setLang(e.target.value),
    }, ...Object.entries(LANGS).map(([code, name]) => el('option', { value: code, translate: 'no' }, name)));
    slot.replaceChildren(el('span', { class: 'lang-picker' }, el('i', { class: 'bi bi-translate', 'aria-hidden': 'true' }), select));
    select.value = getLang();
    onLangChange((lang) => { select.value = lang; });
  });
  const lang = await initI18n();
  document.querySelectorAll('.lang-select').forEach((s) => { s.value = lang; });
  return lang;
}
