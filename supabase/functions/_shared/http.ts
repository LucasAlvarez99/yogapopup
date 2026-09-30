import { R2Error } from "./r2/r2.service.ts";

/** Error "esperado" que se traduce a una respuesta HTTP con código estable. */
export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
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
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

/** Lee y parsea el body JSON con tope de tamaño. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Request body too large");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "Body must be a JSON object");
  }
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
        return json({ error: { code: e.code, message: e.message } }, e.status, cors);
      }
      if (e instanceof R2Error) {
        console.error(`[r2] ${e.operation} failed status=${e.status}: ${e.message}`);
        return json(
          { error: { code: "video_provider_error", message: "The video provider is unavailable, try again" } },
          502,
          cors,
        );
      }
      console.error("[unhandled]", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return json({ error: { code: "internal_error", message: "Unexpected error" } }, 500, cors);
    }
  };
}
