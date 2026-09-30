/**
 * Puertos (interfaces) que separan la lógica de negocio de Supabase y de R2.
 * En producción los implementan repo.supabase.ts / auth.supabase.ts / R2Service.
 * En los tests se reemplazan por versiones en memoria.
 */
import type { R2Service } from "./r2/r2.service.ts";
import type { AccessLevel, Level } from "./validate.ts";
import type { ClassVideoStatus } from "./r2/r2.types.ts";

/** Fila completa de public.classes tal como la ve el BACKEND (incluye la key de R2). */
export interface ClassRow {
  id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  level: Level;
  category: string | null;
  access_level: AccessLevel;
  sort_order: number;
  is_published: boolean;
  video_status: ClassVideoStatus;
  r2_object_key: string | null;
  created_at: string;
  updated_at: string;
}

/** Lo que se le devuelve a un cliente: sin la key interna de R2. */
export type PublicClass = Omit<ClassRow, "r2_object_key">;

export function toPublicClass(row: ClassRow): PublicClass {
  // deno-lint-ignore no-unused-vars
  const { r2_object_key, ...rest } = row;
  return rest;
}

export interface NewClass {
  title: string;
  description: string | null;
  category: string | null;
  level: Level;
  access_level: AccessLevel;
  sort_order: number;
  created_by: string;
  r2_object_key: string;
}

export interface VideoStatePatch {
  video_status?: ClassVideoStatus;
  duration_seconds?: number | null;
  is_published?: boolean;
}

export interface ProgressRow {
  progress_seconds: number;
  completed: boolean;
}

export interface ClassRepo {
  insertClass(input: NewClass): Promise<ClassRow>;
  getClass(id: string): Promise<ClassRow | null>;
  getClassByObjectKey(key: string): Promise<ClassRow | null>;
  /** Asocia una key de R2 SOLO si la clase todavía no tiene una. Devuelve null si ya tenía. */
  attachVideo(classId: string, video: { r2_object_key: string }): Promise<ClassRow | null>;
  /** Reemplaza la key de una clase cuyo video quedó en "failed". Devuelve null si ya no está en ese estado. */
  replaceFailedVideo(classId: string, video: { r2_object_key: string }): Promise<ClassRow | null>;
  updateVideoState(classId: string, patch: VideoStatePatch): Promise<ClassRow>;
  /** Borra (mejor esfuerzo) la miniatura de Storage si la URL es de nuestro bucket. */
  deleteThumbnail(url: string | null): Promise<void>;
  deleteClass(id: string): Promise<void>;
  getProgress(userId: string, classId: string): Promise<ProgressRow | null>;
  ping(): Promise<void>;
}

export type Role = "user" | "owner" | "developer";

export interface AuthedUser {
  id: string;
  /** Rol leído de la base (public.profiles) con la sesión del propio usuario. */
  role: Role;
  /** Decide con public.can_access_class() ejecutada COMO el usuario (RLS/auth.uid() reales). */
  canAccessClass(classId: string): Promise<boolean>;
}

export interface AuthPort {
  requireUser(req: Request): Promise<AuthedUser>;
  /** Propietario o desarrollador (el desarrollador es superconjunto). 403 `owner_only` si no. */
  requireOwner(req: Request): Promise<AuthedUser>;
  /** Solo desarrolladores. 403 `developer_only` si no. */
  requireDeveloper(req: Request): Promise<AuthedUser>;
}

export type R2Port = Pick<
  R2Service,
  "newObjectKey" | "createUploadUrl" | "headObject" | "deleteObject" | "signPlayback" | "bucket"
>;

export interface AppConfig {
  allowedOrigins: string[];
  playbackTtlSeconds: number;
  uploadTtlSeconds: number;
}

/** Historial de auditoría (solo inserción). Las operaciones destructivas fallan si no se puede registrar. */
export interface AuditEntry {
  actorId: string;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}

export interface AuditPort {
  record(entry: AuditEntry): Promise<void>;
}

export interface HandlerDeps {
  r2: R2Port;
  repo: ClassRepo;
  auth: AuthPort;
  audit: AuditPort;
  config: AppConfig;
}
