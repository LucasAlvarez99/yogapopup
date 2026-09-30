import { createEndpoint, HttpError, readJson } from "../_shared/http.ts";
import { parseUuid } from "../_shared/validate.ts";
import { type HandlerDeps, toPublicClass } from "../_shared/ports.ts";
import { applyVideoState } from "../_shared/video-state.ts";

/**
 * POST { class_id, duration_seconds? }
 * Solo admin. Comprueba en R2 si el objeto del video ya existe y lo refleja en la clase.
 * Dos usos:
 *  - El panel la llama para "comprobar estado" a mano.
 *  - El formulario de subida la llama justo después de terminar el PUT a R2, mandando
 *    `duration_seconds` (que el navegador ya calculó leyendo el archivo antes de subirlo),
 *    ya que R2 no transcodifica y por lo tanto no informa la duración por su cuenta.
 */
export function createHandler(deps: HandlerDeps) {
  const { r2, repo, auth, config } = deps;

  return createEndpoint({
    methods: ["POST"],
    allowedOrigins: config.allowedOrigins,
    run: async (req) => {
      await auth.requireOwner(req);
      const body = await readJson(req);
      const classId = parseUuid(body.class_id, "class_id");
      const duration = parseDuration(body.duration_seconds);

      const row = await repo.getClass(classId);
      if (!row) throw new HttpError(404, "class_not_found", "Class not found");
      if (!row.r2_object_key) throw new HttpError(409, "no_video", "This class has no video yet");

      const info = await r2.headObject(row.r2_object_key);
      const updated = await applyVideoState(repo, row, info, duration);
      return { class: toPublicClass(updated), object_found: info.exists };
    },
  });
}

function parseDuration(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new HttpError(400, "invalid_input", "duration_seconds must be a positive number");
  }
  return n;
}
