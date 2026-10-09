/** Tipos del cliente de PayPal. Todo lo que sale de acá ya está VALIDADO y normalizado (céntimos enteros, ids acotados). */

export type PayPalEnv = "sandbox" | "live";

export interface PayPalConfig {
  env: PayPalEnv;
  clientId: string;
  clientSecret: string;
  requestTimeoutMs?: number;
  /** Solo para pruebas. */
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
}

export interface PayPalShipping {
  name: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
}

export interface PayPalCapture {
  id: string;
  /** COMPLETED · PENDING · DECLINED · FAILED · REFUNDED · PARTIALLY_REFUNDED */
  status: string;
  amountCents: number;
  currency: string;
  customId: string | null;
}

export interface PayPalOrder {
  id: string;
  /** CREATED · SAVED · APPROVED · VOIDED · COMPLETED · PAYER_ACTION_REQUIRED */
  status: string;
  /** Nuestro id de pedido (se manda como custom_id al crear la orden). */
  customId: string | null;
  payerId: string | null;
  /** Total de la orden según PayPal (para compararlo con el de la base). */
  amountCents: number | null;
  currency: string | null;
  shipping: PayPalShipping | null;
  capture: PayPalCapture | null;
}

export interface PayPalSubscription {
  id: string;
  planId: string;
  /** APPROVAL_PENDING · APPROVED · ACTIVE · SUSPENDED · CANCELLED · EXPIRED */
  status: string;
  /** Nuestro id de usuario (se manda como custom_id al crear la suscripción). */
  customId: string | null;
  nextBillingTime: string | null;
  lastPaymentTime: string | null;
}

export interface PayPalRefund {
  id: string;
  status: string;
  amountCents: number;
  currency: string;
  /** Id de la captura que se reembolsa (del enlace "up"), si PayPal lo informa. */
  captureId: string | null;
}

export interface CreateOrderInput {
  /** Nuestro id de pedido: viaja como custom_id e invoice_id y se vuelve a comprobar al capturar. */
  orderId: string;
  totalCents: number;
  description: string;
  items: { name: string; unitCents: number; qty: number; digital: boolean }[];
  /** "address": PayPal pide la dirección de envío (productos físicos). "none": producto digital. */
  shipping: "address" | "none";
  brandName: string;
}

export interface CreateSubscriptionInput {
  planId: string;
  /** Id del usuario: viaja como custom_id. */
  userId: string;
  brandName: string;
  returnUrl?: string;
  cancelUrl?: string;
  requestId: string;
}

export interface WebhookVerifyInput {
  webhookId: string;
  headers: {
    authAlgo: string;
    certUrl: string;
    transmissionId: string;
    transmissionSig: string;
    transmissionTime: string;
  };
  /** El evento tal como llegó (ya parseado). */
  event: unknown;
}

/** Lo que el resto del backend necesita de PayPal. En producción lo implementa PayPalService; en los tests, un doble. */
export interface PayPalPort {
  createOrder(input: CreateOrderInput): Promise<{ id: string }>;
  getOrder(paypalOrderId: string): Promise<PayPalOrder>;
  /** Captura una orden APROBADA. Idempotente: si ya estaba capturada devuelve el estado actual. */
  captureOrder(paypalOrderId: string, requestId: string): Promise<PayPalOrder>;
  getRefund(refundId: string): Promise<PayPalRefund>;
  verifyWebhook(input: WebhookVerifyInput): Promise<boolean>;
  createSubscription(input: CreateSubscriptionInput): Promise<{ id: string }>;
  getSubscription(subscriptionId: string): Promise<PayPalSubscription>;
  cancelSubscription(subscriptionId: string, reason: string): Promise<void>;
}
