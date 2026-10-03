import { AppError } from './errors.js';

/**
 * Imágenes de producto y miniaturas: reducción previa a la subida y traducción de los errores de Storage.
 * La lógica es pura (recibe una función `encode`) para poder probarla sin navegador.
 */

/** Tope del bucket (supabase/migrations: file_size_limit = 2 MiB). Se apunta algo por debajo por seguridad. */
export const BUCKET_LIMIT_BYTES = 2 * 1024 * 1024;
export const TARGET_BYTES = Math.floor(1.8 * 1024 * 1024);

/** Intentos de más a menos calidad; se queda con el primero que cabe. */
export const ATTEMPTS = [
  { width: 1280, quality: 0.82 },
  { width: 1280, quality: 0.7 },
  { width: 1000, quality: 0.7 },
  { width: 800, quality: 0.6 },
  { width: 600, quality: 0.5 },
];

const ALLOWED = /^image\/(webp|jpeg|png)$/;

/**
 * Devuelve la mejor imagen que cabe en `maxBytes`.
 *
 * Se pide WebP, pero Safari (Mac e iPhone) no sabe codificarlo en un canvas y devuelve un PNG SIN AVISAR: una foto de
 * 1280 px en PNG pasa fácilmente de 2 MB y Storage la rechazaba ("No se pudo subir la imagen"). Si el navegador no
 * devolvió WebP se reintenta como JPEG, que todos los navegadores codifican.
 *
 * @param {(width: number, type: string, quality: number) => Promise<Blob|null>} encode
 */
export async function fitImage(encode, { maxBytes = TARGET_BYTES, attempts = ATTEMPTS } = {}) {
  for (const { width, quality } of attempts) {
    let blob = await encode(width, 'image/webp', quality);
    if (!blob || blob.type !== 'image/webp') {
      const jpeg = await encode(width, 'image/jpeg', quality);
      if (jpeg && (!blob || jpeg.size < blob.size)) blob = jpeg;
    }
    if (blob && ALLOWED.test(blob.type) && blob.size > 0 && blob.size <= maxBytes) return blob;
  }
  throw new AppError('image_too_large');
}

/**
 * Traduce el error de Supabase Storage a un AppError con un motivo que la persona pueda entender
 * (antes TODO se mostraba como "No se pudo subir la imagen", sin pista de qué hacer).
 * @param {{ message?: string, statusCode?: string|number, error?: string }} error
 * @param {string} fallbackMessage
 */
export function storageUploadError(error, fallbackMessage = 'No se pudo subir la imagen.') {
  const status = Number(error?.statusCode ?? error?.status);
  const text = `${error?.message ?? ''} ${error?.error ?? ''}`;
  if (status === 413 || /exceeded the maximum allowed size|payload too large|too large/i.test(text)) return new AppError('image_too_large');
  if (/mime type|invalid_mime|not supported/i.test(text) || status === 415) return new AppError('invalid_input', 'La imagen debe ser JPG, PNG o WebP.');
  if (status === 401 || status === 403 || /row-level security|unauthorized|not authorized|permission/i.test(text)) return new AppError('image_forbidden');
  if (status === 404 || /bucket not found/i.test(text)) return new AppError('storage_missing');
  // Código propio (fuera del catálogo): así el texto específico ("…la miniatura") es el que ve la persona.
  return new AppError('storage_error', fallbackMessage);
}
