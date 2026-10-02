import { HttpError } from "./http.ts";
import type { RateLimiterPort } from "./ports.ts";

/** Ventana fija: como máximo `max` peticiones cada `windowSeconds` por clave. */
export interface RateLimit {
  max: number;
  windowSeconds: number;
}

/**
 * Límites por usuario y por función. Generosos para el uso normal (un reproductor pide como mucho una URL
 * nueva cada pocas horas; un developer sube pocas clases por día) pero lo bastante bajos como para que
 * una cuenta robada o un script en bucle no pueda disparar firmas de R2, borrados o subidas sin freno.
 */
export const LIMITS = {
  playback: { max: 60, windowSeconds: 60 },
  createUpload: { max: 20, windowSeconds: 60 },
  syncVideo: { max: 60, windowSeconds: 60 },
  deleteClass: { max: 20, windowSeconds: 60 },
} as const satisfies Record<string, RateLimit>;

/**
 * Corta con 429 si `userId` superó el límite de `scope`.
 *
 * Si el propio limitador falla (la base no responde) se DEJA PASAR y se registra: que el contador se caiga
 * no debe tumbar la reproducción ni el panel (la autorización real ya se comprobó antes). Es una decisión
 * deliberada de disponibilidad; los controles de acceso nunca dependen de esto.
 */
export async function enforceRateLimit(
  limiter: RateLimiterPort,
  scope: string,
  userId: string,
  limit: RateLimit,
): Promise<void> {
  let allowed: boolean;
  try {
    allowed = await limiter.hit(`${scope}:${userId}`, limit.max, limit.windowSeconds);
  } catch (e) {
    console.error("[rate-limit] limiter unavailable, allowing request:", e instanceof Error ? e.message : e);
    return;
  }
  if (!allowed) {
    throw new HttpError(429, "rate_limited", "Too many requests, try again shortly", {
      "Retry-After": String(limit.windowSeconds),
    });
  }
}
