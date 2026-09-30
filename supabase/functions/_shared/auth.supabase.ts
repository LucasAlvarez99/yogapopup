// deno-lint-ignore no-import-prefix -- especificador npm: en línea, válido en Supabase Edge Functions
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { HttpError } from "./http.ts";
import type { AuthedUser, AuthPort, Role } from "./ports.ts";

/**
 * Autenticación y permisos usando el JWT del propio usuario:
 *  - El token se valida contra Supabase Auth (getUser), no solo se decodifica.
 *  - Los permisos se consultan con las funciones SQL is_admin() y can_access_class()
 *    ejecutadas COMO el usuario, así auth.uid() y RLS son los reales.
 */
export function createSupabaseAuth(url: string, anonKey: string): AuthPort {
  async function authenticate(req: Request): Promise<{ client: SupabaseClient; user: AuthedUser }> {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
    if (!match) throw new HttpError(401, "unauthenticated", "Missing or invalid Authorization header");
    const token = match[1];

    const client = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) throw new HttpError(401, "unauthenticated", "Invalid or expired session");

    // El rol se lee de la base CON LA SESIÓN DEL USUARIO (RLS: solo puede ver su propia fila). Nunca del token
    // ni de lo que envíe el navegador: user_metadata lo controla el propio usuario.
    const { data: profile, error: profileError } = await client.from("profiles").select("role").eq("id", data.user.id)
      .maybeSingle();
    if (profileError) throw new Error(`profile lookup: ${profileError.message}`);
    const role: Role = profile?.role === "owner" || profile?.role === "developer" ? profile.role : "user";

    return {
      client,
      user: {
        id: data.user.id,
        role,
        async canAccessClass(classId: string): Promise<boolean> {
          const { data: allowed, error: rpcError } = await client.rpc("can_access_class", { p_class_id: classId });
          if (rpcError) throw new Error(`rpc can_access_class: ${rpcError.message}`);
          return allowed === true;
        },
      },
    };
  }

  return {
    async requireUser(req) {
      return (await authenticate(req)).user;
    },
    async requireOwner(req) {
      const { user } = await authenticate(req);
      if (user.role !== "owner" && user.role !== "developer") {
        throw new HttpError(403, "owner_only", "Owner access required");
      }
      return user;
    },
    async requireDeveloper(req) {
      const { user } = await authenticate(req);
      if (user.role !== "developer") throw new HttpError(403, "developer_only", "Developer access required");
      return user;
    },
  };
}
