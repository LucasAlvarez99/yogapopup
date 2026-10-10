/**
 * Comentarios de la comunidad (Fases 26-27): reglas y textos puros, sin DOM ni red, para poder probarlos.
 * La base impone los mismos límites (migración 20261009120000): esto solo evita viajes inútiles y da mensajes claros.
 */
export const BODY_MIN = 10;
export const BODY_MAX = 600;

/**
 * Valida lo que escribe la persona. `rating` es opcional (vacío = sin estrellas).
 * @returns {{ ok: true, value: { body: string, rating: number|null } } | { ok: false, error: string, field: 'body'|'rating' }}
 */
export function validateTestimonial({ body, rating } = {}) {
  const text = String(body ?? '').trim();
  if (text.length < BODY_MIN) return { ok: false, field: 'body', error: `Escribí al menos ${BODY_MIN} caracteres.` };
  if (text.length > BODY_MAX) return { ok: false, field: 'body', error: `El comentario no puede pasar de ${BODY_MAX} caracteres.` };
  let stars = null;
  if (rating !== '' && rating !== null && rating !== undefined) {
    stars = Number(rating);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return { ok: false, field: 'rating', error: 'Elegí una puntuación de 1 a 5.' };
  }
  return { ok: true, value: { body: text, rating: stars } };
}

/** "María Sol" → "MS"; un solo nombre → una letra; vacío → "?". */
export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts.length === 1 ? parts[0][0] : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Cómo se le cuenta a la persona el estado de SU comentario. */
export const MY_STATUS = Object.freeze({
  pending: { label: 'En revisión', tone: 'warning', note: 'Gracias. Se publica cuando el equipo lo apruebe.' },
  approved: { label: 'Publicado', tone: 'success', note: 'Tu comentario ya se ve en la página. Si lo editás, vuelve a revisión.' },
  hidden: { label: 'No publicado', tone: 'secondary', note: 'El equipo no lo publicó. Podés editarlo y se vuelve a revisar.' },
});

/** Estados para el panel de gestión, en el orden de las pestañas de filtro (los pendientes primero: es lo que hay que atender). */
export const MODERATION_FILTERS = Object.freeze([
  ['pending', 'Pendientes'],
  ['approved', 'Aprobados'],
  ['hidden', 'Ocultos'],
]);

export const STATUS_LABEL = Object.freeze({ pending: 'Pendiente', approved: 'Aprobado', hidden: 'Oculto' });
export const STATUS_TONE = Object.freeze({ pending: 'warning', approved: 'success', hidden: 'secondary' });

/** { pending, approved, hidden } con las cantidades (todas presentes aunque sean 0). */
export function countByStatus(rows) {
  const out = { pending: 0, approved: 0, hidden: 0 };
  for (const r of Array.isArray(rows) ? rows : []) if (r && r.status in out) out[r.status]++;
  return out;
}

/** Los más antiguos primero entre los pendientes (hay que atender primero lo que más espera); el resto, lo último arriba. */
export function sortForModeration(rows, status) {
  const t = (r) => Date.parse(r.created_at ?? '') || 0;
  return [...(rows ?? [])].filter((r) => r.status === status).sort((a, b) => (status === 'pending' ? t(a) - t(b) : t(b) - t(a)));
}

/** Acciones que ofrece el panel según el estado actual. */
export function moderationActions(status) {
  if (status === 'pending') return ['approve', 'hide'];
  if (status === 'approved') return ['hide'];
  return ['approve'];
}
