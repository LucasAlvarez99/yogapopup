#!/usr/bin/env node
/**
 * Asistente de PayPal. Crea en PayPal lo que el sitio necesita y te dice qué valor copiar a supabase/.env.
 *
 *   npm run paypal:plan -- --price 9,99 [--name "Videoteca Yoga Pop Up"] [--interval MONTH|YEAR] [--tax 21]
 *       crea el producto y el PLAN de suscripción  ->  copia el id impreso a PAYPAL_PLAN_ID
 *   npm run paypal:webhook -- --url https://<proyecto>.supabase.co/functions/v1/paypal-webhook
 *       registra el webhook con los eventos que usa el sitio  ->  copia el id impreso a PAYPAL_WEBHOOK_ID
 *
 * Lee PAYPAL_ENV, PAYPAL_CLIENT_ID y PAYPAL_CLIENT_SECRET de supabase/.env (o del entorno). Con PAYPAL_ENV=live hay que
 * agregar --confirm-live: crea objetos reales en tu cuenta (no cobra nada, pero conviene hacerlo a propósito).
 * El secreto nunca se imprime.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, buildPlanBody, buildProductBody, buildWebhookBody, parseArgs, priceFromArgs, priceToCents } from './lib/paypal-setup.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
const env = { ...readEnvFile(join(root, 'supabase', '.env')), ...process.env };
const mode = env.PAYPAL_ENV;
if (mode !== 'sandbox' && mode !== 'live') die('Falta PAYPAL_ENV=sandbox (o live) en supabase/.env');
if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) die('Faltan PAYPAL_CLIENT_ID y PAYPAL_CLIENT_SECRET en supabase/.env');

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (mode === 'live' && !args['confirm-live']) die('PAYPAL_ENV=live: agrega --confirm-live para crear objetos en tu cuenta real.');

async function call(method, path, body, token) {
  const res = await fetch(`${API[mode]}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `yp-setup-${crypto.randomUUID()}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function token() {
  const res = await fetch(`${API[mode]}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) die(`PayPal rechazó las credenciales (${res.status}). Revisa que sean de la app ${mode} y que no tengan espacios.`);
  return (await res.json()).access_token;
}

if (command === 'plan') {
  const cents = priceToCents(priceFromArgs(args));
  if (!cents) die('Indica el precio con --price (ej.: --price 9,99). Es el precio FINAL con IVA incluido.');
  const interval = String(args.interval || 'MONTH').toUpperCase();
  const name = typeof args.name === 'string' ? args.name : 'Videoteca Yoga Pop Up';
  const tax = args.tax === undefined ? 21 : Number(args.tax);
  if (!Number.isFinite(tax) || tax < 0 || tax > 25) die('--tax debe ser un porcentaje entre 0 y 25');
  const t = await token();
  const product = await call('POST', '/v1/catalogs/products', buildProductBody(name), t);
  if (product.status !== 201 || !product.data.id) die(`No se pudo crear el producto (${product.status}): ${JSON.stringify(product.data).slice(0, 300)}`);
  const plan = await call('POST', '/v1/billing/plans', buildPlanBody({ productId: product.data.id, name, priceCents: cents, interval, taxPercent: tax }), t);
  if (plan.status !== 201 || !plan.data.id) die(`No se pudo crear el plan (${plan.status}): ${JSON.stringify(plan.data).slice(0, 400)}`);
  console.log(`\n✓ Plan creado en PayPal (${mode}): ${name} · ${(cents / 100).toFixed(2)} € por ${interval === 'YEAR' ? 'año' : 'mes'}, IVA ${tax} % incluido`);
  console.log('\nCopia esta línea a supabase/.env y luego ejecuta  npm run sb:secrets  :\n');
  console.log(`  PAYPAL_PLAN_ID=${plan.data.id}\n`);
} else if (command === 'webhook') {
  let body;
  try { body = buildWebhookBody(args.url); } catch (e) { die(`${e.message} (ej.: --url https://TU-PROYECTO.supabase.co/functions/v1/paypal-webhook)`); }
  const t = await token();
  let hook = await call('POST', '/v1/notifications/webhooks', body, t);
  if (hook.status === 400 && JSON.stringify(hook.data).includes('WEBHOOK_URL_ALREADY_EXISTS')) {
    const list = await call('GET', '/v1/notifications/webhooks', null, t);
    const found = (list.data.webhooks || []).find((w) => w.url === args.url);
    if (!found) die('PayPal dice que ese webhook ya existe, pero no lo encuentro en la lista. Revísalo en developer.paypal.com > tu app > Webhooks.');
    hook = { status: 200, data: found };
    console.log('\n! Ese webhook ya existía; se reutiliza (revisa sus eventos en el panel de PayPal si hace falta).');
  }
  if (![200, 201].includes(hook.status) || !hook.data.id) die(`No se pudo registrar el webhook (${hook.status}): ${JSON.stringify(hook.data).slice(0, 400)}`);
  console.log(`\n✓ Webhook registrado en PayPal (${mode}) → ${args.url}`);
  console.log('\nCopia esta línea a supabase/.env y luego ejecuta  npm run sb:secrets  :\n');
  console.log(`  PAYPAL_WEBHOOK_ID=${hook.data.id}\n`);
} else {
  die('Uso: npm run paypal:plan -- --price 9,99   |   npm run paypal:webhook -- --url https://.../functions/v1/paypal-webhook');
}
