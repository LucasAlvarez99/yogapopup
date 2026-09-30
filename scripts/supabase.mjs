#!/usr/bin/env node
/**
 * Atajo para el CLI de Supabase que lee el .env de la RAÍZ del proyecto (sin dependencias).
 *
 *   npm run sb:link       -> supabase link --project-ref $SUPABASE_PROJECT_REF
 *   npm run sb:db-push    -> supabase db push        (aplica supabase/migrations/)
 *   npm run sb:secrets    -> supabase secrets set --env-file supabase/.env
 *   npm run sb:deploy     -> supabase functions deploy
 *
 * Agregar --dry-run muestra el comando sin ejecutarlo.
 * Cualquier otro comando se pasa tal cual:  npm run sb -- functions list
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Parser mínimo de .env: KEY=VALUE, comentarios con #, comillas opcionales. */
function loadEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const fileEnv = loadEnv(join(root, ".env"));
const env = { ...fileEnv, ...process.env }; // lo ya exportado en la terminal tiene prioridad

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [cmd, ...rest] = args.filter((a) => a !== "--dry-run");

function need(name) {
  const v = env[name]?.trim();
  if (!v) {
    console.error(`Falta ${name}. Completalo en el archivo .env de la raíz (ver .env.example).`);
    process.exit(1);
  }
  return v;
}

const presets = {
  link: () => ["link", "--project-ref", need("SUPABASE_PROJECT_REF")],
  "db-push": () => ["db", "push"],
  secrets: () => ["secrets", "set", "--env-file", "supabase/.env", "--project-ref", need("SUPABASE_PROJECT_REF")],
  deploy: () => ["functions", "deploy", "--project-ref", need("SUPABASE_PROJECT_REF")],
};

const supabaseArgs = presets[cmd] ? presets[cmd]() : [cmd, ...rest].filter(Boolean);
if (supabaseArgs.length === 0) {
  console.error("Uso: npm run sb:link | sb:db-push | sb:secrets | sb:deploy  (o: npm run sb -- <comando de supabase>)");
  process.exit(1);
}

const bin = join(root, "node_modules", ".bin", process.platform === "win32" ? "supabase.cmd" : "supabase");
console.log(`> supabase ${supabaseArgs.join(" ")}`);
if (dryRun) process.exit(0);

const res = spawnSync(bin, supabaseArgs, { cwd: root, stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(res.status ?? 1);
