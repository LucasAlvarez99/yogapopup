import { cfg } from './env.js';
import { supabase } from './supabase.js';
import { accessToken } from './session.js';
import { AppError } from './errors.js';
import { storagePathFromPublicUrl } from './product-form.js';

/**
 * Acceso a datos y a las Edge Functions.
 * Regla: con `classes` NUNCA usar select('*'): la key de R2 está restringida en la base
 * (privilegios por columna) y pedirlas falla. Por eso las columnas se listan explícitamente.
 */
export const CLASS_COLUMNS =
  'id,title,description,thumbnail_url,duration_seconds,level,category,access_level,sort_order,is_published,published_at,video_status,created_at,updated_at';
const CARD_COLUMNS = 'id,title,thumbnail_url,duration_seconds,level,category,access_level';

function db() {
  if (!supabase) throw new AppError('not_configured');
  return supabase;
}

function unwrap({ data, error }) {
  if (error) throw new AppError(error.code === 'PGRST301' ? 'unauthenticated' : 'internal_error', error.message);
  return data;
}

// ---------------------------------------------------------------- tienda (público)
export const PRODUCT_COLUMNS = 'id,title,description,image_url,price_cents,stock,category,sort_order,created_at';

/** Productos activos (la base solo deja ver esos a quien no es propietario). */
export async function listActiveProducts() {
  return unwrap(await db().from('products').select(PRODUCT_COLUMNS).eq('is_active', true)
    .order('sort_order', { ascending: true }).order('created_at', { ascending: false })) ?? [];
}

/** null si no existe o no está activo (para el público son lo mismo: no se revela que existe). */
export async function getProduct(id) {
  return unwrap(await db().from('products').select(PRODUCT_COLUMNS).eq('id', id).eq('is_active', true).maybeSingle());
}

// ---------------------------------------------------------------- catálogo (público) y progreso
export async function listPublishedClasses({ limit } = {}) {
  let q = db().from('classes').select(CLASS_COLUMNS).eq('is_published', true)
    .order('sort_order', { ascending: true }).order('published_at', { ascending: false });
  if (limit) q = q.limit(limit);
  return unwrap(await q) ?? [];
}

export async function getClass(id) {
  return unwrap(await db().from('classes').select(CLASS_COLUMNS).eq('id', id).maybeSingle());
}

/** Progreso propio de todas las clases: { [classId]: { progress_seconds, completed } } */
export async function getMyProgressMap() {
  const rows = unwrap(await db().from('video_progress').select('class_id,progress_seconds,completed')) ?? [];
  return Object.fromEntries(rows.map((r) => [r.class_id, { progress_seconds: r.progress_seconds, completed: r.completed }]));
}

/** "Continuar viendo": clases empezadas y no terminadas, la más reciente primero. */
export async function listContinueWatching(limit = 6) {
  const rows = unwrap(await db().from('video_progress')
    .select(`progress_seconds,completed,last_watched_at,classes(${CARD_COLUMNS})`)
    .eq('completed', false).gt('progress_seconds', 4)
    .order('last_watched_at', { ascending: false }).limit(limit)) ?? [];
  return rows.filter((r) => r.classes); // una clase despublicada después ya no se muestra
}

export async function saveProgress(classId, seconds) {
  const { error } = await db().rpc('save_progress', { p_class_id: classId, p_seconds: Math.floor(seconds) });
  if (error) throw new AppError(error.code === '42501' ? 'no_access' : 'internal_error', error.message);
}

/**
 * Guardado al cerrar/ocultar la pestaña: fetch con `keepalive`, que el navegador completa aunque la
 * página se cierre. Usa el token ya cacheado (no se puede esperar a una promesa al descargar la página).
 */
export function saveProgressOnUnload(classId, seconds) {
  const token = accessToken();
  if (!token || !cfg.SUPABASE_URL) return;
  try {
    fetch(`${cfg.SUPABASE_URL}/rest/v1/rpc/save_progress`, {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ p_class_id: classId, p_seconds: Math.floor(seconds) }),
    }).catch(() => {});
  } catch { /* nada más que hacer al cerrar */ }
}

