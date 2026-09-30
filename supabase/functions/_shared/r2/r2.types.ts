/**
 * Tipos de la capa Cloudflare R2 (reemplaza a Bunny Stream).
 *
 * R2 es almacenamiento de objetos compatible con S3: no transcodifica video ni arma HLS.
 * Por eso el video se guarda y se sirve tal cual se subió (progresivo, con soporte de
 * Range requests nativo de R2), y el <video> del navegador lo reproduce directo.
 */

/** Estado de video que guardamos en public.classes.video_status.
 *  Sin transcodificación no existe un estado "processing" real: se deja en el tipo por
 *  compatibilidad con la base, pero el flujo nuevo pasa directo de "uploading" a "ready". */
export type ClassVideoStatus = "pending" | "uploading" | "processing" | "ready" | "failed";

/** Credenciales para que el NAVEGADOR suba el archivo DIRECTO a R2 (PUT prefirmado). */
export interface R2UploadCredentials {
  /** URL prefirmada (SigV4) para un PUT único. Válida hasta `expire`. */
  url: string;
  key: string;
  /** UNIX timestamp (segundos) en que vence la autorización de subida. */
  expire: number;
}

export interface SignedPlayback {
  /** URL del archivo de video con token de acceso (SigV4), con vencimiento. */
  url: string;
  /** UNIX timestamp (segundos) en que vence la URL firmada. */
  expiresAt: number;
}

/** Resultado de comprobar si el objeto existe en el bucket. */
export interface R2ObjectInfo {
  exists: boolean;
  /** Tamaño en bytes, si el objeto existe. */
  size?: number;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Inyectable para tests. */
  fetchImpl?: typeof fetch;
  /** Inyectable para tests (segundos UNIX). */
  nowSeconds?: () => number;
  requestTimeoutMs?: number;
}
