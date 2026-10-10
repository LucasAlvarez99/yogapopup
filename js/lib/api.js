import { cfg, page } from './env.js';
import { supabase } from './supabase.js';
import { accessToken } from './session.js';
import { AppError, agendaError } from './errors.js';
import { fitImage, storageUploadError } from './image.js';
import { isSchemaBehind } from './catalog.js';
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
// Incluye el IVA incluido (tax_rate_bps) y los talles del producto (tabla product_variants, lectura pública).
export const PRODUCT_COLUMNS = 'id,title,description,image_url,price_cents,stock,category,sort_order,created_at,tax_rate_bps,product_variants(id,size,stock,sort_order)';

/** Productos activos (la base solo deja ver esos a quien no es admin ni developer). */
// Columnas de antes de los talles y el IVA: se usan solo si la base todavía no tiene esas migraciones (ver isSchemaBehind).
const LEGACY_PRODUCT_COLUMNS = 'id,title,description,image_url,price_cents,stock,category,sort_order,created_at';
const LEGACY_PRODUCT_ADMIN_COLUMNS = `${LEGACY_PRODUCT_COLUMNS},is_active,updated_at`;

/** Lee productos; si la base va atrasada (sin talles/IVA), repite la consulta con las columnas anteriores en vez de romper la tienda. */
async function selectProducts(columns, legacyColumns, build) {
  const first = await build(db().from('products').select(columns));
  if (!isSchemaBehind(first.error)) return first;
  console.warn('[catalog] La base no tiene aún los talles/IVA: se usan las columnas anteriores. Aplica las migraciones (npm run sb:db-push).');
  return build(db().from('products').select(legacyColumns));
}

export async function listActiveProducts() {
  return unwrap(await selectProducts(PRODUCT_COLUMNS, LEGACY_PRODUCT_COLUMNS, (q) => q.eq('is_active', true)
    .order('sort_order', { ascending: true }).order('created_at', { ascending: false }))) ?? [];
}