// ---------------------------------------------------------------- Edge Functions
export const FUNCTION_TIMEOUT_MS = 30_000;

export async function callFunction(name, body = {}, { timeoutMs = FUNCTION_TIMEOUT_MS } = {}) {
  const token = accessToken();
  if (!token) throw new AppError('unauthenticated');
  // Sin tope, una función colgada dejaba el botón en "cargando" para siempre.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${cfg.FUNCTIONS_URL}/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: cfg.SUPABASE_ANON_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    throw new AppError('network');
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new AppError(json?.error?.code || 'internal_error', json?.error?.message, res.status);
  return json;
}

/** URL firmada de R2 (mp4 progresivo) + punto de reanudación. Falla con no_access / video_not_ready / class_not_found. */
export const getPlayback = (classId) => callFunction('playback', { class_id: classId });

// ---------------------------------------------------------------- administración
export async function adminListClasses() {
  return unwrap(await db().from('classes').select(CLASS_COLUMNS).order('created_at', { ascending: false })) ?? [];
}

export const adminCreateUpload = (payload) => callFunction('admin-create-upload', payload);
export const adminSyncVideo = (classId, durationSeconds) =>
  callFunction('admin-sync-video', { class_id: classId, duration_seconds: durationSeconds ?? undefined });
export const adminDeleteClass = (classId) => callFunction('admin-delete-class', { class_id: classId });

const EDITABLE = ['title', 'description', 'thumbnail_url', 'level', 'category', 'access_level', 'sort_order', 'is_published'];

/** Edita metadatos y publica/despublica. La base rechaza publicar una clase sin video listo. */
export async function adminUpdateClass(id, patch) {
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => EDITABLE.includes(k)));
  const { data, error } = await db().from('classes').update(clean).eq('id', id).select(CLASS_COLUMNS).single();
  if (error) {
    if (error.code === '23514') throw new AppError('video_not_ready', 'No se puede publicar: el video todavía no está listo.');
    throw new AppError('internal_error', error.message);
  }
  return data;
}

// ---------------------------------------------------------------- miniaturas (Supabase Storage)
export const THUMB_BUCKET = 'class-thumbnails';

/** Sube la miniatura (ya reducida) y devuelve su URL pública. */
export async function uploadThumbnail(classId, blob) {
  const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${classId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await db().storage.from(THUMB_BUCKET).upload(path, blob, { contentType: blob.type, cacheControl: '31536000' });
  if (error) throw new AppError('internal_error', 'No se pudo subir la miniatura.');
  return db().storage.from(THUMB_BUCKET).getPublicUrl(path).data.publicUrl;
}

export async function deleteThumbnailByUrl(url) {
  const marker = `/storage/v1/object/public/${THUMB_BUCKET}/`;
  const i = String(url || '').indexOf(marker);
  if (i < 0) return;
  await db().storage.from(THUMB_BUCKET).remove([decodeURIComponent(url.slice(i + marker.length).split('?')[0])]);
}

// ---------------------------------------------------------------- administración de productos (Fase 14)
// Mismo patrón que las clases: la base (RLS + privilegio por columna) decide quién escribe; esto solo arma las consultas.
export const PRODUCT_ADMIN_COLUMNS = `${PRODUCT_COLUMNS},is_active,updated_at`;
const PRODUCT_EDITABLE = ['title', 'description', 'image_url', 'price_cents', 'stock', 'category', 'sort_order', 'is_active'];

const pickProductFields = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => PRODUCT_EDITABLE.includes(k)));

function productError(error) {
  if (error.code === '42501') return new AppError('owner_only');
  if (error.code === '23514') return new AppError('invalid_input', 'Revisá los datos: hay un valor fuera de rango (precio, stock o largo de un texto).');
  if (error.code === 'PGRST116') return new AppError('product_not_found');
  return new AppError('internal_error', error.message);
}

