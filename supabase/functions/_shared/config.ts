import type { R2Config } from "./r2/r2.types.ts";
import type { AppConfig } from "./ports.ts";

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function intOr(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/**
 * Lee la configuración desde variables de entorno del backend.
 * SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY las inyecta Supabase solo.
 * Las R2_* se cargan con `supabase secrets set`. Nada de esto va al frontend.
 */
export function loadConfig(env: Env): {
  app: AppConfig;
  r2: R2Config;
  supabase: { url: string; anonKey: string; serviceRoleKey: string };
} {
  return {
    supabase: {
      url: required(env, "SUPABASE_URL"),
      anonKey: required(env, "SUPABASE_ANON_KEY"),
      serviceRoleKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
    },
    r2: {
      accountId: required(env, "R2_ACCOUNT_ID"),
      accessKeyId: required(env, "R2_ACCESS_KEY_ID"),
      secretAccessKey: required(env, "R2_SECRET_ACCESS_KEY"),
      bucket: required(env, "R2_BUCKET"),
    },
    app: {
      allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      playbackTtlSeconds: intOr(env, "PLAYBACK_TTL_SECONDS", 2 * 3600, 60, 24 * 3600),
      uploadTtlSeconds: intOr(env, "UPLOAD_TTL_SECONDS", 4 * 3600, 300, 24 * 3600),
    },
  };
}
