import { AppError } from './errors.js';

/**
 * Reglas de la subida de video que se pueden probar sin navegador. Espejo de lo que el servidor exige de verdad
 * (supabase/functions/_shared/video-state.ts y validate.ts): acá solo se evita el viaje inútil y se avisa claro.
 */
export const MAX_VIDEO_BYTES = 5 * 1024 * 1024 * 1024; // un PUT prefirmado a R2 admite hasta 5 GiB
export const MAX_DURATION_SECONDS = 24 * 3600;

const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;

/** @returns {string|null} el motivo por el que el archivo no sirve, o null si está bien. */
export function videoFileProblem(file) {
  if (!file) return 'Elegí un archivo de video.';
  // Algunos sistemas dejan `type` vacío para .mov/.mkv: en ese caso se mira la extensión.
  const isVideo = file.type ? /^video\//i.test(file.type) : VIDEO_EXT.test(file.name || '');
  if (!isVideo) return 'El archivo tiene que ser un video (MP4, MOV o WebM).';
  if (!(file.size > 0)) return 'El archivo está vacío.';
  if (file.size > MAX_VIDEO_BYTES) return 'El video pesa más de 5 GB: comprimilo antes de subirlo.';
  return null;
}

/**
 * La duración que lee el navegador puede ser NaN, Infinity (streams) o 0 (archivo dañado). El servidor solo
 * acepta un número entre 1 s y 24 h: cualquier otra cosa se manda como "no informada" (null) en vez de romper la confirmación.
 */
export function sanitizeDuration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 1 || value > MAX_DURATION_SECONDS) return null;
  return Math.round(value * 1000) / 1000;
}

/**
 * Después de confirmar la subida, el servidor devuelve la clase con el estado real del video. Solo 'ready' es éxito:
 * antes se mostraba "Clase creada y video subido" aunque el servidor hubiera marcado el archivo como inválido.
 * @throws {AppError} si el video no quedó listo
 */
export function assertVideoReady(cls) {
  const status = cls?.video_status;
  if (status === 'ready') return;
  if (status === 'failed') {
    throw new AppError('video_invalid');
  }
  throw new AppError('upload_unconfirmed');
}
