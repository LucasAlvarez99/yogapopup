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
  sizes_invalid: 'Revisa los talles: hay un valor no válido (nombre repetido, vacío o stock fuera de rango).',
  image_too_large: 'La imagen pesa demasiado, incluso reducida. Prueba con otra más pequeña.',
  image_forbidden: 'Tu cuenta no tiene permiso para subir imágenes. Avisa al equipo técnico.',
  storage_missing: 'Falta el almacenamiento de imágenes en Supabase (bucket). Avisa al equipo técnico.',
  rate_limited: 'Demasiados intentos seguidos. Esperá un minuto y probá de nuevo.',
  video_invalid: 'El archivo se subió pero no es un video válido (vacío o de otro formato). Elegí otro archivo y volvé a intentar.',
  upload_unconfirmed: 'No pudimos confirmar que el video llegó completo. Volvé a intentar la subida.',
  payload_too_large: 'Los datos enviados son demasiado grandes.',
  server_misconfigured: 'El servicio todavía no está configurado.',
  db_unavailable: 'El servicio no está disponible. Probá de nuevo en un momento.',
  network: 'No pudimos conectar. Revisá tu conexión e intentá de nuevo.',
  not_configured: 'Falta configurar la conexión con Supabase (js/config.js).',
  session_full: 'Esta clase ya no tiene lugares.',
  session_started: 'Esta clase ya empezó.',
  session_not_found: 'No encontramos esta clase en vivo (quizá ya no está disponible).',
  user_not_found: 'No encontramos a nadie con ese correo. La persona tiene que haberse registrado primero.',
  forbidden: 'No tenés permiso para hacer esto.',
  payments_unavailable: 'No pudimos abrir PayPal. Si usás un bloqueador de anuncios, desactivalo para este sitio y probá de nuevo.',
  payments_not_configured: 'Los pagos todavía no están disponibles. Probá más tarde.',
  payment_provider_error: 'PayPal no responde en este momento. No se te cobró nada: probá de nuevo en un minuto.',
  payment_declined: 'PayPal rechazó ese medio de pago. Probá con otro.',
  payment_failed: 'El pago no se completó. No se te cobró nada.',
  payment_review: 'Estamos verificando tu pago. Si se cobró, te lo vamos a reflejar en unos minutos; no pagues de nuevo.',
  order_not_found: 'No encontramos ese pedido.',
  order_cancelled: 'Ese pedido se canceló. Armá uno nuevo.',
  order_not_approved: 'No llegaste a aprobar el pago en PayPal. Probá de nuevo.',
  invalid_cart: 'Tu carrito cambió. Actualizalo y probá de nuevo.',
  size_required: 'Elegí un talle para ese producto.',
  product_unavailable: 'Alguno de los productos ya no está disponible. Actualizá tu carrito.',
  class_unavailable: 'Esta clase ya no se vende por separado.',
  insufficient_stock: 'No queda stock suficiente de alguno de los productos. Actualizá tu carrito.',
  already_owned: 'Ya tenés acceso a esta clase.',
  already_subscribed: 'Ya tenés una suscripción activa.',
  subscription_not_found: 'No encontramos esa suscripción.',
  subscription_invalid: 'Esa suscripción no corresponde al plan del sitio.',
  no_subscription: 'No tenés ninguna suscripción activa.',
  too_many_orders: 'Hiciste muchos intentos de compra seguidos. Esperá unos minutos.',
  internal_error: 'Ocurrió un error inesperado. Probá de nuevo.',
};

export function messageFor(err) {
  if (err instanceof AppError && MESSAGES[err.code]) return MESSAGES[err.code];
  if (err instanceof AppError && err.message && err.message !== err.code) return err.message;
  return MESSAGES.internal_error;
}

/**
 * Traduce el error de una función de la base (RPC) de la agenda a un AppError con mensaje claro.
 * Los códigos son los SQLSTATE que levantan las funciones de la migración 20261005120000.
 */
export function agendaError(error) {
  const code = String(error?.code ?? '');
  if (code === '23514') return new AppError('session_full');
  if (code === '22023') return new AppError('session_started');
  if (code === 'P0002') {
    return new AppError(/user not found/i.test(String(error?.message)) ? 'user_not_found' : 'session_not_found');
  }
  if (code === '42501' || code === 'PGRST301') return new AppError(code === 'PGRST301' ? 'unauthenticated' : 'forbidden');
  if (/failed to fetch|network/i.test(String(error?.message))) return new AppError('network');
  return new AppError('internal_error', error?.message);
}
