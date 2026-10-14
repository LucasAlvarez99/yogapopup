import { createEndpoint, HttpError, readJson } from "../_shared/http.ts";
import { enforceRateLimit, LIMITS } from "../_shared/rate-limit.ts";
import { parseCartItems, requirePayPal } from "../_shared/payments/request.ts";
import type { PaymentDeps } from "../_shared/payments/ports.ts";

/** Texto del pedido en PayPal: un video, varios videos o la tienda (con o sin videos). */
function describeOrder(kind: string, lines: { item_type: string; title: string }[]): string {
  const videos = lines.filter((l) => l.item_type === "class");
  if (kind === "class") return videos.length === 1 ? `Curso: ${videos[0].title}` : `Cursos en video (${videos.length})`;
  return videos.length > 0 ? "Pedido de la tienda con cursos en video" : "Pedido de la tienda";
}

/**
 * Fase 18 · Crea el pedido y la orden de PayPal para el checkout (tienda, videos o las dos cosas).
 * El navegador manda SOLO qué quiere comprar; el precio, el IVA y el stock salen de la base y quedan reservados
 * antes de hablar con PayPal. Si PayPal falla, el pedido se cierra y el stock se libera.
 */
export function createHandler(deps: PaymentDeps): (req: Request) => Promise<Response> {
  return createEndpoint({
    methods: ["POST"],
    allowedOrigins: deps.config.allowedOrigins,
    run: async (req) => {
      const user = await deps.auth.requireUser(req);
      const paypal = requirePayPal(deps);
      await enforceRateLimit(deps.limiter, "paypal-create-order", user.id, LIMITS.createPayPalOrder);
      const items = parseCartItems(await readJson(req));

      const orderId = await deps.repo.createOrder(user.id, items);
      const order = await deps.repo.getOrder(orderId);
      const lines = await deps.repo.listOrderItems(orderId);
      if (!order || lines.length === 0) throw new HttpError(500, "internal_error", "Order could not be read back");

      let paypalOrderId: string;
      try {
        const created = await paypal.createOrder({
          orderId,
          totalCents: order.total_cents,
          description: describeOrder(order.kind, lines),
          items: lines.map((l) => ({
            name: l.size ? `${l.title} (talle ${l.size})` : l.title,
            unitCents: l.unit_cents,
            qty: l.qty,
            digital: l.item_type === "class",
          })),
          shipping: order.kind === "shop" ? "address" : "none",
          brandName: deps.config.brandName,
        });
        paypalOrderId = created.id;
        await deps.repo.setPayPalOrderId(orderId, paypalOrderId);
      } catch (e) {
        await deps.repo.releaseOrder(orderId, "failed", "paypal_create_failed").catch((err) =>
          console.error(
            "[payments] could not release order after PayPal failure:",
            err instanceof Error ? err.message : err,
          )
        );
        throw e;
      }
      return { paypal_order_id: paypalOrderId, order_id: orderId, total_cents: order.total_cents, kind: order.kind };
    },
  });
}
