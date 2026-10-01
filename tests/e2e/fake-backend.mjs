/**
 * Backend de pruebas E2E: habla el mismo protocolo HTTP que Supabase para que la web use el
 * `supabase-js` REAL (no un doble en el navegador):
 *   /auth/v1/*       GoTrue mínimo (registro, login, sesión, recuperar, cerrar sesión)
 *   /rest/v1/*       PostgREST mínimo (filtros, orden, embebidos, RPC) con la misma regla de privilegios:
 *                    pedir la columna r2_object_key de `classes` devuelve 401, como en la base real
 *   /functions/v1/*  contrato de `playback` (la lógica real de esa función tiene sus propias pruebas en Deno)
 * Más un servidor que simula R2: exige una firma en la query (como el SigV4 real) y responde con
 * Range requests, ya que R2 no transcodifica: se sirve un único archivo progresivo.
 * Nada de esto se usa fuera de las pruebas.
 */
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { ensureMedia } from './media.mjs';

export const PRODUCT_IDS = { mat: '10000000-0000-4000-8000-000000000001', bottle: '10000000-0000-4000-8000-000000000002', soldout: '10000000-0000-4000-8000-000000000003', draft: '10000000-0000-4000-8000-000000000004' };
export const IDS = {
  free: '00000000-0000-4000-8000-000000000001',
  restricted: '00000000-0000-4000-8000-000000000002',
  second: '00000000-0000-4000-8000-000000000003',
  hidden: '00000000-0000-4000-8000-000000000004',
};
const R2_SECRET = 'e2e-r2-secret';
const KEY_OF = (classId) => `classes/${classId}/video.mp4`;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.mp4': 'video/mp4' };
const PRIVATE_COLS = ['r2_object_key'];

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fakeJwt = (sub, ttl = 3600) => `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + ttl }))}.sig`;

function seed() {
  const now = new Date().toISOString();
  const base = { updated_at: now, description: null, thumbnail_url: null, level: 'principiante', category: null, access_level: 'free', sort_order: 0, is_published: true, published_at: now, video_status: 'ready', duration_seconds: 12, created_at: now, updated_at: now, r2_object_key: KEY_OF(IDS.free) };
  return {
    users: new Map(), sessions: new Map(), recoveries: [], progress: new Map(), entitlements: new Set(),
    classes: [
      { ...base, id: IDS.free, title: 'Yoga para principiantes', description: 'Una práctica suave para empezar.\nSin prisa.', category: 'Vinyasa' },
      { ...base, id: IDS.restricted, title: 'Curso avanzado (restringido)', access_level: 'restricted', level: 'avanzado', category: 'Fuerza', sort_order: 1, r2_object_key: KEY_OF(IDS.restricted) },
      { ...base, id: IDS.second, title: 'Relajación profunda', level: 'todos', category: 'Relajación', sort_order: 2, r2_object_key: KEY_OF(IDS.second) },
      { ...base, id: IDS.hidden, title: 'Borrador oculto', is_published: false, published_at: null, r2_object_key: KEY_OF(IDS.hidden) },
    ],
    products: [
      { id: '10000000-0000-4000-8000-000000000001', title: 'Mat de yoga Premium', description: 'Antideslizante, 6 mm.\nIncluye banda.', image_url: null, price_cents: 1899, stock: null, category: 'Mats', sort_order: 0, is_active: true, created_at: now },
      { id: '10000000-0000-4000-8000-000000000002', title: 'Botella térmica', description: null, image_url: null, price_cents: 1499, stock: 3, category: 'Accesorios', sort_order: 1, is_active: true, created_at: now },
      { id: '10000000-0000-4000-8000-000000000003', title: 'Remera Pop Up', description: 'Algodón orgánico.', image_url: null, price_cents: 1999, stock: 0, category: 'Ropa', sort_order: 2, is_active: true, created_at: now },
      { id: '10000000-0000-4000-8000-000000000004', title: 'Producto borrador', description: null, image_url: null, price_cents: 500, stock: null, category: 'Ropa', sort_order: 3, is_active: false, created_at: now },
    ],
    behavior: { catalogLatencyMs: 0, catalogFail: false, playbackTtl: 120, playbackForce: null, confirmEmail: false, saveFail: false },
    log: { saves: [], playbackCalls: [], r2: [], products: [], storage: [] },
    storage: new Map(), // Storage simulado: 'product-images/<ruta>' -> { type, data }
  };
}

