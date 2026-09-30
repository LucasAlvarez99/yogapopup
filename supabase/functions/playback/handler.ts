import { createEndpoint, HttpError, readJson } from "../_shared/http.ts";
import { parseUuid } from "../_shared/validate.ts";
import type { HandlerDeps } from "../_shared/ports.ts";

/** Debajo de esto no vale la pena "continuar": se empieza de cero. */
const MIN_RESUME_SECONDS = 5;
/** Igual que public.save_progress(): pasado el 95 % la clase cuenta como terminada. */
const COMPLETED_RATIO = 0.95;

/**
 * POST { class_id }
 * Usuario autenticado. Devuelve una URL de video firmada y con vencimiento SOLO si el
 * usuario tiene acceso (public.can_access_class, ejecutada como él), más el punto donde
 * retomar. Conocer la URL de la página o el id de una clase no alcanza para ver el video.
 */
export function createHandler(deps: HandlerDeps) {
  const { r2, repo, auth, config } = deps;

  return createEndpoint({
    methods: ["POST"],
    allowedOrigins: config.allowedOrigins,
    run: async (req) => {
      const user = await auth.requireUser(req);
      const classId = parseUuid((await readJson(req)).class_id, "class_id");

      // Se decide primero el permiso: quien no tiene acceso no averigua si la clase existe.
      if (!(await user.canAccessClass(classId))) {
        throw new HttpError(403, "no_access", "You don't have access to this class");
      }

      const row = await repo.getClass(classId);
      if (!row) throw new HttpError(404, "class_not_found", "Class not found");
      if (!row.r2_object_key || row.video_status !== "ready") {
        throw new HttpError(409, "video_not_ready", "The video is not ready yet");
      }

      const [signed, progress] = await Promise.all([
        r2.signPlayback(row.r2_object_key, config.playbackTtlSeconds),
        repo.getProgress(user.id, row.id),
      ]);

      const seconds = progress?.progress_seconds ?? 0;
      const finished = row.duration_seconds != null && seconds >= row.duration_seconds * COMPLETED_RATIO;
      const resume = seconds < MIN_RESUME_SECONDS || finished ? 0 : seconds;

      return {
        class_id: row.id,
        title: row.title,
        duration_seconds: row.duration_seconds,
        video_url: signed.url,
        expires_at: signed.expiresAt,
        resume_seconds: resume,
        completed: progress?.completed ?? false,
      };
    },
  });
}