/** Todos los productos, activos e inactivos (la base solo deja ver los inactivos al propietario). */
export async function adminListProducts() {
  return unwrap(await db().from('products').select(PRODUCT_ADMIN_COLUMNS).order('created_at', { ascending: false })) ?? [];
}

export async function adminCreateProduct(input) {
  const { data, error } = await db().from('products').insert(pickProductFields(input)).select(PRODUCT_ADMIN_COLUMNS).single();
  if (error) throw productError(error);
  return data;
}

export async function adminUpdateProduct(id, patch) {
  const { data, error } = await db().from('products').update(pickProductFields(patch)).eq('id', id).select(PRODUCT_ADMIN_COLUMNS).single();
  if (error) throw productError(error);
  return data;
}

/** Borra el producto. Si no se borró ninguna fila (no existe o no hay permiso), avisa en vez de simular éxito. */
export async function adminDeleteProduct(id) {
  const { data, error } = await db().from('products').delete().eq('id', id).select('id');
  if (error) throw productError(error);
  if (!data || data.length === 0) throw new AppError('product_not_found');
}

// ---------------------------------------------------------------- imágenes de producto (Supabase Storage)
export const PRODUCT_IMAGE_BUCKET = 'product-images';

/** Sube la imagen (ya reducida) y devuelve su URL pública. */
export async function uploadProductImage(productId, blob) {
  const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${productId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await db().storage.from(PRODUCT_IMAGE_BUCKET).upload(path, blob, { contentType: blob.type, cacheControl: '31536000' });
  if (error) throw new AppError('internal_error', 'No se pudo subir la imagen.');
  return db().storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Borra la imagen SOLO si la URL es de nuestro bucket (nunca algo externo ni fuera de su carpeta). */
export async function deleteProductImageByUrl(url) {
  const path = storagePathFromPublicUrl(url, PRODUCT_IMAGE_BUCKET);
  if (!path) return;
  await db().storage.from(PRODUCT_IMAGE_BUCKET).remove([path]);
}

// ---------------------------------------------------------------- subida del video (PUT directo a R2)
/**
 * Sube el archivo directo a R2 con la URL prefirmada que dio admin-create-upload
 * (el archivo no pasa por el backend). Es un PUT simple (no reanudable):
 * si la subida se corta, hay que volver a pedir credenciales y subir el archivo entero de nuevo.
 * @returns {{ promise: Promise<void>, abort: () => void }}
 */
export function uploadVideoToR2(file, upload, { onProgress } = {}) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('PUT', upload.url, true);
    xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded, e.total); };
    xhr.onerror = () => reject(new AppError('upload_failed', 'La subida falló: error de red.'));
    xhr.onabort = () => reject(new AppError('upload_failed', 'Subida cancelada.'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new AppError('upload_failed', `La subida falló (estado ${xhr.status}).`));
    };
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

/** Duración del video, leída en el navegador (R2 no la calcula: no transcodifica). */
export function readVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    // Un formato que el navegador no decodifica puede no disparar ni onloadedmetadata ni onerror: sin tope colgaba la subida.
    const timer = setTimeout(() => fail(), 10_000);
    const done = () => { clearTimeout(timer); URL.revokeObjectURL(url); };
    const fail = () => { done(); reject(new AppError('invalid_input', 'No se pudo leer el archivo de video.')); };
    v.onloadedmetadata = () => { done(); resolve(v.duration); };
    v.onerror = fail;
    v.src = url;
  });
}

/** Reduce una imagen a un ancho máximo y la convierte a WebP (ahorra almacenamiento y ancho de banda). */
export async function resizeImage(file, { maxWidth = 1280, quality = 0.82 } = {}) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new AppError('invalid_input', 'La imagen debe ser JPG, PNG o WebP.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
  if (!blob) throw new AppError('internal_error', 'No se pudo procesar la imagen.');
  return blob;
}
