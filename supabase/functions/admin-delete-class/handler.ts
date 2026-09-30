import { createEndpoint, HttpError, readJson } from "../_shared/http.ts";
import { parseUuid } from "../_shared/validate.ts";
import type { HandlerDeps } from "../_shared/ports.ts";

/**
 * POST { class_id }
 * Solo admin. Borra el objeto de video en R2 y luego la clase (el progreso y los permisos
 * asociados se eliminan en cascada). Si R2 falla, NO se borra la clase: el admin puede
 * reintentar y no quedan objetos huérfanos ocupando (y cobrando) almacenamiento.
 */
export function createHandler(deps: HandlerDeps) {
  const { r2, repo, auth, audit, config } = deps;

  return createEndpoint({
    methods: ["POST"],
    allowedOrigins: config.allowedOrigins,
    run: async (req) => {
      const actor = await auth.requireOwner(req);
      const classId = parseUuid((await readJson(req)).class_id, "class_id");

      const row = await repo.getClass(classId);
      if (!row) throw new HttpError(404, "class_not_found", "Class not found");

      // Operación destructiva: primero se REGISTRA la intención; si no se puede auditar, no se borra nada.
      await audit.record({
        actorId: actor.id,
        action: "class.delete",
        entityType: "class",
        entityId: row.id,
        details: { title: row.title, had_video: row.r2_object_key !== null, was_published: row.is_published },
      });

      let videoDeleted = false;
      if (row.r2_object_key) videoDeleted = await r2.deleteObject(row.r2_object_key);

      await repo.deleteClass(row.id);

      // La miniatura es solo un archivo suelto: si no se puede borrar, no se falla la operación.
      try {
        await repo.deleteThumbnail(row.thumbnail_url);
      } catch (e) {
        console.error("[delete-class] thumbnail cleanup failed", e instanceof Error ? e.message : e);
      }
      return { deleted: true, class_id: row.id, video_deleted: videoDeleted };
    },
  });
}
