import { cfg } from './env.js';
import { AppError } from './errors.js';

/**
 * Carga del SDK de PayPal (botones). Dos instancias independientes con su propio `data-namespace`, porque PayPal
 * no deja mezclar en una misma carga el pago único (intent=capture) y la suscripción (vault + intent=subscription):
 *   checkout     -> window.paypal_checkout       (tienda y clases sueltas)
 *   subscription -> window.paypal_subscription   (suscripción mensual)
 * El script se pide solo cuando hace falta (al abrir el pago), nunca al cargar la página.
 */
export const NAMESPACES = Object.freeze({ checkout: 'paypal_checkout', subscription: 'paypal_subscription' });

/** URL del SDK (pura, para probarla). La moneda es siempre EUR, igual que el backend. */
export function sdkUrl(mode, clientId) {
  const q = new URLSearchParams({ 'client-id': clientId, currency: 'EUR', components: 'buttons', locale: 'es_ES' });
  if (mode === 'subscription') {
    q.set('vault', 'true');
    q.set('intent', 'subscription');
  } else {
    q.set('intent', 'capture');
  }
  return `https://www.paypal.com/sdk/js?${q}`;
}

const loading = {};

/** Devuelve el objeto del SDK (con `.Buttons`). Falla con `payments_unavailable` si no hay Client ID o si algo bloquea el script. */
export function loadPayPal(mode) {
  const ns = NAMESPACES[mode];
  if (!ns || !cfg.PAYPAL.CLIENT_ID) return Promise.reject(new AppError('payments_unavailable'));
  if (window[ns]?.Buttons) return Promise.resolve(window[ns]);
  loading[mode] ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = sdkUrl(mode, cfg.PAYPAL.CLIENT_ID);
    script.async = true;
    script.setAttribute('data-namespace', ns);
    script.onload = () => (window[ns]?.Buttons ? resolve(window[ns]) : reject(new AppError('payments_unavailable')));
    script.onerror = () => {
      delete loading[mode]; // un bloqueador de anuncios o un corte de red: se puede reintentar más tarde
      script.remove();
      reject(new AppError('payments_unavailable'));
    };
    document.head.append(script);
  });
  return loading[mode];
}

/**
 * Dibuja los botones de pago único dentro de `container`.
 *   createOrder()        -> Promise<string>  id de la orden de PayPal (lo crea NUESTRO servidor)
 *   onApprove(orderId)   la persona aprobó el pago en PayPal
 */
export async function renderCheckoutButtons(container, { createOrder, onApprove, onCancel, onError }) {
  const paypal = await loadPayPal('checkout');
  const buttons = paypal.Buttons({
    style: { layout: 'vertical', shape: 'pill', label: 'pay', height: 45 },
    createOrder,
    onApprove: (data) => onApprove(data.orderID),
    onCancel,
    onError,
  });
  if (buttons.isEligible && !buttons.isEligible()) throw new AppError('payments_unavailable');
  await buttons.render(container);
  return buttons;
}

/** Botones de suscripción. `createSubscription()` devuelve el id que crea NUESTRO servidor. */
export async function renderSubscriptionButtons(container, { createSubscription, onApprove, onCancel, onError }) {
  const paypal = await loadPayPal('subscription');
  const buttons = paypal.Buttons({
    style: { layout: 'vertical', shape: 'pill', label: 'subscribe', height: 45 },
    createSubscription,
    onApprove: (data) => onApprove(data.subscriptionID),
    onCancel,
    onError,
  });
  if (buttons.isEligible && !buttons.isEligible()) throw new AppError('payments_unavailable');
  await buttons.render(container);
  return buttons;
}
