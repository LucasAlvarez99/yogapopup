/** Error de la app con un código estable (el mismo que devuelven las Edge Functions). */
export class AppError extends Error {
  constructor(code, message, status = 0) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

const MESSAGES = {
  unauthenticated: 'Tu sesión venció. Iniciá sesión de nuevo.',
  developer_only: 'Esta acción es solo para el equipo técnico.',
  admin_only: 'Esta acción es solo para el equipo de gestión.',
  no_access: 'Esta clase no está incluida en tu acceso actual.',
  class_not_found: 'No encontramos esta clase.',
  product_not_found: 'No encontramos este producto (quizá ya se eliminó). Actualizá la lista.',
  video_not_ready: 'Estamos preparando este video. Probá de nuevo en unos minutos.',
  video_already_attached: 'Esta clase ya tiene un video en uso.',
  video_provider_error: 'El servicio de video no responde. Probá de nuevo en un momento.',
  invalid_input: 'Revisá los datos ingresados.',
  rate_limited: 'Demasiados intentos seguidos. Esperá un minuto y probá de nuevo.',
  video_invalid: 'El archivo se subió pero no es un video válido (vacío o de otro formato). Elegí otro archivo y volvé a intentar.',
  upload_unconfirmed: 'No pudimos confirmar que el video llegó completo. Volvé a intentar la subida.',
  payload_too_large: 'Los datos enviados son demasiado grandes.',
  server_misconfigured: 'El servicio todavía no está configurado.',
  db_unavailable: 'El servicio no está disponible. Probá de nuevo en un momento.',
  network: 'No pudimos conectar. Revisá tu conexión e intentá de nuevo.',
  not_configured: 'Falta configurar la conexión con Supabase (js/config.js).',
  internal_error: 'Ocurrió un error inesperado. Probá de nuevo.',
};

export function messageFor(err) {
  if (err instanceof AppError && MESSAGES[err.code]) return MESSAGES[err.code];
  if (err instanceof AppError && err.message && err.message !== err.code) return err.message;
  return MESSAGES.internal_error;
}
