/**
 * Creador de elementos. Los textos se insertan SIEMPRE como nodos de texto (nunca innerHTML),
 * así los títulos y descripciones que vienen de la base no pueden inyectar HTML/JS.
 *   el('button', { class: 'btn', onclick: fn, 'aria-label': 'x' }, 'Texto', otroNodo)
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Vacía un contenedor y le pone contenido nuevo. */
export function mount(parent, ...children) {
  parent.replaceChildren();
  return append(parent, children);
}

export const icon = (name, extra = '') => el('i', { class: `bi bi-${name} ${extra}`.trim(), 'aria-hidden': 'true' });
