// deno-lint-ignore no-import-prefix -- especificador npm: en línea, válido en Supabase Edge Functions
import { AwsClient } from "npm:aws4fetch@1.0.20";
import type { R2Config, R2ObjectInfo, R2UploadCredentials, SignedPlayback } from "./r2.types.ts";

const KEY_RE = /^[a-zA-Z0-9!_.*'()/-]{1,900}$/;

/** Error de la capa R2. Nunca incluye credenciales en el mensaje. */
export class R2Error extends Error {
  constructor(message: string, public readonly status: number, public readonly operation: string) {
    super(message);
    this.name = "R2Error";
  }
}

/**
 * Único punto del sistema que habla con Cloudflare R2 (API compatible con S3).
 * Corre solo en el backend (Edge Functions): las claves de acceso nunca llegan al navegador.
 *
 * A diferencia de Bunny, R2 no transcodifica: el video se guarda y se sirve tal cual se
 * subió. El navegador lo reproduce de forma progresiva (R2 soporta Range requests).
 */
export class R2Service {
  private readonly cfg: Required<Pick<R2Config, "requestTimeoutMs">> & R2Config;
  private readonly client: AwsClient;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly endpoint: string;

  constructor(config: R2Config) {
    if (!config.accountId) throw new Error("R2_ACCOUNT_ID is required");
    if (!config.accessKeyId) throw new Error("R2_ACCESS_KEY_ID is required");
    if (!config.secretAccessKey) throw new Error("R2_SECRET_ACCESS_KEY is required");
    if (!config.bucket) throw new Error("R2_BUCKET is required");
    this.cfg = { requestTimeoutMs: 10_000, ...config };
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.endpoint = `https://${this.cfg.accountId}.r2.cloudflarestorage.com`;
    this.client = new AwsClient({
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      service: "s3",
      region: "auto",
    });
  }

  get bucket(): string {
    return this.cfg.bucket;
  }

  /** Genera una key nueva y estable para el video de una clase. */
  newObjectKey(classId: string): string {
    return `classes/${classId}/${crypto.randomUUID()}.mp4`;
  }

  // ---------------------------------------------------------------- subida (PUT prefirmado)

  /**
   * URL prefirmada para que el NAVEGADOR suba el archivo DIRECTO a R2 con un PUT simple.
   * A diferencia de Bunny (TUS resumable), un PUT cortado a mitad de camino no se puede
   * retomar: hay que volver a subir el archivo completo con una URL nueva.
   */
  async createUploadUrl(key: string, ttlSeconds: number): Promise<R2UploadCredentials> {
    assertKey(key);
    const expire = this.now() + ttlSeconds;
    const url = this.objectUrl(key, ttlSeconds);
    const signed = await this.client.sign(url, { method: "PUT", aws: { signQuery: true } });
    return { url: signed.url, key, expire };
  }

  // ---------------------------------------------------------------- estado

  /** Consulta si el objeto existe en el bucket (y su tamaño), vía HEAD. */
  async headObject(key: string): Promise<R2ObjectInfo> {
    assertKey(key);
    const res = await this.signedFetch("HEAD", key, "headObject");
    if (res.status === 404) return { exists: false };
    if (!res.ok) throw new R2Error(`R2 headObject failed (${res.status})`, res.status, "headObject");
    const len = res.headers.get("content-length");
    return { exists: true, size: len ? Number(len) : undefined };
  }

  /** Borra el objeto. Idempotente: si ya no existe (404) devuelve false sin error. */
  async deleteObject(key: string): Promise<boolean> {
    assertKey(key);
    const res = await this.signedFetch("DELETE", key, "deleteObject");
    if (res.status === 404) return false;
    if (!res.ok && res.status !== 204) {
      throw new R2Error(`R2 deleteObject failed (${res.status})`, res.status, "deleteObject");
    }
    return true;
  }

  // ---------------------------------------------------------------- reproducción

  /** URL firmada (SigV4), con vencimiento, para leer el video directo del bucket. */
  async signPlayback(key: string, ttlSeconds: number): Promise<SignedPlayback> {
    assertKey(key);
    const expiresAt = this.now() + ttlSeconds;
    const url = this.objectUrl(key, ttlSeconds);
    const signed = await this.client.sign(url, { method: "GET", aws: { signQuery: true } });
    return { url: signed.url, expiresAt };
  }

  // ---------------------------------------------------------------- privado

  private objectUrl(key: string, ttlSeconds: number): string {
    const url = new URL(`${this.endpoint}/${this.cfg.bucket}/${encodeKeyPath(key)}`);
    url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
    return url.toString();
  }

  /** Firma una petición (headers, no query) y la ejecuta con `fetchImpl` (inyectable para tests). */
  private async signedFetch(method: string, key: string, operation: string): Promise<Response> {
    const url = `${this.endpoint}/${this.cfg.bucket}/${encodeKeyPath(key)}`;
    const signed = await this.client.sign(url, { method, aws: { signQuery: false } });
    try {
      return await this.fetchImpl(signed, { signal: AbortSignal.timeout(this.cfg.requestTimeoutMs) });
    } catch (e) {
      const timedOut = e instanceof DOMException && e.name === "TimeoutError";
      throw new R2Error(timedOut ? "R2 request timed out" : "R2 request failed", 0, operation);
    }
  }
}

function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function assertKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes("..") || key.startsWith("/")) {
    throw new R2Error("Invalid R2 object key", 400, "validate");
  }
}