export async function startBackend({ siteRoot, ports = { site: 4173, api: 4174, cdn: 4175 }, progressIntervalSeconds: initialInterval = 2 }) {
  let progressIntervalSeconds = initialInterval; // se puede cambiar por prueba con setProgressInterval()
  let db = seed();
  const mediaFile = ensureMedia(KEY_OF(IDS.free)); // todas las clases de prueba reusan el mismo archivo de video
  const origin = { site: `http://127.0.0.1:${ports.site}`, api: `http://127.0.0.1:${ports.api}`, cdn: `http://127.0.0.1:${ports.cdn}` };

  // ------------------------------------------------------------------ utilidades HTTP
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, prefer, range, accept-profile, content-profile, x-supabase-api-version, x-retry-count, x-upsert, cache-control',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'content-range',
  };
  const send = (res, status, body, headers = {}) => {
    const isObj = body !== null && typeof body === 'object';
    res.writeHead(status, { ...CORS, ...(isObj ? { 'Content-Type': 'application/json' } : {}), ...headers });
    res.end(status === 204 ? undefined : isObj ? JSON.stringify(body) : body);
  };
  const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
  const bearerUser = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const userId = m && db.sessions.get(m[1]);
    return userId ? [...db.users.values()].find((u) => u.id === userId) : null;
  };

  // ------------------------------------------------------------------ GoTrue mínimo
  const userJson = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: new Date().toISOString(), app_metadata: {}, user_metadata: { full_name: u.name }, created_at: new Date().toISOString() });
  const sessionFor = (u) => {
    const access = fakeJwt(u.id);
    db.sessions.set(access, u.id);
    const refresh = randomUUID();
    db.sessions.set(`refresh:${refresh}`, u.id);
    return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: refresh, user: userJson(u) };
  };
  const authErr = (res, status, code, msg) => send(res, status, { code: status, error_code: code, msg });

  async function auth(req, res, url) {
    const path = url.pathname.replace('/auth/v1', '');
    const body = req.method === 'GET' ? {} : await readBody(req);
    if (path === '/token' && url.searchParams.get('grant_type') === 'password') {
      const u = db.users.get(String(body.email).toLowerCase());
      if (!u || u.password !== body.password) return authErr(res, 400, 'invalid_credentials', 'Invalid login credentials');
      return send(res, 200, sessionFor(u));
    }
    if (path === '/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const id = db.sessions.get(`refresh:${body.refresh_token}`);
      const u = [...db.users.values()].find((x) => x.id === id);
      return u ? send(res, 200, sessionFor(u)) : authErr(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token');
    }
    if (path === '/signup') {
      const email = String(body.email || '').toLowerCase();
      if (db.users.has(email)) return authErr(res, 422, 'user_already_exists', 'User already registered');
      if (String(body.password || '').length < 6) return authErr(res, 422, 'weak_password', 'Password should be at least 6 characters');
      const u = { id: randomUUID(), email, password: body.password, name: body.data?.full_name || '', role: 'user' };
      db.users.set(email, u);
      return send(res, 200, db.behavior.confirmEmail ? userJson(u) : sessionFor(u));
    }
    if (path === '/user' && req.method === 'GET') {
      const u = bearerUser(req);
      return u ? send(res, 200, userJson(u)) : authErr(res, 401, 'bad_jwt', 'invalid JWT');
    }
    if (path === '/user' && req.method === 'PUT') {
      const u = bearerUser(req);
      if (!u) return authErr(res, 401, 'bad_jwt', 'invalid JWT');
      if (body.password) u.password = body.password;
      return send(res, 200, userJson(u));
    }
    if (path === '/logout') { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (m) db.sessions.delete(m[1]); return send(res, 204); }
    if (path === '/recover') { db.recoveries.push(body.email); return send(res, 200, {}); }
    return authErr(res, 404, 'not_found', 'not found');
  }

  // ------------------------------------------------------------------ PostgREST mínimo
  const coerce = (v) => (v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : v !== '' && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
  function applyFilters(rows, params) {
    let out = rows;
    for (const [key, val] of params) {
      if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
      const m = /^(eq|gt|is)\.(.*)$/.exec(val);
      if (!m) continue;
      const want = coerce(m[2]);
      out = out.filter((r) => (m[1] === 'eq' || m[1] === 'is' ? r[key] === want : Number(r[key]) > Number(want)));
    }
    const order = params.get('order');
    if (order) {
      const keys = order.split(',').map((o) => { const [col, dir] = o.split('.'); return [col, dir === 'desc' ? -1 : 1]; });
      out = [...out].sort((a, b) => {
        for (const [col, dir] of keys) { if (a[col] === b[col]) continue; if (a[col] == null) return 1; if (b[col] == null) return -1; return (a[col] > b[col] ? 1 : -1) * dir; }
        return 0;
      });
    }
    return params.get('limit') ? out.slice(0, Number(params.get('limit'))) : out;
  }
  const isStaff = (u) => Boolean(u) && (u.role === 'owner' || u.role === 'developer');
  const readRaw = (req) => new Promise((resolve) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
  const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c]]));
  const classPublic = (c) => { const { r2_object_key, ...rest } = c; return rest; };

  async function rest(req, res, url) {
    const table = url.pathname.replace('/rest/v1/', '');
    const p = url.searchParams;
    const user = bearerUser(req);
    const wantsObject = (req.headers.accept || '').includes('vnd.pgrst.object');
    const reply = (rows) => {
      if (wantsObject) return rows.length === 1 ? send(res, 200, rows[0]) : send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
      return send(res, 200, rows);
    };

    if (table === 'rpc/save_progress' && req.method === 'POST') {
      if (!user) return send(res, 401, { code: 'PGRST301', message: 'JWT required' });
      if (db.behavior.saveFail) return send(res, 503, { message: 'unavailable' });
      const { p_class_id: classId, p_seconds: seconds } = await readBody(req);
      const c = db.classes.find((x) => x.id === classId);
      if (!c || !canAccess(user, c)) return send(res, 403, { code: '42501', message: 'forbidden' });
      const clamped = Math.max(0, Math.min(Number(seconds), c.duration_seconds ?? Number(seconds)));
      const key = `${user.id}|${classId}`;
      const prev = db.progress.get(key);
      const completed = Boolean(prev?.completed) || (c.duration_seconds != null && clamped >= c.duration_seconds * 0.95);
      const row = { user_id: user.id, class_id: classId, progress_seconds: clamped, completed, last_watched_at: new Date().toISOString() };
      db.progress.set(key, row);
      db.log.saves.push({ userId: user.id, classId, seconds: clamped, at: Date.now() });
      return send(res, 200, row);
    }

    if (table === 'classes' && req.method === 'GET') {
      const select = (p.get('select') || '*');
      if (select === '*' || PRIVATE_COLS.some((c) => select.includes(c))) return send(res, 401, { code: '42501', message: 'permission denied for table classes' });
      if (db.behavior.catalogLatencyMs) await new Promise((r) => setTimeout(r, db.behavior.catalogLatencyMs));
      if (db.behavior.catalogFail) return send(res, 503, { message: 'Service Unavailable' });
      const cols = select.split(',');
      const visible = db.classes.filter((c) => c.is_published || isStaff(user)).map(classPublic); // RLS: público = publicadas; propietario/desarrollador = todas
      return reply(applyFilters(visible, p).map((r) => pick(r, cols)));
    }

    if (table === 'products' && req.method === 'GET') {
      if (db.behavior.catalogFail) return send(res, 503, { message: 'Service Unavailable' });
      const cols = (p.get('select') || '*').split(',');
      const visible = db.products.filter((x) => x.is_active || isStaff(user)).map((x) => ({ updated_at: x.created_at, ...x })); // RLS: el público solo ve los activos
      return reply(applyFilters(visible, p).map((r) => pick(r, cols)));
    }

    // Escrituras de products: solo propietario/desarrollador (RLS de la Fase 12) + los CHECK de la tabla.
    if (table === 'products' && ['POST', 'PATCH', 'DELETE'].includes(req.method)) {
      if (!user) return send(res, 401, { code: 'PGRST301', message: 'JWT required' });
      if (!isStaff(user)) return send(res, 403, { code: '42501', message: 'new row violates row-level security policy for table "products"' });
      const EDITABLE = ['title', 'description', 'image_url', 'price_cents', 'stock', 'category', 'sort_order', 'is_active'];
      const checkFail = () => send(res, 400, { code: '23514', message: 'new row for relation "products" violates check constraint' });
      const valid = (v) => (!('title' in v) || (typeof v.title === 'string' && v.title.trim() !== '' && v.title.length <= 150))
        && (!('price_cents' in v) || (Number.isInteger(v.price_cents) && v.price_cents >= 0))
        && (!('stock' in v) || v.stock === null || (Number.isInteger(v.stock) && v.stock >= 0));
      const cols = (p.get('select') || '*').split(',');
      const out = (rows) => reply(rows.map((r) => pick({ updated_at: r.created_at, ...r }, cols)));
      if (req.method === 'POST') {
        const body = await readBody(req);
        const fields = Object.fromEntries(Object.entries(body).filter(([k]) => EDITABLE.includes(k)));
        if (!valid(fields) || !('title' in fields) || !('price_cents' in fields)) return checkFail();
        const row = { description: null, image_url: null, stock: null, category: null, sort_order: 0, is_active: false, ...fields, id: randomUUID(), created_at: new Date().toISOString() };
        db.products.push(row);
        db.log.products.push({ op: 'insert', id: row.id });
        return out([row]);
      }
      const targets = applyFilters(db.products, p);
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const fields = Object.fromEntries(Object.entries(body).filter(([k]) => EDITABLE.includes(k)));
        if (!valid(fields)) return checkFail();
        for (const r of targets) Object.assign(r, fields);
        if (targets.length) db.log.products.push({ op: 'update', id: targets[0].id, fields: Object.keys(fields) });
        return out(targets);
      }
      db.products = db.products.filter((r) => !targets.includes(r));
      if (targets.length) db.log.products.push({ op: 'delete', id: targets[0].id });
      return out(targets);
    }

    if (table === 'profiles' && req.method === 'GET') {
      if (!user) return send(res, 200, []);
      const cols = (p.get('select') || 'display_name').split(',');
      return reply(applyFilters([{ id: user.id, display_name: user.name || null, role: user.role }], p).map((r) => pick(r, cols)));
    }
    if (table === 'profiles' && req.method === 'PATCH') {
      if (!user) return send(res, 401, { code: 'PGRST301', message: 'JWT required' });
      const patch = await readBody(req);
      if ('role' in patch) return send(res, 403, { code: '42501', message: 'permission denied for table profiles' });
      user.name = patch.display_name ?? '';
      return send(res, 204);
    }

    if (table === 'video_progress' && req.method === 'GET') {
      if (!user) return send(res, 200, []);
      const mine = [...db.progress.values()].filter((r) => r.user_id === user.id);
      const select = p.get('select') || '';
      const embed = /classes\(([^)]*)\)/.exec(select);
      const baseCols = select.replace(/,?classes\([^)]*\)/, '').split(',').filter(Boolean);
      let rows = applyFilters(mine, p).map((r) => ({
        ...pick(r, baseCols),
        ...(embed ? { classes: (() => { const c = db.classes.find((x) => x.id === r.class_id && x.is_published); return c ? pick(classPublic(c), embed[1].split(',')) : null; })() } : {}),
      }));
      return reply(rows);
    }
    return send(res, 404, { message: `relation ${table} not found` });
  }

  function canAccess(user, c) {
    if (user.role === 'owner' || user.role === 'developer') return true;
    if (!c.is_published || c.video_status !== 'ready') return false;
    return c.access_level === 'free' || db.entitlements.has(`${user.id}|${c.id}`);
  }

  // ------------------------------------------------------------------ Edge Function: contrato de `playback`
  async function playback(req, res) {
    const fail = (status, code, message) => send(res, status, { error: { code, message } });
    const user = bearerUser(req);
    if (!user) return fail(401, 'unauthenticated', 'Invalid or expired session');
    const { class_id: classId } = await readBody(req);
    db.log.playbackCalls.push({ at: Date.now(), classId, userId: user.id });
    const force = db.behavior.playbackForce;
    if (force) return fail(force.status, force.code, force.code);
    const c = db.classes.find((x) => x.id === classId);
    if (!c || !canAccess(user, c)) return fail(403, 'no_access', "You don't have access to this class");
    const ttl = db.behavior.firstTtl != null ? db.behavior.firstTtl : db.behavior.playbackTtl;
    db.behavior.firstTtl = null; // de un solo uso
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    const sig = createHmac('sha256', R2_SECRET).update(`${c.r2_object_key}:${expiresAt}`).digest('base64url');
    const prog = db.progress.get(`${user.id}|${c.id}`);
    const s = prog?.progress_seconds ?? 0;
    const finished = c.duration_seconds != null && s >= c.duration_seconds * 0.95;
    return send(res, 200, {
      class_id: c.id, title: c.title, duration_seconds: c.duration_seconds,
      video_url: `${origin.cdn}/${c.r2_object_key}?X-Amz-Expires=${ttl}&X-Amz-Signature=${sig}&X-Amz-ExpiresAt=${expiresAt}`,
      expires_at: expiresAt, resume_seconds: s < 5 || finished ? 0 : s, completed: prog?.completed ?? false,
    });
  }


  // ------------------------------------------------------------------ Storage simulado (bucket público `product-images`)
  const multipartFile = (buf, contentType) => {
    const boundary = /boundary=([^;]+)/.exec(contentType || '')?.[1];
    if (!boundary) return { type: contentType || 'application/octet-stream', data: buf };
    const delim = Buffer.from(`--${boundary}`);
    let from = buf.indexOf(delim);
    while (from >= 0) {
      const next = buf.indexOf(delim, from + delim.length);
      if (next < 0) break;
      const part = buf.subarray(from + delim.length + 2, next - 2); // sin CRLF inicial ni final
      const split = part.indexOf('\r\n\r\n');
      const head = part.subarray(0, split).toString();
      if (/filename=/.test(head)) return { type: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] || 'application/octet-stream', data: part.subarray(split + 4) };
      from = next;
    }
    return { type: 'application/octet-stream', data: buf };
  };
  const denied = (res) => send(res, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });

  async function storage(req, res, url) {
    const user = bearerUser(req);
    const path = decodeURIComponent(url.pathname.replace('/storage/v1/object/', ''));
    if (req.method === 'GET' && path.startsWith('public/')) {
      const file = db.storage.get(path.replace('public/', ''));
      if (!file) return send(res, 404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      res.writeHead(200, { ...CORS, 'Content-Type': file.type, 'Cache-Control': 'no-store' });
      return res.end(file.data);
    }
    if (req.method === 'DELETE' && path === 'product-images') {
      if (!isStaff(user)) return denied(res);
      const { prefixes = [] } = await readBody(req);
      for (const key of prefixes) { db.storage.delete(`product-images/${key}`); db.log.storage.push({ op: 'delete', path: key }); }
      return send(res, 200, prefixes.map((name) => ({ name })));
    }
    if (['POST', 'PUT'].includes(req.method) && path.startsWith('product-images/')) {
      if (!isStaff(user)) return denied(res);
      const file = multipartFile(await readRaw(req), req.headers['content-type']);
      if (file.data.length > 2 * 1024 * 1024 || !/^image\/(jpeg|png|webp)$/.test(file.type)) return send(res, 400, { statusCode: '415', error: 'invalid_mime_type', message: 'mime type not supported or file too large' });
      db.storage.set(path, file);
      db.log.storage.push({ op: 'upload', path: path.replace('product-images/', ''), type: file.type, bytes: file.data.length });
      return send(res, 200, { Key: path });
    }
    return send(res, 404, { message: 'not found' });
  }

  // ------------------------------------------------------------------ servidores
  const api = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin.api);
    if (req.method === 'OPTIONS') return send(res, 204);
    try {
      if (url.pathname === '/__test/reset') { db = seed(); return send(res, 200, { ok: true }); }
      if (url.pathname === '/__test/behavior') { Object.assign(db.behavior, await readBody(req)); return send(res, 200, db.behavior); }
      if (url.pathname === '/__test/state') return send(res, 200, { log: db.log, progress: [...db.progress.values()], recoveries: db.recoveries, users: [...db.users.values()].map((u) => ({ email: u.email, name: u.name })), products: db.products, storageKeys: [...db.storage.keys()] });
      if (url.pathname === '/__test/entitle') { const b = await readBody(req); db.entitlements.add(`${[...db.users.values()].find((u) => u.email === b.email)?.id}|${b.classId}`); return send(res, 200, { ok: true }); }
      if (url.pathname === '/__test/product') { const b = await readBody(req); const row = db.products.find((x) => x.id === b.id); if (row) Object.assign(row, b.patch); return send(res, 200, { ok: !!row }); }
      if (url.pathname === '/__test/promote') { const b = await readBody(req); const u = [...db.users.values()].find((u) => u.email === b.email); if (u) u.role = b.role; return send(res, 200, { ok: true }); }
      if (url.pathname.startsWith('/auth/v1/')) return await auth(req, res, url);
      if (url.pathname.startsWith('/rest/v1/')) return await rest(req, res, url);
      if (url.pathname.startsWith('/storage/v1/object/')) return await storage(req, res, url);
      if (url.pathname === '/functions/v1/health') return send(res, 200, { ok: true });
      if (url.pathname === '/auth/v1/settings') return send(res, 200, { external: { email: true }, disable_signup: false, mailer_autoconfirm: false });
      if (url.pathname === '/functions/v1/playback') return await playback(req, res);
      return send(res, 404, { message: 'not found' });
    } catch (e) { console.error('[fake-backend]', e); return send(res, 500, { message: String(e) }); }
  });

  // R2 simulado: exige la firma en la query (como el SigV4 real) y sirve un único archivo con Range.
  const cdn = http.createServer((req, res) => {
    const url = new URL(req.url, origin.cdn);
    const key = decodeURIComponent(url.pathname.slice(1));
    const record = (status) => db.log.r2.push({ status, key, at: Date.now() });
    const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end(); }
    const deny = (status, why) => { record(status); res.writeHead(status, h); res.end(why); };
    const sig = url.searchParams.get('X-Amz-Signature');
    const expiresAt = Number(url.searchParams.get('X-Amz-ExpiresAt'));
    if (!sig || !expiresAt) return deny(403, 'signature required');
    const expected = createHmac('sha256', R2_SECRET).update(`${key}:${expiresAt}`).digest('base64url');
    if (sig !== expected) return deny(403, 'bad signature');
    if (expiresAt < Math.floor(Date.now() / 1000)) return deny(403, 'expired');
    if (db.behavior.cdnRejectAll) return deny(403, 'rejected by test');
    const file = normalize(mediaFile); // todas las clases de prueba comparten el mismo mp4 de fixture
    if (!existsSync(file) || !statSync(file).isFile()) { record(404); res.writeHead(404, h); return res.end(); }
    const size = statSync(file).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    record(range ? 206 : 200);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { ...h, 'Content-Type': MIME['.mp4'], 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...h, 'Content-Type': MIME['.mp4'], 'Accept-Ranges': 'bytes', 'Content-Length': size });
    createReadStream(file).pipe(res);
  });

  // Sitio estático: /js/config.js apunta al backend de pruebas.
  const site = http.createServer((req, res) => {
    const url = new URL(req.url, origin.site);
    if (url.pathname === '/js/config.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'] });
      return res.end(`window.YOGAPOPUP_CONFIG = Object.freeze({ SUPABASE_URL: '${origin.api}', SUPABASE_ANON_KEY: 'e2e-anon-key', FUNCTIONS_URL: '${origin.api}/functions/v1', PRIVACY_URL: '', PROGRESS_INTERVAL_SECONDS: ${progressIntervalSeconds} });`);
    }
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(siteRoot, path));
    if (!file.startsWith(siteRoot) || /(^|[\\/])\.(env|git)/.test(file) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });

  await Promise.all([[site, ports.site], [api, ports.api], [cdn, ports.cdn]].map(([s, port]) => new Promise((r) => s.listen(port, '127.0.0.1', r))));
  const control = (path, body) => fetch(`${origin.api}/__test/${path}`, { method: 'POST', body: JSON.stringify(body || {}) }).then((r) => r.json());
  return {
    origin, IDS, PRODUCT_IDS,
    reset: () => { progressIntervalSeconds = initialInterval; return control('reset'); },
    setProgressInterval: (n) => { progressIntervalSeconds = n; },
    behavior: (b) => control('behavior', b),
    entitle: (email, classId) => control('entitle', { email, classId }),
    promote: (email, role) => control('promote', { email, role }),
    patchProduct: (id, patch) => control('product', { id, patch }),
    state: () => fetch(`${origin.api}/__test/state`).then((r) => r.json()),
    close: () => Promise.all([site, api, cdn].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))),
  };
}
