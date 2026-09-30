// deno-lint-ignore no-import-prefix -- especificador npm: en línea, válido en Supabase Edge Functions
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { THUMBNAIL_BUCKET, thumbnailPathFromUrl } from "./thumbnails.ts";
import type { ClassRepo, ClassRow, NewClass, ProgressRow, VideoStatePatch } from "./ports.ts";

/** Columnas que lee el backend. r2_object_key solo es legible con la service role. */
const CLASS_COLUMNS = "id,title,description,thumbnail_url,duration_seconds,level,category,access_level,\
sort_order,is_published,video_status,r2_object_key,created_at,updated_at";

/**
 * Repositorio sobre Supabase usando la SERVICE ROLE (se salta RLS).
 * Por eso vive solo en el backend y cada consulta filtra explícitamente por usuario/clase.
 */
export function createSupabaseRepo(url: string, serviceRoleKey: string): ClassRepo {
  const supabaseUrl = url;
  const db: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  function fail(op: string, error: { message: string }): never {
    throw new Error(`db ${op}: ${error.message}`);
  }

  return {
    async insertClass(input: NewClass): Promise<ClassRow> {
      const { data, error } = await db.from("classes").insert(input).select(CLASS_COLUMNS).single();
      if (error) fail("insertClass", error);
      return data as unknown as ClassRow;
    },

    async getClass(id) {
      const { data, error } = await db.from("classes").select(CLASS_COLUMNS).eq("id", id).maybeSingle();
      if (error) fail("getClass", error);
      return (data as ClassRow | null) ?? null;
    },

    async getClassByObjectKey(key) {
      const { data, error } = await db.from("classes").select(CLASS_COLUMNS).eq("r2_object_key", key)
        .maybeSingle();
      if (error) fail("getClassByObjectKey", error);
      return (data as ClassRow | null) ?? null;
    },

    async attachVideo(classId, video) {
      // El filtro "r2_object_key is null" hace la operación atómica: si dos peticiones
      // compiten, solo una asocia su video.
      const { data, error } = await db.from("classes")
        .update({ ...video, video_status: "pending", duration_seconds: null })
        .eq("id", classId)
        .is("r2_object_key", null)
        .select(CLASS_COLUMNS)
        .maybeSingle();
      if (error) fail("attachVideo", error);
      return (data as ClassRow | null) ?? null;
    },

    async replaceFailedVideo(classId, video) {
      const { data, error } = await db.from("classes")
        .update({ ...video, video_status: "pending", duration_seconds: null })
        .eq("id", classId)
        .eq("video_status", "failed")
        .select(CLASS_COLUMNS)
        .maybeSingle();
      if (error) fail("replaceFailedVideo", error);
      return (data as ClassRow | null) ?? null;
    },

    async deleteThumbnail(url) {
      const path = thumbnailPathFromUrl(url, supabaseUrl);
      if (!path) return;
      const { error } = await db.storage.from(THUMBNAIL_BUCKET).remove([path]);
      if (error) console.error("[storage] could not delete thumbnail:", error.message);
    },

    async updateVideoState(classId, patch: VideoStatePatch) {
      const { data, error } = await db.from("classes").update(patch).eq("id", classId).select(CLASS_COLUMNS)
        .single();
      if (error) fail("updateVideoState", error);
      return data as unknown as ClassRow;
    },

    async deleteClass(id) {
      const { error } = await db.from("classes").delete().eq("id", id);
      if (error) fail("deleteClass", error);
    },

    async getProgress(userId, classId): Promise<ProgressRow | null> {
      const { data, error } = await db.from("video_progress").select("progress_seconds,completed")
        .eq("user_id", userId).eq("class_id", classId).maybeSingle();
      if (error) fail("getProgress", error);
      return (data as ProgressRow | null) ?? null;
    },

    async ping() {
      const { error } = await db.from("classes").select("id").limit(1);
      if (error) fail("ping", error);
    },
  };
}
