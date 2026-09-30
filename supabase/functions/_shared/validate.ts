import { HttpError } from "./http.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LEVELS = ["principiante", "intermedio", "avanzado", "todos"] as const;
export const ACCESS_LEVELS = ["free", "restricted"] as const;

export type Level = typeof LEVELS[number];
export type AccessLevel = typeof ACCESS_LEVELS[number];

export function parseUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HttpError(400, "invalid_input", `${field} must be a valid UUID`);
  }
  return value.toLowerCase();
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "invalid_input", `${field} must be a string`);
  const v = value.trim();
  if (v.length > max) throw new HttpError(400, "invalid_input", `${field} must be at most ${max} characters`);
  return v || null;
}

export interface CreateClassInput {
  classId: string | null;
  title: string;
  description: string | null;
  category: string | null;
  level: Level;
  accessLevel: AccessLevel;
  sortOrder: number;
}

/** Valida el body de admin-create-upload. Campos desconocidos se ignoran. */
export function parseCreateClassInput(body: Record<string, unknown>): CreateClassInput {
  const title = optionalString(body.title, "title", 150);
  if (!title) throw new HttpError(400, "invalid_input", "title is required");

  const level = body.level === undefined || body.level === null ? "todos" : body.level;
  if (!(LEVELS as readonly unknown[]).includes(level)) {
    throw new HttpError(400, "invalid_input", `level must be one of: ${LEVELS.join(", ")}`);
  }
  const access = body.access_level === undefined || body.access_level === null ? "free" : body.access_level;
  if (!(ACCESS_LEVELS as readonly unknown[]).includes(access)) {
    throw new HttpError(400, "invalid_input", `access_level must be one of: ${ACCESS_LEVELS.join(", ")}`);
  }
  const sort = body.sort_order === undefined || body.sort_order === null ? 0 : body.sort_order;
  if (typeof sort !== "number" || !Number.isInteger(sort) || Math.abs(sort) > 100_000) {
    throw new HttpError(400, "invalid_input", "sort_order must be an integer");
  }

  return {
    classId: body.class_id === undefined || body.class_id === null ? null : parseUuid(body.class_id, "class_id"),
    title,
    description: optionalString(body.description, "description", 5000),
    category: optionalString(body.category, "category", 60),
    level: level as Level,
    accessLevel: access as AccessLevel,
    sortOrder: sort,
  };
}
