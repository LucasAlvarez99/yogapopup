import { createEndpoint, HttpError, readJson } from "../_shared/http.ts";
import { parseCreateClassInput } from "../_shared/validate.ts";
import { type ClassRow, type HandlerDeps, toPublicClass } from "../_shared/ports.ts";

/**
 * POST { title, description?, category?, level?, access_level?, sort_order?, class_id? }
 *
 * Solo admin. Deja todo listo para que el NAVEGADOR suba el archivo directo a R2 (PUT
 * prefirmado):
 *  - Sin class_id: reserva una key en R2 + crea una clase nueva.
 *  - Con class_id, según el estado del video de esa clase:
 *      · sin video          -> reserva una key nueva y la asocia
 *      · pending/uploading  -> REANUDA: misma key, URL prefirmada nueva (aún no se subió nada,
 *                               o la subida se cortó a mitad de camino: R2 no permite retomar
 *                               un PUT simple, así que el archivo se vuelve a subir entero)
 *      · failed             -> REEMPLAZA: key nueva (la vieja, si llegó a existir, se borra)
 *      · processing/ready   -> 409, ya tiene un video en uso
 */
export function createHandler(deps: HandlerDeps) {
  const { r2, repo, auth, audit, config } = deps;

  return createEndpoint({
    methods: ["POST"],
    allowedOrigins: config.allowedOrigins,
    run: async (req) => {
      const admin = await auth.requireOwner(req);
      const input = parseCreateClassInput(await readJson(req));

      const { row, resumed } = input.classId
        ? await prepareExistingClass(input.classId)
        : { row: await createNewClass(), resumed: false };
      const upload = await r2.createUploadUrl(row.r2_object_key!, config.uploadTtlSeconds);

      // Registro no destructivo: si falla se anota en el log, pero no se deshace lo ya creado.
      try {
        await audit.record({
          actorId: admin.id,
          action: resumed ? "class.upload_resumed" : "class.upload_prepared",
          entityType: "class",
          entityId: row.id,
          details: { title: row.title },
        });
      } catch (e) {
        console.error("[audit] no se pudo registrar class.upload:", e instanceof Error ? e.message : e);
      }
      return { class: toPublicClass(row), upload, resumed };

      // ------------------------------------------------------------------ clase nueva
      async function createNewClass(): Promise<ClassRow> {
        return await repo.insertClass({
          title: input.title,
          description: input.description,
          category: input.category,
          level: input.level,
          access_level: input.accessLevel,
          sort_order: input.sortOrder,
          created_by: admin.id,
          r2_object_key: r2.newObjectKey(crypto.randomUUID()),
        });
      }

      // ------------------------------------------------------------------ clase existente
      async function prepareExistingClass(classId: string): Promise<{ row: ClassRow; resumed: boolean }> {
        const existing = await repo.getClass(classId);
        if (!existing) throw new HttpError(404, "class_not_found", "Class not found");

        const inUse = existing.video_status === "processing" || existing.video_status === "ready";
        if (existing.r2_object_key && inUse) {
          throw new HttpError(409, "video_already_attached", "This class already has a video");
        }

        // Todavía no hay nada subido: se reutiliza la misma key.
        if (existing.r2_object_key && existing.video_status !== "failed") {
          return { row: existing, resumed: true };
        }

        const previousKey = existing.r2_object_key; // se captura ANTES de actualizar la fila
        const key = r2.newObjectKey(classId);
        const target = { r2_object_key: key };
        let saved: ClassRow | null;
        try {
          saved = previousKey
            ? await repo.replaceFailedVideo(existing.id, target)
            : await repo.attachVideo(existing.id, target);
        } catch (e) {
          await cleanupObject(r2, key);
          throw e;
        }
        if (!saved) {
          // Otra petición se adelantó: no dejamos una key huérfana con datos en R2.
          await cleanupObject(r2, key);
          throw new HttpError(409, "video_already_attached", "This class already has a video");
        }
        if (previousKey) await cleanupObject(r2, previousKey); // el video fallido anterior, si llegó a subirse
        return { row: saved, resumed: false };
      }
    },
  });
}

/** Compensación: si algo falla después de reservar la key, se borra (mejor esfuerzo). */
async function cleanupObject(r2: HandlerDeps["r2"], key: string): Promise<void> {
  try {
    await r2.deleteObject(key);
  } catch (e) {
    console.error("[cleanup] could not delete orphan R2 object", key, e instanceof Error ? e.message : e);
  }
}
