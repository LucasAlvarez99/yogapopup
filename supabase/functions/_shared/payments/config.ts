import type { PayPalConfig } from "../paypal/paypal.types.ts";
import type { PaymentsConfig } from "./ports.ts";

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

const optional = (env: Env, name: string): string | null => env[name]?.trim() || null;

/**
 * Configuración de las funciones de pagos. A propósito NO exige las variables de R2: los pagos se pueden desplegar y
 * probar sin tocar el video. Las credenciales de PayPal son opcionales a nivel de arranque: si faltan, las funciones
 * responden 503 `payments_not_configured` (y `npm run doctor` lo avisa), en vez de caerse al iniciar.
 */
export function loadPaymentsConfig(env: Env): {
  app: PaymentsConfig;
  paypal: PayPalConfig | null;
  supabase: { url: string; anonKey: string; serviceRoleKey: string };
} {
  const rawEnv = optional(env, "PAYPAL_ENV");
  if (rawEnv !== null && rawEnv !== "sandbox" && rawEnv !== "live") {
    throw new Error("PAYPAL_ENV must be 'sandbox' or 'live'");
  }
  const clientId = optional(env, "PAYPAL_CLIENT_ID");
  const clientSecret = optional(env, "PAYPAL_CLIENT_SECRET");
  return {
    supabase: {
      url: required(env, "SUPABASE_URL"),
      anonKey: required(env, "SUPABASE_ANON_KEY"),
      serviceRoleKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
    },
    paypal: rawEnv && clientId && clientSecret ? { env: rawEnv, clientId, clientSecret } : null,
    app: {
      allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      planId: optional(env, "PAYPAL_PLAN_ID"),
      webhookId: optional(env, "PAYPAL_WEBHOOK_ID"),
      cronSecret: optional(env, "RECONCILE_CRON_SECRET"),
      brandName: optional(env, "PAYPAL_BRAND_NAME") ?? "Yoga Pop Up",
    },
  };
}
