import type { RemindersConfig } from "./ports.ts";

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
const optional = (env: Env, name: string): string | null => env[name]?.trim() || null;

const isLocal = (o: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(o);

/**
 * Configuración del aviso de clases en vivo. El correo es OPCIONAL a nivel de arranque (sin RESEND_API_KEY / MAIL_FROM
 * la función responde 503 `mail_not_configured` y `npm run doctor` lo avisa). La dirección del sitio sale de SITE_URL o,
 * si falta, del primer origen permitido que no sea local.
 */
export function loadRemindersConfig(env: Env): {
  app: RemindersConfig;
  mail: { apiKey: string; from: string } | null;
  supabase: { url: string; anonKey: string; serviceRoleKey: string };
} {
  const origins = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const apiKey = optional(env, "RESEND_API_KEY");
  const from = optional(env, "MAIL_FROM");
  const timezone = optional(env, "REMINDERS_TZ") ?? "Europe/Madrid";
  try {
    new Intl.DateTimeFormat("es-ES", { timeZone: timezone });
  } catch {
    throw new Error("REMINDERS_TZ is not a valid time zone (e.g. Europe/Madrid)");
  }
  const batch = Number(optional(env, "REMINDERS_BATCH") ?? 100);
  return {
    supabase: {
      url: required(env, "SUPABASE_URL"),
      anonKey: required(env, "SUPABASE_ANON_KEY"),
      serviceRoleKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
    },
    mail: apiKey && from ? { apiKey, from } : null,
    app: {
      allowedOrigins: origins,
      cronSecret: optional(env, "REMINDERS_CRON_SECRET"),
      timezone,
      siteUrl: optional(env, "SITE_URL") ?? origins.find((o) => !isLocal(o)) ?? null,
      brandName: optional(env, "MAIL_BRAND_NAME") ?? "Yoga Pop Up",
      batchLimit: Number.isInteger(batch) && batch >= 1 && batch <= 500 ? batch : 100,
    },
  };
}
