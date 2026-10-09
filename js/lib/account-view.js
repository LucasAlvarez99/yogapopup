/**
 * Mi cuenta (Fases 23-25): qué se le muestra a la persona sobre su progreso, sus compras y su suscripción.
 * Todo puro (sin DOM ni red) para poder probarlo: la interfaz solo dibuja lo que esto devuelve.
 */
import { formatClock, formatDate, formatPrice, percent } from './format.js';

// ------------------------------------------------------------------ Fase 23 · Mi progreso

/** Menos de esto no cuenta como "empezada" (mismo criterio que "Continuar viendo": un clic de más no es progreso). */
export const MIN_PROGRESS_SECONDS = 5;

const time = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Agrupa las filas de `video_progress` (con la clase embebida) en "en progreso" y "completadas", la más reciente primero.
 * Una clase borrada o despublicada llega con `classes: null` (la RLS no la deja ver) y se omite.
 * @returns {{ inProgress: object[], completed: object[] }}
 */
export function groupProgress(rows) {
  const clean = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.classes && r.classes.id)
    .map((r) => {
      const seconds = Math.max(0, Math.floor(Number(r.progress_seconds) || 0));
      const done = r.completed === true;
      return {
        classId: r.classes.id,
        title: r.classes.title || '',
        percent: done ? 100 : percent(seconds, r.classes.duration_seconds),
        seconds,
        completed: done,
        lastWatchedAt: r.last_watched_at || null,
        resumeLabel: done ? 'Volver a verla' : `Continuar desde ${formatClock(seconds)}`,
        locked: r.classes.access_level === 'restricted',
      };
    })
    .sort((a, b) => time(b.lastWatchedAt) - time(a.lastWatchedAt));
  return {
    inProgress: clean.filter((r) => !r.completed && r.seconds >= MIN_PROGRESS_SECONDS),
    completed: clean.filter((r) => r.completed),
  };
}

// ------------------------------------------------------------------ Fase 24 · Mis compras

/** Cómo se le cuenta a la persona el estado de un pedido (sin jerga: nada de "capture" ni "paypal_status"). */
export const ORDER_STATUS_FOR_USER = Object.freeze({
  created: {
    label: 'Sin completar',
    tone: 'secondary',
    note: 'No se llegó a pagar. No se te cobró nada.',
  },
  pending: {
    label: 'Esperando confirmación',
    tone: 'warning',
    note: 'PayPal todavía no confirmó el pago. No hace falta que pagues de nuevo.',
  },
  paid: { label: 'Pagado', tone: 'success', note: '' },
  failed: {
    label: 'No se pudo cobrar',
    tone: 'danger',
    note: 'El pago no se completó. No se te cobró nada.',
  },
  cancelled: {
    label: 'Cancelado',
    tone: 'secondary',
    note: 'El pedido se canceló. No se te cobró nada.',
  },
  refunded: { label: 'Reembolsado', tone: 'dark', note: '' },
});

const COMPLETE = new Set(['paid', 'pending', 'refunded']);

/** Separa lo que importa (pagado, a confirmar, reembolsado) de los intentos que no llegaron a nada. La más reciente primero. */
export function partitionOrders(orders) {
  const sorted = [...(Array.isArray(orders) ? orders : [])].filter(Boolean)
    .sort((a, b) => time(b.created_at) - time(a.created_at));
  return {
    main: sorted.filter((o) => COMPLETE.has(o.status)),
    incomplete: sorted.filter((o) => !COMPLETE.has(o.status)),
  };
}

/** "2 × Mat (talle M), 1 × Bloque" */
export function describeOrderItems(items = []) {
  return (items ?? []).map((i) => `${i.qty} × ${i.title}${i.size ? ` (talle ${i.size})` : ''}`).join(', ');
}

/**
 * Una fila del historial. `classId` solo aparece en una clase suelta YA pagada (para ofrecer "Ver clase"); un pedido
 * reembolsado ya no da acceso, así que no ofrece el enlace.
 */
export function describeOrder(order) {
  const status = ORDER_STATUS_FOR_USER[order.status] ??
    { label: String(order.status ?? ''), tone: 'secondary', note: '' };
  const items = order.order_items ?? [];
  const classItem = order.kind === 'class' ? items.find((i) => i.class_id) : null;
  const refunded = Number(order.refunded_cents) || 0;
  return {
    id: order.id,
    date: formatDate(order.paid_at || order.created_at),
    kind: order.kind === 'class' ? 'Clase' : 'Tienda',
    summary: describeOrderItems(items) ||
      (order.kind === 'class' ? 'Clase suelta' : 'Pedido'),
    total: formatPrice(order.total_cents),
    status,
    refundNote: refunded > 0 && order.status !== 'refunded' ? `Reembolsado parcialmente: ${formatPrice(refunded)}` : '',
    classId: order.status === 'paid' && classItem ? classItem.class_id : null,
  };
}

// ------------------------------------------------------------------ Fase 25 · Mi suscripción

/**
 * Estado de la suscripción para "Mi cuenta".
 *   state: 'none' | 'ended' | 'active' | 'suspended' | 'cancelled' (cancelada pero aún con acceso)
 * `current_period_end` es hasta cuándo está PAGADO: si está activa, también es la fecha del próximo cobro.
 * @param {object|null} sub  fila de `subscriptions` (la más reciente de la persona) o null
 * @param {{ now?: Date, planLabel?: string }} [opts]
 */
export function describeSubscription(
  sub,
  { now = new Date(), planLabel = '' } = {},
) {
  const until = sub?.current_period_end ? formatDate(sub.current_period_end) : '';
  const stillPaid = !!sub?.current_period_end &&
    new Date(sub.current_period_end) > now;
  const plan = planLabel ? `Plan: ${planLabel}` : null;
  const last = sub?.last_payment_at ? `Último pago: ${formatDate(sub.last_payment_at)}` : null;

  const noActive = (state) => ({
    state,
    headline: 'No tenés una suscripción activa.',
    details: [],
    canCancel: false,
    canSubscribe: true,
    tone: 'secondary',
  });
  if (!sub || sub.status === 'approval_pending') return noActive('none');
  if (sub.status === 'expired' || (sub.status === 'cancelled' && !stillPaid)) {
    return noActive('ended');
  }

  if (sub.status === 'cancelled') {
    return {
      state: 'cancelled',
      headline: 'Suscripción cancelada.',
      tone: 'secondary',
      canCancel: false,
      canSubscribe: true,
      details: [
        until ? `Seguís teniendo acceso hasta el ${until}.` : 'Seguís teniendo acceso hasta que termine el período pagado.',
        'Después de esa fecha no se te cobra ni se renueva.',
      ],
    };
  }
  if (sub.status === 'suspended') {
    return {
      state: 'suspended',
      headline: 'Suscripción con el pago pendiente.',
      tone: 'warning',
      canCancel: true,
      canSubscribe: false,
      details: [
        plan,
        until && stillPaid
          ? `PayPal no pudo cobrar la renovación. Tenés acceso hasta el ${until}; actualizá tu medio de pago en PayPal para no perderlo.`
          : 'PayPal no pudo cobrar la renovación. Actualizá tu medio de pago en PayPal.',
        last,
      ].filter(Boolean),
    };
  }
  return {
    state: 'active',
    headline: 'Suscripción activa.',
    tone: 'success',
    canCancel: true,
    canSubscribe: false,
    details: [plan, until ? `Próximo cobro: ${until}.` : null, last].filter(
      Boolean,
    ),
  };
}
