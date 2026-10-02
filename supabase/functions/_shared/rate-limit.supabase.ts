// deno-lint-ignore no-import-prefix -- especificador npm: en línea, válido en Supabase Edge Functions
import { createClient } from "npm:@supabase/supabase-js@2";
import type { RateLimiterPort } from "./ports.ts";

/** Contador en Postgres (public.rate_limit_hit, ejecutable solo por la service role): compartido entre instancias. */
export function createSupabaseRateLimiter(url: string, serviceRoleKey: string): RateLimiterPort {
  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async hit(key, max, windowSeconds) {
      const { data, error } = await db.rpc("rate_limit_hit", {
        p_key: key,
        p_max: max,
        p_window_seconds: windowSeconds,
      });
      if (error) throw new Error(`rate_limit_hit: ${error.message}`);
      return data === true;
    },
  };
}
