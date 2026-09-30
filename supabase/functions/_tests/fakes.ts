/** Dobles de prueba en memoria: R2, base de datos y autenticación. */
import { HttpError } from "../_shared/http.ts";
import { R2Error } from "../_shared/r2/r2.service.ts";
import type {
  AppConfig,
  AuditEntry,
  AuditPort,
  AuthedUser,
  AuthPort,
  ClassRepo,
  ClassRow,
  HandlerDeps,
  NewClass,
  ProgressRow,
  R2Port,
  Role,
  VideoStatePatch,
} from "../_shared/ports.ts";
import type { R2ObjectInfo, R2UploadCredentials, SignedPlayback } from "../_shared/r2/r2.types.ts";

export const NOW = 1_800_000_000;
export const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
export const USER_ID = "bbbbbbbb-0000-4000-8000-000000000002";
export const USER2_ID = "cccccccc-0000-4000-8000-000000000003";
export const DEV_ID = "dddddddd-0000-4000-8000-000000000004";

// ------------------------------------------------------------------ R2 en memoria
export class FakeR2 implements R2Port {
  readonly bucket = "test-bucket";
  objects = new Map<string, { size: number }>();
  calls: { op: string; key: string }[] = [];
  /** Si se define, la próxima llamada a esa operación falla como si R2 estuviera caído. */
  failWith: { op: string; status: number } | null = null;
  private seq = 0;

  private maybeFail(op: string): void {
    if (this.failWith && this.failWith.op === op) {
      const { status } = this.failWith;
      this.failWith = null;
      throw new R2Error(`R2 ${op} failed (${status})`, status, op);
    }
  }

  newObjectKey(classId: string): string {
    return `classes/${classId}/fake-${this.seq++}.mp4`;
  }

  createUploadUrl(key: string, ttlSeconds: number): Promise<R2UploadCredentials> {
    this.calls.push({ op: "createUploadUrl", key });
    this.maybeFail("createUploadUrl");
    return Promise.resolve({
      url: `https://fake-r2.test/${this.bucket}/${key}?sig=upload`,
      key,
      expire: NOW + ttlSeconds,
    });
  }

  headObject(key: string): Promise<R2ObjectInfo> {
    this.calls.push({ op: "headObject", key });
    this.maybeFail("headObject");
    const o = this.objects.get(key);
    return Promise.resolve(o ? { exists: true, size: o.size } : { exists: false });
  }

  deleteObject(key: string): Promise<boolean> {
    this.calls.push({ op: "deleteObject", key });
    this.maybeFail("deleteObject");
    return Promise.resolve(this.objects.delete(key));
  }

  signPlayback(key: string, ttlSeconds: number): Promise<SignedPlayback> {
    this.calls.push({ op: "signPlayback", key });
    this.maybeFail("signPlayback");
    return Promise.resolve({ url: `https://fake-r2.test/${this.bucket}/${key}?sig=play`, expiresAt: NOW + ttlSeconds });
  }

  /** Ayuda de test: simula que el navegador terminó de subir el archivo. */
  putObject(key: string, size = 1_000_000): void {
    this.objects.set(key, { size });
  }
}

// ------------------------------------------------------------------ Base de datos en memoria
export class FakeRepo implements ClassRepo {
  classes = new Map<string, ClassRow>();
  progress = new Map<string, ProgressRow>(); // key: userId|classId
  failInsert = false;
  pingFails = false;
  deleteCalls = 0;

  addClass(p: Partial<ClassRow> = {}): ClassRow {
    const row: ClassRow = {
      id: crypto.randomUUID(),
      title: "Clase",
      description: null,
      thumbnail_url: null,
      duration_seconds: null,
      level: "todos",
      category: null,
      access_level: "free",
      sort_order: 0,
      is_published: false,
      video_status: "pending",
      r2_object_key: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      ...p,
    };
    this.classes.set(row.id, row);
    return row;
  }