/** null si no existe o no está activo (para el público son lo mismo: no se revela que existe). */
export async function getProduct(id) {
  return unwrap(await selectProducts(PRODUCT_COLUMNS, LEGACY_PRODUCT_COLUMNS, (q) => q.eq('id', id).eq('is_active', true).maybeSingle()));
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

// ---------------------------------------------------------------- comentarios (Fases 26-27)
const TESTIMONIAL_PUBLIC = 'id,author_name,body,rating,created_at';
const TESTIMONIAL_OWN = 'id,body,rating,status,created_at,updated_at';
const TESTIMONIAL_ADMIN = 'id,author_name,body,rating,status,created_at,moderated_at';

/** Comentarios aprobados (público, también sin sesión). Una base sin la migración devuelve [] en vez de romper la home. */
export async function listPublicTestimonials(limit = 6) {
  const { data, error } = await db().from('testimonials').select(TESTIMONIAL_PUBLIC)
    .eq('status', 'approved').order('created_at', { ascending: false }).limit(limit);
  if (error) {
    if (isSchemaBehind(error)) return [];
    throw new AppError('internal_error', error.message);
  }
  return data ?? [];
}

/** El comentario propio (uno por persona) o null. `null` también si la base aún no tiene la tabla. */
export async function getMyTestimonial(userId) {
  const { data, error } = await db().from('testimonials').select(TESTIMONIAL_OWN).eq('user_id', userId).maybeSingle();
  if (error) {
    if (isSchemaBehind(error)) return null;
    throw new AppError('internal_error', error.message);
  }
  return data ?? null;
}

/** Escribe o corrige el comentario propio. Siempre queda pendiente: el estado lo pone la base, no el navegador. */
export async function saveMyTestimonial({ body, rating }, existingId = null) {
  const q = existingId
    ? db().from('testimonials').update({ body, rating }).eq('id', existingId)
    : db().from('testimonials').insert({ body, rating });
  const { data, error } = await q.select(TESTIMONIAL_OWN).single();
  if (error) {
    if (error.code === '23505') throw new AppError('already_commented');
    if (error.code === '23514') throw new AppError('invalid_testimonial');
    if (error.code === '42501' || error.code === 'PGRST301') throw new AppError('unauthenticated');
    throw new AppError('internal_error', error.message);
  }
  return data;
}

export async function deleteMyTestimonial(id) {
  const { error } = await db().from('testimonials').delete().eq('id', id);
  if (error) throw new AppError('internal_error', error.message);
}

/** Todos los comentarios (solo gestión: la RLS lo exige). */
export async function adminListTestimonials(limit = 200) {
  return unwrap(await db().from('testimonials').select(TESTIMONIAL_ADMIN).order('created_at', { ascending: false }).limit(limit)) ?? [];
}

/** Aprobar u ocultar. Devuelve la fila actualizada; si la RLS no deja ver la fila, falla (no es gestión). */
export async function adminSetTestimonialStatus(id, status) {
  const { data, error } = await db().from('testimonials').update({ status }).eq('id', id).select(TESTIMONIAL_ADMIN);
  if (error) throw new AppError(error.code === '42501' ? 'forbidden' : 'internal_error', error.message);
  if (!data?.length) throw new AppError('forbidden');
  return data[0];
}

export async function adminDeleteTestimonial(id) {
  const { data, error } = await db().from('testimonials').delete().eq('id', id).select('id');
  if (error) throw new AppError(error.code === '42501' ? 'forbidden' : 'internal_error', error.message);
  if (!data?.length) throw new AppError('forbidden');
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

/** "Mi progreso" (Fase 23): todo lo que la persona empezó o terminó, la más reciente primero. La RLS limita a las propias filas. */
export async function listMyProgress() {
  const rows = unwrap(await db().from('video_progress')
    .select(`progress_seconds,completed,last_watched_at,classes(${CARD_COLUMNS})`)
    .order('last_watched_at', { ascending: false })) ?? [];
  return rows.filter((r) => r.classes);
}

/** "Mis compras" (Fase 24): pedidos propios (tienda y clases sueltas) con sus renglones. */
export async function listMyOrders(limit = 50) {
  const { data, error } = await db().from('orders')
    .select('id,kind,status,total_cents,tax_cents,refunded_cents,created_at,paid_at,order_items(title,size,qty,item_type,class_id)')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) {
    if (isSchemaBehind(error)) return [];
    throw new AppError('internal_error', error.message);
  }
  return data ?? [];
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

// ---------------------------------------------------------------- pagos con PayPal (Fases 17-22)
// El navegador NUNCA decide un cobro: manda qué quiere comprar y el servidor (que lee precio y stock de la base y
// verifica cada pago contra la API de PayPal) responde. Acá solo se arman las llamadas.

/** Crea el pedido y la orden de PayPal. `items`: ver js/lib/checkout.js (cartToItems / classToItems). */
export const paypalCreateOrder = (items) => callFunction('paypal-create-order', { items });
/** Cobra una orden ya aprobada en PayPal y la verifica en el servidor. */
export const paypalCaptureOrder = (paypalOrderId) => callFunction('paypal-capture-order', { paypal_order_id: paypalOrderId });
export const paypalCreateSubscription = () => callFunction('paypal-create-subscription', { return_url: page('cuenta.html') });
export const paypalActivateSubscription = (subscriptionId) => callFunction('paypal-activate-subscription', { subscription_id: subscriptionId });
export const paypalCancelSubscription = () => callFunction('paypal-cancel-subscription', {});
/** Conciliación (personal de gestión): { order_id } · { subscription_id } · { sweep: true }. */
export const paypalReconcile = (body) => callFunction('paypal-reconcile', body, { timeoutMs: 60_000 });

/** Precio de una clase suelta ({ price_cents, tax_rate_bps }) o null si no se vende suelta (o la base aún no tiene precios). */
export async function getClassOffer(classId) {
  const { data, error } = await db().from('classes').select('price_cents,tax_rate_bps').eq('id', classId).maybeSingle();
  if (error) {
    if (isSchemaBehind(error)) return null;
    throw new AppError('internal_error', error.message);
  }
  return Number.isSafeInteger(data?.price_cents) && data.price_cents > 0 ? { price_cents: data.price_cents, tax_rate_bps: data.tax_rate_bps ?? 0 } : null;
}

/** La suscripción más reciente de la persona (activa, suspendida o cancelada), o null. La RLS limita la lectura a la propia. */
export async function getMySubscription() {
  const { data, error } = await db().from('subscriptions')
    .select('paypal_subscription_id,status,current_period_end,last_payment_at,cancelled_at,created_at')
    .in('status', ['active', 'suspended', 'cancelled']).order('created_at', { ascending: false }).limit(1);
  if (error) {
    if (isSchemaBehind(error)) return null;
    throw new AppError('internal_error', error.message);
  }
  return data?.[0] ?? null;
}

const ORDER_ADMIN_COLUMNS = 'id,user_id,kind,status,total_cents,tax_cents,refunded_cents,needs_review,review_note,failure_reason,' +
  'paypal_order_id,paypal_status,shipping,created_at,paid_at,profiles(display_name),order_items(title,size,qty,unit_cents)';
const SUBSCRIPTION_ADMIN_COLUMNS = 'id,user_id,paypal_subscription_id,status,current_period_end,last_payment_at,cancelled_at,created_at,profiles(display_name)';

/** Pedidos (solo personal de gestión: la RLS lo exige). Los que piden revisión van primero. */
export async function adminListOrders(limit = 100) {
  const rows = unwrap(await db().from('orders').select(ORDER_ADMIN_COLUMNS).order('created_at', { ascending: false }).limit(limit)) ?? [];
  return rows.sort((a, b) => Number(b.needs_review) - Number(a.needs_review));
}
export async function adminListSubscriptions(limit = 100) {
  return unwrap(await db().from('subscriptions').select(SUBSCRIPTION_ADMIN_COLUMNS).order('created_at', { ascending: false }).limit(limit)) ?? [];
}
/** Precio de venta suelta de cada clase ({ id: price_cents|null }); vacío si la base aún no tiene precios. */
export async function adminClassPrices() {
  const { data, error } = await db().from('classes').select('id,price_cents');
  if (error) {
    if (isSchemaBehind(error)) return {};
    throw new AppError('internal_error', error.message);
  }
  return Object.fromEntries((data ?? []).map((r) => [r.id, r.price_cents]));
}
/** Fija (o quita con null) el precio de venta suelta de una clase. El cambio queda auditado en la base. */
export async function adminSetClassPrice(id, priceCents) {
  const { error } = await db().from('classes').update({ price_cents: priceCents }).eq('id', id);
  if (error) throw new AppError(error.code === '23514' ? 'invalid_input' : 'internal_error', error.message);
}

// ---------------------------------------------------------------- miniaturas (Supabase Storage)
export const THUMB_BUCKET = 'class-thumbnails';

/** Sube la miniatura (ya reducida) y devuelve su URL pública. */
export async function uploadThumbnail(classId, blob) {
  const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${classId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await db().storage.from(THUMB_BUCKET).upload(path, blob, { contentType: blob.type, cacheControl: '31536000' });
  if (error) { console.warn('[storage] class-thumbnails upload:', error); throw storageUploadError(error, 'No se pudo subir la miniatura.'); }
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
const PRODUCT_EDITABLE = ['title', 'description', 'image_url', 'price_cents', 'stock', 'category', 'sort_order', 'is_active', 'tax_rate_bps'];

const pickProductFields = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => PRODUCT_EDITABLE.includes(k)));

function productError(error) {
  if (error.code === '42501') return new AppError('admin_only');
  if (error.code === '23514') return new AppError('invalid_input', 'Revisá los datos: hay un valor fuera de rango (precio, stock o largo de un texto).');
  if (error.code === 'PGRST116') return new AppError('product_not_found');
  if (error.code === '22023') return new AppError('sizes_invalid', error.message);
  return new AppError('internal_error', error.message);
}

/** Todos los productos, activos e inactivos (la base solo deja ver los inactivos a admin y developer). */
export async function adminListProducts() {
  return unwrap(await selectProducts(PRODUCT_ADMIN_COLUMNS, LEGACY_PRODUCT_ADMIN_COLUMNS, (q) => q.order('created_at', { ascending: false }))) ?? [];
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

/**
 * Guarda los talles de un producto (reemplaza el conjunto, de forma atómica; los que siguen conservan su id).
 * `rows`: [{ size, stock }] ya validadas con validateSizeRows(). Lista vacía = el producto queda sin talles.
 */
export async function adminSaveProductVariants(productId, rows) {
  const { data, error } = await db().rpc('save_product_variants', { p_product_id: productId, p_variants: rows });
  if (error) throw productError(error);
  return data ?? [];
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
  if (error) { console.warn('[storage] product-images upload:', error); throw storageUploadError(error, 'No se pudo subir la imagen.'); }
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
export async function resizeImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new AppError('invalid_input', 'La imagen debe ser JPG, PNG o WebP.');
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new AppError('invalid_input', 'No se pudo leer la imagen. Prueba con otro archivo.'); }
  try {
    const canvas = document.createElement('canvas');
    const encode = (width, type, quality) => {
      const scale = Math.min(1, width / bitmap.width);
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    };
    return await fitImage(encode); // WebP si el navegador sabe; JPEG si no (Safari); y siempre bajo el tope del bucket
  } finally {
    bitmap.close?.();
  }
}

// ---------------------------------------------------------------- profesores y agenda de clases en vivo (Fases 28-30)
// Lo público (perfil de profesores activos y agenda con cupos) se lee sin sesión. Reservar y la agenda del profesor
// van por funciones de la base (RPC) que validan cupo, horario y permisos: acá solo se arman las llamadas.
export const TEACHER_COLUMNS = 'profile_id,public_name,bio,photo_url,specialties,is_active,created_at';

async function rpc(name, args = {}) {
  const { data, error } = await db().rpc(name, args);
  if (error) throw agendaError(error);
  return data;
}

/** Profesores activos (lo que ve cualquier visitante). */
export async function listTeachers() {
  return unwrap(await db().from('teachers').select(TEACHER_COLUMNS).eq('is_active', true).order('created_at', { ascending: true })) ?? [];
}
/** Todos, también los dados de baja (la base solo deja verlos a la gestión). */
export async function adminListTeachers() {
  return unwrap(await db().from('teachers').select(TEACHER_COLUMNS).order('created_at', { ascending: true })) ?? [];
}
/** Clases en vivo publicadas entre `from` y `to` (ISO), con cupos ocupados y si yo ya estoy anotado/a. */
export const liveAgenda = ({ teacher = null, from, to }) => rpc('live_agenda', { p_teacher: teacher, p_from: from, p_to: to }).then((r) => r ?? []);
export const bookLiveSession = (sessionId) => rpc('book_live_session', { p_session: sessionId });
export const cancelLiveBooking = (sessionId) => rpc('cancel_live_booking', { p_session: sessionId });
export const myLiveBookings = () => rpc('my_live_bookings').then((r) => r ?? []);
/** Clases de un profesor con los alumnos anotados (solo nombres). El propio profesor o la gestión. */
export const teacherAgenda = (teacherId, from, to) => rpc('teacher_agenda', { p_teacher: teacherId, p_from: from, p_to: to }).then((r) => r ?? []);

export async function createLiveSession(teacherId, input) {
  return unwrap(await db().from('live_sessions').insert({ teacher_id: teacherId, ...input }).select('id').single());
}
export async function updateLiveSession(id, input) {
  return unwrap(await db().from('live_sessions').update(input).eq('id', id).select('id').single());
}
export async function deleteLiveSession(id) {
  unwrap(await db().from('live_sessions').delete().eq('id', id));
}

export async function updateTeacherProfile(profileId, patch) {
  return unwrap(await db().from('teachers').update(patch).eq('profile_id', profileId).select(TEACHER_COLUMNS).single());
}

// Alta y baja de profesores: solo developer (la base lo exige y lo audita).
/** Alta como profesor/a SIN bajar a nadie de rango. `alsoAdmin`: además le da gestión (como Manu). Devuelve el rol resultante. */
export const addTeacherByEmail = (email, alsoAdmin = false) => rpc('add_teacher_by_email', { p_email: email, p_also_admin: alsoAdmin });
export const setTeacherActive = (profileId, active) => rpc('set_teacher_active', { p_target: profileId, p_active: active });

// ---------------------------------------------------------------- fotos de perfil de profesores (Supabase Storage)
export const TEACHER_PHOTO_BUCKET = 'teacher-photos';

/** Sube la foto (ya reducida) a la carpeta del profesor y devuelve su URL pública. */
export async function uploadTeacherPhoto(profileId, blob) {
  const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${profileId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await db().storage.from(TEACHER_PHOTO_BUCKET).upload(path, blob, { contentType: blob.type, cacheControl: '31536000' });
  if (error) { console.warn('[storage] teacher-photos upload:', error); throw storageUploadError(error, 'No se pudo subir la foto.'); }
  return db().storage.from(TEACHER_PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Borra la foto SOLO si la URL es de nuestro bucket. Se llama DESPUÉS de guardar la nueva (ver claude.md, trampas). */
export async function deleteTeacherPhotoByUrl(url) {
  const path = storagePathFromPublicUrl(url, TEACHER_PHOTO_BUCKET);
  if (!path) return;
  await db().storage.from(TEACHER_PHOTO_BUCKET).remove([path]);
}
