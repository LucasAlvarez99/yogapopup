import { createSupabaseAuth } from "../auth.supabase.ts";
import { createSupabaseAudit } from "../audit.supabase.ts";
import { createSupabaseRateLimiter } from "../rate-limit.supabase.ts";
import { json } from "../http.ts";
import { loadRemindersConfig } from "./config.ts";
import { ResendMail } from "./mail.resend.ts";
import { createSupabaseRemindersRepo } from "./repo.supabase.ts";
import type { RemindersDeps } from "./ports.ts";

export function buildRemindersDeps(env: Record<string, string | undefined> = Deno.env.toObject()): RemindersDeps {
  const cfg = loadRemindersConfig(env);
  return {
    mail: cfg.mail ? new ResendMail(cfg.mail) : null,
    repo: createSupabaseRemindersRepo(cfg.supabase.url, cfg.supabase.serviceRoleKey),
    auth: createSupabaseAuth(cfg.supabase.url, cfg.supabase.anonKey),
    audit: createSupabaseAudit(cfg.supabase.url, cfg.supabase.serviceRoleKey),
    limiter: createSupabaseRateLimiter(cfg.supabase.url, cfg.supabase.serviceRoleKey),
    config: cfg.app,
  };
}

/** Igual que `servePayments`: las dependencias se arman en la primera petición y un error de configuración no filtra detalles. */
export function serveReminders(create: (deps: RemindersDeps) => (req: Request) => Promise<Response>): void {
  let handler: ((req: Request) => Promise<Response>) | undefined;
  Deno.serve(async (req) => {
    try {
      handler ??= create(buildRemindersDeps());
    } catch (e) {
      console.error("[startup]", e instanceof Error ? e.message : e);
      return json({ error: { code: "server_misconfigured", message: "Server is not configured" } }, 500);
    }
    return await handler(req);
  });
}
