import { R2Error } from "./r2/r2.service.ts";
import { PayPalError } from "./paypal/paypal.service.ts";

/** Error "esperado" que se traduce a una respuesta HTTP con código estable. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Cabeceras extra de la respuesta (p. ej. `Retry-After` en un 429). */
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const MAX_BODY_BYTES = 16 * 1024;

/** CORS: solo se refleja el origen si está en ALLOWED_ORIGINS (o si hay "*"). */
export function corsHeaders(origin: string | null, allowedOrigins: string[]): Record<string, string> {
  const headers: Record<string, string> = {
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
  if (allowedOrigins.includes("*")) headers["Access-Control-Allow-Origin"] = "*";
  else if (origin && allowedOrigins.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      // Una respuesta de la API nunca debe interpretarse como otra cosa que JSON.
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}

/**
 * Lee y parsea el body JSON con tope de tamaño EN BYTES (no en caracteres: un texto con tildes o emojis
 * pesa más de lo que cuenta `.length`). Si el cliente declara un tamaño mayor al tope, se corta antes de
 * leer nada; si no lo declara (o miente), se corta apenas el flujo real lo supera.
 */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large", "Request body too large");
  }
  const raw = await readTextLimited(req, MAX_BODY_BYTES);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "Body must be a JSON object");
  }
}

export async function readTextLimited(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "payload_too_large", "Request body too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

interface EndpointOptions {
  methods: string[];
  allowedOrigins: string[];
  /** Devuelve el cuerpo JSON (200) o una Response propia. */
  run: (req: Request) => Promise<unknown | Response>;
}

/**
 * Envoltorio común de todas las funciones: preflight CORS, método permitido,
 * formato de error uniforme y logging sin filtrar detalles internos al cliente.
 */
export function createEndpoint(opts: EndpointOptions): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const cors = corsHeaders(req.headers.get("origin"), opts.allowedOrigins);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!opts.methods.includes(req.method)) {
      return json({ error: { code: "method_not_allowed", message: "Method not allowed" } }, 405, cors);
    }

    try {
      const result = await opts.run(req);
      if (result instanceof Response) {
        for (const [k, v] of Object.entries(cors)) result.headers.set(k, v);
        return result;
      }
      return json(result, 200, cors);
    } catch (e) {
      if (e instanceof HttpError) {
        return json({ error: { code: e.code, message: e.message } }, e.status, { ...cors, ...e.headers });
      }
      if (e instanceof R2Error) {
        console.error(`[r2] ${e.operation} failed status=${e.status}: ${e.message}`);
        return json(
          { error: { code: "video_provider_error", message: "The video provider is unavailable, try again" } },
          502,
          cors,
        );
      }
      if (e instanceof PayPalError) {
        console.error(
          `[paypal] ${e.operation} failed status=${e.status}${e.issue ? ` issue=${e.issue}` : ""}: ${e.message}`,
        );
        return json(
          { error: { code: "payment_provider_error", message: "The payment provider is unavailable, try again" } },
          502,
          cors,
        );
      }
      console.error("[unhandled]", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: { code: "internal_error", message: "Unexpected error" } }, 500, cors);
    }
  };
}
