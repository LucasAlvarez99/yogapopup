import { createEndpoint, HttpError } from "../_shared/http.ts";
import { enforceRateLimit, LIMITS } from "../_shared/rate-limit.ts";
import { timingSafeEqual } from "../_shared/payments/request.ts";
import { runReminders } from "../_shared/reminders/logic.ts";
import type { RemindersDeps } from "../_shared/reminders/ports.ts";

/**
 * Fase 31 · Aviso por correo de la clase en vivo del mismo día. Lo dispara un cron (cabecera `x-cron-secret`, ver
 * docs/RECORDATORIOS.md) o el personal de gestión a mano. Cada reserva recibe UN solo correo; los fallos vuelven a la cola.
 * No acepta datos del navegador: quién recibe qué lo decide solo la base.
 */
export function createHandler(deps: RemindersDeps): (req: Request) => Promise<Response> {
  return createEndpoint({
    methods: ["POST"],
    allowedOrigins: deps.config.allowedOrigins,
    run: async (req) => {
      const secret = req.headers.get("x-cron-secret");
      const viaCron = !!secret && !!deps.config.cronSecret && timingSafeEqual(secret, deps.config.cronSecret);
      let actorId: string | null = null;
      if (!viaCron) {
        const staff = await deps.auth.requireStaff(req);
        actorId = staff.id;
        await enforceRateLimit(deps.limiter, "live-reminders", staff.id, LIMITS.reminders);
      }
      if (!deps.mail) throw new HttpError(503, "mail_not_configured", "Email sending is not configured");

      const summary = await runReminders({ repo: deps.repo, mail: deps.mail, config: deps.config });
      if (summary.claimed > 0) {
        await deps.audit.record({
          actorId,
          action: "live_reminders.run",
          entityType: "live_booking",
          details: { ...summary, via: viaCron ? "cron" : "staff" },
        }).catch((e) => console.error("[reminders] audit failed:", e instanceof Error ? e.message : e));
      }
      return summary;
    },
  });
}
