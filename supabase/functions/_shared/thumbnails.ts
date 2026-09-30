/** Bucket público de Supabase Storage donde se guardan las miniaturas de las clases. */
export const THUMBNAIL_BUCKET = "class-thumbnails";

/**
 * Devuelve la ruta del objeto dentro del bucket si la URL es una miniatura NUESTRA
 * (mismo proyecto de Supabase y mismo bucket); si no, null. Así nunca se intenta borrar
 * algo ajeno aunque alguien guarde una URL externa en thumbnail_url.
 */
export function thumbnailPathFromUrl(url: string | null, supabaseUrl: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const base = new URL(supabaseUrl);
    if (u.origin !== base.origin) return null;
    const prefix = `/storage/v1/object/public/${THUMBNAIL_BUCKET}/`;
    if (!u.pathname.startsWith(prefix)) return null;
    const path = decodeURIComponent(u.pathname.slice(prefix.length));
    if (!path || path.includes("..") || path.startsWith("/")) return null;
    return path;
  } catch {
    return null;
  }
}