  insertClass(input: NewClass): Promise<ClassRow> {
    if (this.failInsert) return Promise.reject(new Error("db down"));
    return Promise.resolve({ ...this.addClass({ ...input }) });
  }
  getClass(id: string) {
    const c = this.classes.get(id);
    return Promise.resolve(c ? { ...c } : null);
  }
  getClassByObjectKey(key: string) {
    const c = [...this.classes.values()].find((c) => c.r2_object_key === key);
    return Promise.resolve(c ? { ...c } : null);
  }
  attachVideo(classId: string, video: { r2_object_key: string }) {
    const c = this.classes.get(classId);
    if (!c || c.r2_object_key) return Promise.resolve(null);
    Object.assign(c, video, { video_status: "pending", duration_seconds: null });
    return Promise.resolve({ ...c });
  }
  replaceFailedVideo(classId: string, video: { r2_object_key: string }) {
    const c = this.classes.get(classId);
    if (!c || c.video_status !== "failed") return Promise.resolve(null);
    Object.assign(c, video, { video_status: "pending", duration_seconds: null });
    return Promise.resolve({ ...c });
  }
  deletedThumbnails: (string | null)[] = [];
  failThumbnailDelete = false;
  deleteThumbnail(url: string | null) {
    if (this.failThumbnailDelete) return Promise.reject(new Error("storage down"));
    this.deletedThumbnails.push(url);
    return Promise.resolve();
  }
  updateVideoState(classId: string, patch: VideoStatePatch) {
    const c = this.classes.get(classId)!;
    const next = { ...c, ...patch };
    // Réplica del CHECK classes_published_requires_ready de la migración.
    if (next.is_published && next.video_status !== "ready") {
      return Promise.reject(new Error("violates check constraint classes_published_requires_ready"));
    }
    Object.assign(c, patch);
    return Promise.resolve({ ...c });
  }
  deleteClass(id: string) {
    this.deleteCalls++;
    this.classes.delete(id);
    return Promise.resolve();
  }
  getProgress(userId: string, classId: string) {
    return Promise.resolve(this.progress.get(`${userId}|${classId}`) ?? null);
  }
  ping() {
    return this.pingFails ? Promise.reject(new Error("db down")) : Promise.resolve();
  }
}

// ------------------------------------------------------------------ Auth simulada
export class FakeAuth implements AuthPort {
  /** userId -> clases a las que tiene entitlement */
  entitlements = new Map<string, Set<string>>();
  private tokens: Record<string, { id: string; role: Role }> = {
    owner: { id: ADMIN_ID, role: "owner" },
    developer: { id: DEV_ID, role: "developer" },
    user: { id: USER_ID, role: "user" },
    user2: { id: USER2_ID, role: "user" },
  };
  constructor(private repo: FakeRepo) {}

  private user(req: Request): AuthedUser {
    const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
    const t = m ? this.tokens[m[1]] : undefined;
    if (!t) throw new HttpError(401, "unauthenticated", "Invalid or expired session");
    const isStaff = t.role === "owner" || t.role === "developer";
    return {
      id: t.id,
      role: t.role,
      canAccessClass: (classId: string) => {
        // Réplica de public.can_access_class() de la migración.
        if (isStaff) return Promise.resolve(true);
        const c = this.repo.classes.get(classId);
        if (!c || !c.is_published || c.video_status !== "ready") return Promise.resolve(false);
        return Promise.resolve(c.access_level === "free" || (this.entitlements.get(t.id)?.has(c.id) ?? false));
      },
    };
  }
  requireUser(req: Request) {
    return Promise.resolve(this.user(req));
  }
  requireOwner(req: Request) {
    const u = this.user(req);
    if (u.role !== "owner" && u.role !== "developer") throw new HttpError(403, "owner_only", "Owner access required");
    return Promise.resolve(u);
  }
  requireDeveloper(req: Request) {
    const u = this.user(req);
    if (u.role !== "developer") throw new HttpError(403, "developer_only", "Developer access required");
    return Promise.resolve(u);
  }
}

// ------------------------------------------------------------------ Auditoría en memoria
export class FakeAudit implements AuditPort {
  entries: AuditEntry[] = [];
  fail = false;
  record(entry: AuditEntry): Promise<void> {
    if (this.fail) return Promise.reject(new Error("audit down"));
    this.entries.push(entry);
    return Promise.resolve();
  }
}

// ------------------------------------------------------------------ Armado
export function makeDeps(over: Partial<AppConfig> = {}) {
  const r2 = new FakeR2();
  const repo = new FakeRepo();
  const auth = new FakeAuth(repo);
  const audit = new FakeAudit();
  const config: AppConfig = {
    allowedOrigins: ["https://yogapopup.test"],
    playbackTtlSeconds: 7200,
    uploadTtlSeconds: 14400,
    ...over,
  };
  const deps: HandlerDeps = { r2, repo, auth, audit, config };
  return { r2, repo, auth, audit, config, deps };
}

export function post(body: unknown, token?: string, extra: Record<string, string> = {}): Request {
  return new Request("https://fn.test/x", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
