import type { ClassRepo, ClassRow, VideoStatePatch } from "./ports.ts";
import type { R2ObjectInfo } from "./r2/r2.types.ts";

/**
 * Lleva a la fila de public.classes lo que R2 dice del video.
 * La usa admin-sync-video: tanto cuando el admin pide "comprobar estado" a mano, como
 * (con `durationSeconds`) justo después de que el navegador termina de subir el archivo.
 *
 * Sin transcodificación no hay paso async de "procesando": en cuanto el objeto existe en
 * el bucket, el video está listo. Reglas:
 *  - "ready" solo cuando el objeto existe en R2 (y se conoce la duración).
 *  - Un video que deja de estar listo nunca queda publicado (lo exige un CHECK en la base).
 *  - Nunca publica solo: publicar es una decisión explícita del admin.
 *  - Si el objeto no existe y la clase estaba "uploading", se marca "failed" (la subida no
 *    llegó a completarse). Si todavía está "pending", se deja como está: puede que la subida
 *    ni siquiera haya empezado.
 */
export async function applyVideoState(
  repo: ClassRepo,
  row: ClassRow,
  info: R2ObjectInfo,
  durationSeconds?: number | null,
): Promise<ClassRow> {
  let status = row.video_status;
  if (info.exists) {
    status = "ready";
  } else if (row.video_status !== "pending" && row.video_status !== "failed") {
    // Estaba "uploading"/"processing"/"ready" y el objeto ya no está: la subida no llegó
    // a completarse (o el objeto se borró aparte). "pending" se deja como está: puede que
    // la subida ni siquiera haya empezado todavía.
    status = "failed";
  }

  const duration = info.exists && durationSeconds != null ? Math.round(durationSeconds) : row.duration_seconds;

  const patch: VideoStatePatch = {};
  if (status !== row.video_status) patch.video_status = status;
  if (duration !== row.duration_seconds) patch.duration_seconds = duration;
  if (status !== "ready" && row.is_published) patch.is_published = false;

  if (Object.keys(patch).length === 0) return row;
  return await repo.updateVideoState(row.id, patch);
}
