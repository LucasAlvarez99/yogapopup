/** 1663 -> "27:43" · 3723 -> "1:02:03" */
export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** 2700 -> "45 min" (redondea hacia arriba; vacío si no hay dato) */
export function formatMinutes(totalSeconds) {
  const s = Number(totalSeconds);
  if (!Number.isFinite(s) || s <= 0) return '';
  return `${Math.max(1, Math.ceil(s / 60))} min`;
}

/** Porcentaje entero (hacia abajo) entre 0 y 100. 1663/2700 -> 61 */
export function percent(progressSeconds, durationSeconds) {
  const p = Number(progressSeconds), d = Number(durationSeconds);
  if (!Number.isFinite(p) || !Number.isFinite(d) || d <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((p / d) * 100)));
}

export const LEVEL_LABELS = Object.freeze({
  principiante: 'Principiante', intermedio: 'Intermedio', avanzado: 'Avanzado', todos: 'Todos los niveles',
});
export const levelLabel = (level) => LEVEL_LABELS[level] || level || '';

export function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}

export const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** 3499 -> "34,99 €" (los precios viajan siempre en céntimos de euro, nunca como decimales). */
export function formatPrice(cents) {
  if (cents === null || cents === undefined || cents === '') return '';
  const n = Number(cents);
  if (!Number.isFinite(n) || n < 0) return '';
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n / 100);
}

/**
 * Disponibilidad según el stock: `null` = no se controla stock (digital, a pedido) -> siempre disponible.
 * @returns {{ available: boolean, label: string }}
 */
export function stockInfo(stock) {
  if (stock === null || stock === undefined) return { available: true, label: '' };
  const n = Number(stock);
  if (!Number.isFinite(n) || n <= 0) return { available: false, label: 'Agotado' };
  if (n <= 5) return { available: true, label: `Últimas ${n} unidades` };
  return { available: true, label: '' };
}
