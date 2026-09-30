import { supabase } from './supabase.js';
import { AppError } from './errors.js';
import { page } from './env.js';

/**
 * Estado de sesión compartido por todas las páginas.
 *   state.user     usuario de Supabase Auth (o null)
 *   state.profile  { display_name, role } de public.profiles (o null)
 * Los permisos reales SIEMPRE los decide el servidor (RLS + Edge Functions); esto solo ordena la interfaz.
 */
const state = { ready: false, session: null, user: null, profile: null };
const listeners = new Set();
let initPromise = null;

export const getState = () => state;
export const isLoggedIn = () => !!state.user;
/** Propietario o desarrollador (el desarrollador es superconjunto). Solo ordena la interfaz: el permiso real lo decide el servidor. */
export const isOwner = () => state.profile?.role === 'owner' || state.profile?.role === 'developer';
export const isDeveloper = () => state.profile?.role === 'developer';
export const accessToken = () => state.session?.access_token ?? null;

/** Suscribe un callback (state, event). Devuelve la función para cancelar. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (event) => listeners.forEach((fn) => { try { fn(state, event); } catch (e) { console.error(e); } });

async function loadProfile(userId) {
  const { data, error } = await supabase.from('profiles').select('display_name,role').eq('id', userId).maybeSingle();
  if (error) console.warn('No se pudo cargar el perfil:', error.message);
  return data ?? null;
}

async function applySession(session, event) {
  const previousUserId = state.user?.id ?? null;
  state.session = session ?? null;
  state.user = session?.user ?? null;
  state.profile = state.user ? await loadProfile(state.user.id) : null;
  state.ready = true;
  // supabase-js puede repetir SIGNED_IN al volver el foco a la pestaña: si el usuario no cambió,
  // no es un inicio de sesión nuevo y no debe reiniciar lo que la página esté haciendo (p. ej. el video).
  const sameUser = previousUserId === (state.user?.id ?? null);
  emit(event === 'SIGNED_IN' && sameUser ? 'SESSION_REFRESHED' : event);
}

/** Inicializa (una sola vez) y devuelve el estado. Seguro de llamar desde varios módulos. */
// El enlace del correo de recuperación trae "type=recovery" en el fragmento de la URL. supabase-js lo limpia al
// procesarlo, así que se lee ahora, al cargar el módulo.
const arrivedByRecoveryLink = typeof location !== 'undefined' && /[#&]type=recovery\b/.test(location.hash);

export function init() {
  if (!supabase) { state.ready = true; return Promise.resolve(state); }
  initPromise ??= (async () => {
    let sawRecovery = false;
    // La suscripción va ANTES de esperar la sesión: supabase-js emite PASSWORD_RECOVERY durante su inicialización
    // y, si nos suscribimos después, el evento se pierde y el enlace del correo no abriría el formulario.
    // No se llama a supabase dentro del callback (puede bloquear): se difiere con setTimeout.
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION') return;
      if (event === 'PASSWORD_RECOVERY') sawRecovery = true;
      setTimeout(() => applySession(session, event), 0);
    });
    const { data } = await supabase.auth.getSession();
    await applySession(data.session, 'INITIAL_SESSION');
    // Red de seguridad: llegó por un enlace de recuperación y la sesión existe, pero el evento no se vio.
    if (arrivedByRecoveryLink && !sawRecovery && state.user) emit('PASSWORD_RECOVERY');
    return state;
  })();
  return initPromise;
}

function need() {
  if (!supabase) throw new AppError('not_configured');
  return supabase;
}

export async function signIn(email, password) {
  const { error } = await need().auth.signInWithPassword({ email, password });
  if (error) throw error;
}

/** @returns {Promise<{needsConfirmation: boolean}>} */
export async function signUp(email, password, fullName) {
  const { data, error } = await need().auth.signUp({
    email, password, options: { data: { full_name: fullName || '' }, emailRedirectTo: page('index.html') },
  });
  if (error) throw error;
  return { needsConfirmation: !data.session };
}

export async function signOut() {
  const { error } = await need().auth.signOut();
  if (error) throw error;
}

export async function sendPasswordReset(email) {
  const { error } = await need().auth.resetPasswordForEmail(email, { redirectTo: page('index.html') });
  if (error) throw error;
}

export async function updatePassword(newPassword) {
  const { error } = await need().auth.updateUser({ password: newPassword });
  if (error) throw error;
}

/** Traduce los errores de Supabase Auth a mensajes claros. */
export function authMessage(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('invalid login')) return 'El correo o la contraseña no son correctos.';
  if (msg.includes('email not confirmed')) return 'Confirmá tu correo antes de entrar: te enviamos un enlace.';
  if (msg.includes('already registered') || msg.includes('already been registered')) return 'Ya existe una cuenta con ese correo. Probá iniciar sesión.';
  if (msg.includes('password') && msg.includes('characters')) return 'La contraseña es demasiado corta (mínimo 8 caracteres).';
  if (msg.includes('rate limit') || err?.status === 429) return 'Demasiados intentos. Esperá un momento e intentá de nuevo.';
  if (msg.includes('weak') || msg.includes('pwned')) return 'Elegí una contraseña más segura.';
  if (msg.includes('fetch') || msg.includes('network')) return 'No pudimos conectar. Revisá tu conexión.';
  return 'No pudimos completar la acción. Probá de nuevo.';
}
