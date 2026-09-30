import { createEndpoint, HttpError } from "../_shared/http.ts";
import type { HandlerDeps } from "../_shared/ports.ts";

/**
 * GET. Pública, sin datos sensibles. Hace una consulta mínima a la base: sirve para que
 * UptimeRobot (o similar) la consulte cada 5 minutos, lo que mantiene activo el proyecto
 * gratuito de Supabase (que se pausa tras 1 semana sin actividad) y avisa si la base cae.
 */
export function createHandler(deps: HandlerDeps) {
  return createEndpoint({
    methods: ["GET", "HEAD"],
    allowedOrigins: [],
    run: async () => {
      try {
        await deps.repo.ping();
      } catch (e) {
        console.error("[health] db ping failed", e instanceof Error ? e.message : e);
        throw new HttpError(503, "db_unavailable", "Database unavailable");
      }
      return { ok: true };
    },
  });
}
