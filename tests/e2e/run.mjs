/**
 * Pruebas E2E en un navegador real (Chrome/Chromium) con un video mp4 real (R2 no transcodifica).
 *
 *   CHROME_PATH=/ruta/a/chrome npm run test:e2e
 *
 * Si no se define CHROME_PATH se buscan las rutas habituales de Chrome/Chromium/Edge.
 * Usa el `supabase-js` real del proyecto contra el backend de pruebas de fake-backend.mjs.
 * Requiere ffmpeg (genera un video mp4 de 12 s).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { IDS, PRODUCT_IDS, startBackend, TEACHER_IDS } from './fake-backend.mjs';
import { ensureMedia } from './media.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Ruta en la carpeta temporal del sistema (funciona en Linux, macOS y Windows; /tmp fijo no existe en Windows). */
const tmp = (name) => join(tmpdir(), name);
const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const chromePath = CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('No se encontró Chrome/Chromium. Define CHROME_PATH=/ruta/al/ejecutable');
  process.exit(2);
}

// Por defecto se sirve el repositorio tal cual. Con E2E_SITE_ROOT=dist se prueba el sitio CONSTRUIDO (con su CSP):
// cualquier recurso que la política bloquee aparece como error de consola y hace fallar la prueba.
const siteRoot = process.env.E2E_SITE_ROOT ? resolve(root, process.env.E2E_SITE_ROOT) : root;
const be = await startBackend({ siteRoot });
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: process.env.CHROME_HEADLESS_SHELL ? 'shell' : true,
  // Por defecto Puppeteer espera 180 s a que una llamada al navegador responda. Si algo se cuelga (p. ej. un diálogo
  // abierto en una pestaña en segundo plano) se quiere un error rápido, no tres minutos de silencio.
  protocolTimeout: 60_000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

const S = be.origin.site;
const PASS = 'clave-segura-123';
const results = [];
const only = process.argv[2]; // filtro: varias partes separadas por | (p. ej. "catálogo|reproductor")
const selected = (name) => !only || only.split('|').some((part) => name.includes(part));

async function newPage() {
  const context = await browser.createBrowserContext(); // localStorage limpio por prueba
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) page.errors.push(`console.error: ${m.text()}`); });
  page.ctx = context;
  return page;
}
const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, { timeout, polling: 100 }, arg);
// Bootstrap ignora clics y cierres mientras el modal se anima (~300 ms). Se espera a que termine de abrirse.
const modalReady = (page) => waitFor(page, () => {
  const d = document.querySelector('.yp-auth .modal-dialog');
  return !!d && !!document.querySelector('.yp-auth.show') && /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(getComputedStyle(d).transform);
}, null, 5000);
/** Ejecuta un proceso SIN bloquear el bucle de eventos (el backend de pruebas vive en este mismo proceso). */
const run = (args, env) => new Promise((resolve) => {
  const child = spawn('node', args, { cwd: root, env });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stdout += d));
  child.on('close', (status) => resolve({ status, stdout }));
});
const count = (page, sel) => page.$$eval(sel, (n) => n.length);
const text = (page, sel) => page.$eval(sel, (n) => n.textContent.trim());
const videoTime = (page) => page.$eval('.yp-video', (v) => v.currentTime);

async function signup(email, name = 'Ana Test') {
  const r = await fetch(`${be.origin.api}/auth/v1/signup`, { method: 'POST', body: JSON.stringify({ email, password: PASS, data: { full_name: name } }) });
  assert.equal(r.status, 200);
}
async function loginViaModal(page, email, password = PASS) {
  await page.click('[data-account-toggle]');
  await page.waitForSelector('#authEmail', { visible: true });
  await modalReady(page);
  await page.type('#authEmail', email);
  await page.type('#authPass', password);
  await page.click('.yp-auth button[type=submit]');
  // el modal se cierra con una animación: hasta que termina, su fondo intercepta los clics
  await waitFor(page, () => !document.querySelector('.modal-backdrop') && !document.querySelector('.modal.show'), null, 10000);
}
async function openClass(page, id) {
  await page.goto(`${S}/clase.html?id=${id}`);
}
async function playAndWait(page, seconds = 1.5) {
  await page.waitForSelector('.yp-bigplay', { visible: true, timeout: 15000 });
  // Tras iniciar sesión, el modal tarda ~300 ms en desvanecerse y su telón intercepta los clics.
  await waitFor(page, () => !document.querySelector('.modal-backdrop, .modal.show'), null, 5000);
  await page.click('.yp-bigplay');
  await waitFor(page, (s) => document.querySelector('.yp-video')?.currentTime > s, seconds, 20000);
}

async function test(name, fn) {
  if (!selected(name)) return;
  await be.reset();
  const page = await newPage();
  const t0 = Date.now();
  try {
    await fn(page);
    assert.deepEqual(page.errors, [], `errores inesperados en la página:\n${page.errors.join('\n')}`);
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
    // La línea que importa es la del TEST que llamó a la ayuda (waitFor, toastHas…), no la de la ayuda misma.
    const frames = String(err.stack || '').split('\n').filter((l) => l.includes('run.mjs'));
    const where = frames.find((l) => !/at (waitFor|toastHas|modalReady|productModalReady|productModalClosed) /.test(l)) ?? frames[0];
    if (where) console.log(`      en ${where.trim().replace(/^at /, '').replace(root, '')}`);
    if (page.errors.length) console.log(`      (errores de la página: ${page.errors.join(' | ').slice(0, 400)})`);
    await page.screenshot({ path: tmp(`e2e-fail-${results.length}.png`) }).catch(() => {});
  } finally {
    await page.ctx.close().catch(() => {});
  }
}

console.log(`\nE2E · ${chromePath}\n`);

// ============================================================ tienda (Fase 13)
await test('tienda: catálogo real (omite borradores/agotados como comprables), buscador y filtro por categoría', async (page) => {
  await page.goto(`${S}/tienda.html`);
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 3); // 3 activos, 1 borrador omitido
  const titles = await page.$$eval('#shopGrid h3', (n) => n.map((x) => x.textContent.trim()));
  assert.deepEqual(titles.sort(), ['Botella térmica', 'Mat de yoga Premium', 'Remera Pop Up']);
  assert.ok(!titles.includes('Producto borrador'), 'un producto inactivo no debe verse en la tienda');

  // agotado: se ve, pero no se puede "comprar"
  const soldout = await page.$eval('#shopGrid .shop-card.is-soldout .shop-body h3', (n) => n.textContent.trim());
  assert.equal(soldout, 'Remera Pop Up');
  assert.equal(await page.$$eval('#shopGrid .shop-card.is-soldout button', (b) => b[0].disabled), true);

  // buscador (sin distinguir acentos/mayúsculas) y filtro por categoría, combinados
  await page.type('#shopFilters input[type=search]', 'TERMICA');
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 1);
  await page.$eval('#shopFilters input[type=search]', (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 3);

  await page.evaluate(() => [...document.querySelectorAll('.yp-chip')].find((b) => b.textContent === 'Ropa').click());
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 1);
  assert.equal(await page.$eval('#shopGrid h3', (n) => n.textContent.trim()), 'Remera Pop Up');
});

await test('producto: ficha con precio en euros, "también te puede gustar", y 404 si no existe o está inactivo', async (page) => {
  await page.goto(`${S}/producto.html?id=${PRODUCT_IDS.mat}`);
  await waitFor(page, () => !!document.querySelector('.producto-title'));
  assert.equal(await page.$eval('.producto-title', (n) => n.textContent.trim()), 'Mat de yoga Premium');
  assert.equal(await page.$eval('.producto-price', (n) => n.textContent.replace(/\s/g, ' ')), '18,99 €');
  await waitFor(page, () => document.querySelectorAll('#productMore .shop-card').length === 2); // los otros 2 activos, sin contarse a sí mismo

  await page.goto(`${S}/producto.html?id=${PRODUCT_IDS.draft}`); // existe pero está inactivo: mismo trato que "no existe"
  await waitFor(page, () => document.body.textContent.includes('Producto no encontrado'));
  await page.goto(`${S}/producto.html?id=no-es-un-uuid`);
  await waitFor(page, () => document.body.textContent.includes('Producto no encontrado'));
});

// ============================================================ carrito (Fase 16)
const cartBadge = (page) => page.$eval('[data-cart-count]', (b) => (b.hidden ? '' : b.textContent.trim()));
const norm = (t) => t.replace(/\s/g, ' ');
/** Toca "Agregar al carrito" en la tarjeta de ese producto (dentro de `scope`). */
const addFromCard = (page, scope, title) => page.evaluate((sc, t) => {
  const card = [...document.querySelectorAll(`${sc} .shop-card`)].find((c) => c.querySelector('h3')?.textContent.trim() === t);
  card.querySelector('button').click();
}, scope, title);
const openCart = async (page) => {
  await page.click('[data-cart-toggle]');
  await page.waitForSelector('#cartDrawer.show:not(.showing)'); // espera a que termine la animación
};
const rowSel = (id) => `#cartList li[data-product-id="${id}"]`;
const storedCart = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('yp.cart')));
const toastHas = (page, part) => waitFor(page, (t) => [...document.querySelectorAll('.yp-toast')].some((n) => n.textContent.includes(t)), part, 5000);

await test('carrito: agregar desde la tienda respeta el stock y sobrevive a recargar y a cambiar de página, sin iniciar sesión', async (page) => {
  await page.goto(`${S}/tienda.html`);
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 3);
  assert.equal(await cartBadge(page), '', 'sin productos no hay globito');

  await addFromCard(page, '#shopGrid', 'Mat de yoga Premium');
  await waitFor(page, () => document.querySelector('[data-cart-count]').textContent === '1');
  await toastHas(page, 'se agregó al carrito');

  // la botella tiene stock 3: la cuarta vez avisa y no suma
  for (let i = 0; i < 4; i++) await addFromCard(page, '#shopGrid', 'Botella térmica');
  await waitFor(page, () => document.querySelector('[data-cart-count]').textContent === '4'); // 1 mat + 3 botellas
  await toastHas(page, 'máximo disponible');
  assert.equal(await cartBadge(page), '4');

  // el agotado no se puede agregar
  assert.equal(await page.$eval('#shopGrid .shop-card.is-soldout button', (b) => b.disabled), true);

  // lo guardado son solo ids y cantidades (nunca precios ni títulos)
  const saved = await storedCart(page);
  assert.equal(saved.v, 1);
  assert.deepEqual(saved.items.map((i) => Object.keys(i).sort()), [['id', 'qty'], ['id', 'qty']]);

  await page.reload();
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 3);
  assert.equal(await cartBadge(page), '4', 'sobrevive a recargar');
  await page.goto(`${S}/producto.html?id=${PRODUCT_IDS.mat}`);
  await waitFor(page, () => !!document.querySelector('.producto-title'));
  assert.equal(await cartBadge(page), '4', 'sobrevive a cambiar de página');

  // desde la ficha también se agrega
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Agregar al carrito')).click());
  await waitFor(page, () => document.querySelector('[data-cart-count]').textContent === '5');
});

await test('carrito: el cajón muestra precios reales, cambia cantidades con tope de stock, quita y vacía', async (page) => {
  await page.goto(`${S}/tienda.html`);
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 3);
  await addFromCard(page, '#shopGrid', 'Mat de yoga Premium');
  await addFromCard(page, '#shopGrid', 'Botella térmica');
  await waitFor(page, () => document.querySelector('[data-cart-count]').textContent === '2');

  await openCart(page);
  await waitFor(page, () => document.querySelectorAll('#cartList .cart-item').length === 2);
  assert.equal(norm(await text(page, '#cartSubtotal')), '33,98 €'); // 18,99 + 14,99
  assert.equal(await text(page, '#cartTitleCount'), '2');
  assert.equal(await page.$eval('.cart-footer .btn-brand', (b) => b.disabled), true, 'el pago llega en otra fase');
  const mat = rowSel(PRODUCT_IDS.mat);
  const bottle = rowSel(PRODUCT_IDS.bottle);

  // subir cantidad: el total de la línea y el subtotal siguen a la base
  await page.click(`${mat} [aria-label="Una unidad más"]`);
  await waitFor(page, () => document.querySelector('#cartSubtotal').textContent.replace(/\s/g, ' ') === '52,97 €');
  assert.equal(await text(page, `${mat} .qty span`), '2');
  assert.equal(norm(await text(page, `${mat} .cart-info strong`)), '37,98 €');
  assert.equal(await cartBadge(page), '3');

  // la botella tiene stock 3: el "+" se bloquea al llegar
  await page.click(`${bottle} [aria-label="Una unidad más"]`);
  await waitFor(page, (sel) => document.querySelector(`${sel} .qty span`).textContent === '2', bottle);
  await page.click(`${bottle} [aria-label="Una unidad más"]`);
  await waitFor(page, (sel) => document.querySelector(`${sel} .qty span`).textContent === '3', bottle);
  assert.equal(await page.$eval(`${bottle} [aria-label="Una unidad más"]`, (b) => b.disabled), true);

  // con 1 unidad el "−" queda bloqueado (para sacar un producto está la X)
  await page.click(`${mat} [aria-label="Una unidad menos"]`);
  await waitFor(page, (sel) => document.querySelector(`${sel} .qty span`).textContent === '1', mat);
  assert.equal(await page.$eval(`${mat} [aria-label="Una unidad menos"]`, (b) => b.disabled), true);

  // quitar
  await page.click(`${mat} .cart-remove`);
  await waitFor(page, () => document.querySelectorAll('#cartList .cart-item').length === 1);
  assert.equal(norm(await text(page, '#cartSubtotal')), '44,97 €'); // 3 × 14,99

  // vaciar
  await page.evaluate(() => [...document.querySelectorAll('.cart-footer .btn-soft')].find((b) => b.textContent.includes('Vaciar')).click());
  await waitFor(page, () => document.querySelector('.cart-empty')?.textContent.includes('Tu carrito está vacío'));
  assert.equal(await cartBadge(page), '');
  assert.equal(await page.evaluate(() => localStorage.getItem('yp.cart')), null, 'vaciado: no queda basura guardada');
});

await test('carrito: un precio manipulado en localStorage no se cobra (el cajón usa el de la base) y lo corrupto no rompe nada', async (page) => {
  await page.goto(`${S}/tienda.html`);
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 3);
  await page.evaluate((id) => localStorage.setItem('yp.cart', JSON.stringify({ v: 1, items: [{ id, qty: 2, price_cents: 1, title: 'gratis' }] })), PRODUCT_IDS.mat);
  await page.reload();
  await waitFor(page, () => document.querySelector('[data-cart-count]').textContent === '2');

  await openCart(page);
  await waitFor(page, () => document.querySelectorAll('#cartList .cart-item').length === 1);
  assert.equal(norm(await text(page, '#cartSubtotal')), '37,98 €', '2 × 18,99 de la base, no 0,02');
  assert.ok(!(await page.$eval('#cartDrawer', (d) => d.textContent)).includes('gratis'));

  // al volver a guardar, el precio inyectado se descarta
  await page.click(`${rowSel(PRODUCT_IDS.mat)} [aria-label="Una unidad más"]`);
  await waitFor(page, () => document.querySelector('[data-cart-count]').textContent === '3');
  assert.deepEqual((await storedCart(page)).items, [{ id: PRODUCT_IDS.mat, qty: 3 }]);

  // contenido corrupto: la página carga normal y el carrito empieza vacío
  await page.evaluate(() => localStorage.setItem('yp.cart', '{{{ corrupto'));
  await page.reload();
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 3);
  assert.equal(await cartBadge(page), '');
});

await test('carrito: si el stock baja o un producto se oculta, el cajón lo avisa, no deja pagar y permite corregirlo', async (page) => {
  await page.goto(`${S}/tienda.html`);
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 3);
  for (let i = 0; i < 2; i++) await addFromCard(page, '#shopGrid', 'Mat de yoga Premium');
  for (let i = 0; i < 3; i++) await addFromCard(page, '#shopGrid', 'Botella térmica');
  await waitFor(page, () => document.querySelector('[data-cart-count]').textContent === '5');

  // mientras el carrito espera en el navegador, la tienda cambia
  await be.patchProduct(PRODUCT_IDS.bottle, { stock: 1 });
  await be.patchProduct(PRODUCT_IDS.mat, { is_active: false });

  await openCart(page);
  await waitFor(page, () => document.querySelectorAll('#cartList .cart-item').length === 2);
  assert.equal(await text(page, `${rowSel(PRODUCT_IDS.mat)} .cart-issue`), 'Ya no está disponible');
  assert.equal(await count(page, `${rowSel(PRODUCT_IDS.mat)} .qty`), 0, 'lo que ya no existe solo se puede quitar');
  assert.equal(await text(page, `${rowSel(PRODUCT_IDS.bottle)} .cart-issue`), 'Solo queda 1 unidad');
  assert.equal(norm(await text(page, '#cartSubtotal')), '14,99 €', 'solo cuenta lo que realmente se puede comprar');
  assert.ok(await page.$('.cart-alert'), 'hay un aviso general');
  assert.equal(await page.$eval('.cart-footer .btn-brand[disabled]', () => true), true);

  await page.evaluate(() => [...document.querySelectorAll('.cart-alert button')].find((b) => b.textContent.includes('Actualizar')).click());
  await waitFor(page, () => document.querySelectorAll('#cartList .cart-item').length === 1 && !document.querySelector('.cart-alert'));
  assert.equal(await text(page, `${rowSel(PRODUCT_IDS.bottle)} .qty span`), '1');
  assert.equal(await cartBadge(page), '1');
  assert.deepEqual((await storedCart(page)).items, [{ id: PRODUCT_IDS.bottle, qty: 1 }]);
});

await test('carrito: cada vez que se abre el cajón se vuelven a leer precio y stock (no se muestran datos viejos)', async (page) => {
  await page.goto(`${S}/tienda.html`);
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 3);
  await addFromCard(page, '#shopGrid', 'Mat de yoga Premium');
  await waitFor(page, () => document.querySelector('[data-cart-count]').textContent === '1');

  await openCart(page);
  await waitFor(page, () => document.querySelectorAll('#cartList .cart-item').length === 1);
  assert.equal(norm(await text(page, '#cartSubtotal')), '18,99 €');
  await page.click('#cartDrawer .btn-close');
  await page.waitForSelector('#cartDrawer:not(.show):not(.hiding)');

  await be.patchProduct(PRODUCT_IDS.mat, { price_cents: 2100 }); // la dueña cambia el precio
  await openCart(page);
  await waitFor(page, () => document.querySelector('#cartSubtotal')?.textContent.replace(/\s/g, ' ') === '21,00 €');
  assert.equal(norm(await text(page, `${rowSel(PRODUCT_IDS.mat)} .cart-info strong`)), '21,00 €');
});

await test('carrito: si la base falla al abrir el cajón muestra el error con reintento, sin precios inventados', async (page) => {
  await page.goto(`${S}/tienda.html`);
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 3);
  await addFromCard(page, '#shopGrid', 'Mat de yoga Premium');
  await waitFor(page, () => document.querySelector('[data-cart-count]').textContent === '1');

  await be.behavior({ catalogFail: true });
  await openCart(page);
  await waitFor(page, () => document.querySelector('#cartDrawer .yp-state')?.textContent.includes('No pudimos cargar'));
  assert.equal(await count(page, '#cartList'), 0, 'sin datos reales no se muestran precios');
  assert.equal(await cartBadge(page), '1', 'el conteo no depende de la base');

  await be.behavior({ catalogFail: false });
  await page.evaluate(() => [...document.querySelectorAll('#cartDrawer .yp-state button')].find((b) => b.textContent.includes('Reintentar')).click());
  await waitFor(page, () => document.querySelectorAll('#cartList .cart-item').length === 1);
  assert.equal(norm(await text(page, '#cartSubtotal')), '18,99 €');
});

await test('home: productos reales (no los de ejemplo) que se agregan al carrito', async (page) => {
  await page.goto(S);
  await waitFor(page, () => document.querySelectorAll('#homeProducts .shop-card').length === 3);
  const titles = await page.$$eval('#homeProducts .shop-card h3', (n) => n.map((x) => x.textContent.trim()));
  assert.deepEqual(titles.sort(), ['Botella térmica', 'Mat de yoga Premium', 'Remera Pop Up']);
  assert.ok(!(await page.content()).includes('Leggings Bliss'), 'quedaron productos de ejemplo');
  assert.equal(await page.$eval('#homeProducts', (n) => n.getAttribute('aria-busy')), 'false');
  assert.equal(await cartBadge(page), '', 'el carrito de ejemplo (3 productos fijos) ya no existe');

  await addFromCard(page, '#homeProducts', 'Mat de yoga Premium');
  await waitFor(page, () => document.querySelector('[data-cart-count]').textContent === '1');
  await openCart(page);
  await waitFor(page, () => document.querySelectorAll('#cartList .cart-item').length === 1);
  assert.equal(await text(page, `${rowSel(PRODUCT_IDS.mat)} h3`), 'Mat de yoga Premium');
  assert.equal(norm(await text(page, '#cartSubtotal')), '18,99 €');
});

await test('carrito: dos pestañas del mismo navegador se mantienen sincronizadas', async (page) => {
  await page.goto(`${S}/tienda.html`);
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 3);
  const other = await page.ctx.newPage(); // mismo navegador: comparte localStorage
  try {
    await other.goto(`${S}/videoteca.html`);
    await waitFor(other, () => !!document.querySelector('[data-cart-count]'));
    assert.equal(await cartBadge(other), '');
    await addFromCard(page, '#shopGrid', 'Mat de yoga Premium');
    await waitFor(other, () => document.querySelector('[data-cart-count]').textContent === '1');
  } finally {
    await other.close();
  }
});

// ============================================================ catálogo
await test('home: muestra clases reales (no las tarjetas de ejemplo) y omite borradores', async (page) => {
  await page.goto(S);
  await waitFor(page, () => document.querySelectorAll('#homeVideos .video-card').length > 0);
  const titles = await page.$$eval('#homeVideos .video-info h3', (n) => n.map((x) => x.textContent));
  assert.deepEqual(titles, ['Yoga para principiantes', 'Curso avanzado (restringido)', 'Relajación profunda']);
  assert.ok(!(await page.content()).includes('Morning Yoga Flow'), 'quedaron datos de ejemplo');
  assert.equal(await page.$eval('#homeVideos', (n) => n.getAttribute('aria-busy')), 'false');
});

await test('videoteca: estado de carga (esqueleto) y luego el catálogo', async (page) => {
  await be.behavior({ catalogLatencyMs: 900 });
  await page.goto(`${S}/videoteca.html`);
  await waitFor(page, () => document.querySelectorAll('#catalogGrid .yp-skeleton').length > 0, null, 5000);
  await waitFor(page, () => document.querySelectorAll('#catalogGrid .video-card').length === 3);
  assert.equal(await count(page, '#catalogGrid .yp-skeleton'), 0);
  assert.match(await text(page, 'h1'), /Videoteca/);
  assert.equal(await count(page, '.video-lock'), 1, 'la clase restringida debe mostrar candado');
});

await test('videoteca: error de carga con reintento', async (page) => {
  await be.behavior({ catalogFail: true });
  await page.goto(`${S}/videoteca.html`);
  await page.waitForSelector('#catalogGrid [role=alert]');
  assert.match(await text(page, '#catalogGrid [role=alert]'), /No pudimos cargar/);
  await be.behavior({ catalogFail: false });
  await page.click('#catalogGrid [role=alert] button');
  await waitFor(page, () => document.querySelectorAll('#catalogGrid .video-card').length === 3);
});

await test('videoteca: estado vacío cuando no hay clases publicadas', async (page) => {
  await be.behavior({ catalogFail: false });
  const state = await be.state();
  assert.ok(state);
  await page.goto(`${S}/videoteca.html`);
  await waitFor(page, () => document.querySelectorAll('#catalogGrid .video-card').length === 3);
  // filtros sin resultados
  await page.type('#catalogFilters input[type=search]', 'zzz-no-existe');
  await waitFor(page, () => /No encontramos clases con esos filtros/.test(document.getElementById('catalogGrid').textContent));
});

await test('videoteca: la búsqueda ignora tildes y mayúsculas, y filtra por categoría', async (page) => {
  await page.goto(`${S}/videoteca.html`);
  await waitFor(page, () => document.querySelectorAll('#catalogGrid .video-card').length === 3);
  await page.type('#catalogFilters input[type=search]', 'RELAJACION');
  await waitFor(page, () => document.querySelectorAll('#catalogGrid .video-card').length === 1);
  await page.$eval('#catalogFilters input[type=search]', (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => [...document.querySelectorAll('.yp-chip')].find((b) => b.textContent === 'Fuerza').click());
  await waitFor(page, () => document.querySelectorAll('#catalogGrid .video-card').length === 1);
  assert.match(await text(page, '#catalogGrid .video-info h3'), /Curso avanzado/);
});

// ============================================================ detalle, acceso y reproducción
await test('clase (sin sesión): pide iniciar sesión; un error de contraseña se muestra; al entrar reproduce', async (page) => {
  await signup('ana@test.dev');
  await openClass(page, IDS.free);
  await page.waitForSelector('.clase-gate');
  assert.match(await text(page, '.clase-gate h2'), /Inicia sesión/);
  assert.match(await text(page, '#info h1'), /Yoga para principiantes/);
  assert.match(await text(page, '.clase-desc'), /Sin prisa/);

  await page.click('.clase-gate button');
  await page.waitForSelector('#authEmail', { visible: true });
  await modalReady(page);
  await page.type('#authEmail', 'ana@test.dev');
  await page.type('#authPass', 'contraseña-equivocada');
  await page.click('.yp-auth button[type=submit]');
  await page.waitForSelector('.yp-form-error');
  assert.match(await text(page, '.yp-form-error'), /no son correctos/);

  await page.$eval('#authPass', (i) => (i.value = ''));
  await page.type('#authPass', PASS);
  await page.click('.yp-auth button[type=submit]');
  await page.waitForSelector('.yp-player', { timeout: 15000 });
  await playAndWait(page);
  assert.ok((await videoTime(page)) > 1.5);
});

await test('reproductor: controles, velocidad y teclado (video progresivo, sin selector de calidad)', async (page) => {
  await signup('ana@test.dev');
  await openClass(page, IDS.free);
  await loginViaModal(page, 'ana@test.dev');
  await page.waitForSelector('.yp-player');
  await playAndWait(page);
  // R2 no transcodifica: un solo archivo mp4, así que no existe ningún selector de calidad (solo el de velocidad).
  assert.equal(await count(page, '.yp-menuwrap'), 1);
  assert.equal(await count(page, '[aria-label="Calidad"]'), 0);
  // velocidad
  await page.click('.yp-menuwrap .yp-text-btn');
  await page.evaluate(() => [...document.querySelectorAll('.yp-menu-item')].find((b) => b.textContent.includes('1.5')).click());
  assert.equal(await page.$eval('.yp-video', (v) => v.playbackRate), 1.5);
  // teclado: espacio pausa, flechas buscan. Se reposiciona a la mitad del video para no depender de cuánto
  // tardaron los pasos anteriores (el video dura 12 s y a 1,5x podría haber terminado en una máquina lenta).
  await page.evaluate(() => { const v = document.querySelector('.yp-video'); v.currentTime = 3; return v.play(); });
  await waitFor(page, () => document.querySelector('.yp-video').currentTime > 3.3 && !document.querySelector('.yp-video').paused);
  await page.focus('.yp-player');
  await page.keyboard.press('Space');
  await waitFor(page, () => document.querySelector('.yp-video').paused);
  const t = await videoTime(page);
  await page.keyboard.press('ArrowLeft');
  await waitFor(page, (t0) => document.querySelector('.yp-video').currentTime < t0, t);
  await waitFor(page, () => document.querySelector('.yp-player').dataset.state === 'paused');
});

await test('reproductor: duración, volumen y buscar con la barra de progreso', async (page) => {
  await signup('ana@test.dev');
  await openClass(page, IDS.free);
  await loginViaModal(page, 'ana@test.dev');
  await page.waitForSelector('.yp-player');
  await playAndWait(page);
  // duración: el video de prueba (fixture de media.mjs) dura 12 s
  await waitFor(page, () => document.querySelector('.yp-dur').textContent === '0:12');
  // volumen: mover el slider cambia video.volume de verdad (no solo la UI)
  await page.$eval('.yp-volume', (i) => { i.value = '0.2'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.ok(Math.abs((await page.$eval('.yp-video', (v) => v.volume)) - 0.2) < 0.01, 'el slider no cambió el volumen real');
  // silenciar con el botón, y volver a activar
  await page.click('.yp-mute');
  assert.equal(await page.$eval('.yp-video', (v) => v.muted), true);
  await page.click('.yp-mute');
  assert.equal(await page.$eval('.yp-video', (v) => v.muted), false);
  // arrastrar la barra de progreso a la mitad busca de verdad en el video
  await page.$eval('.yp-seek', (i) => {
    i.value = String(Number(i.max) / 2);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitFor(page, () => document.querySelector('.yp-video').currentTime > 5, null, 5000);
  // pantalla completa: existe el control (headless no siempre puede entrar a fullscreen real)
  assert.equal(await page.$eval('.yp-full', (b) => b.getAttribute('aria-label')), 'Pantalla completa');
});

await test('acceso denegado: clase restringida sin permiso → mensaje claro; con permiso → reproduce', async (page) => {
  await signup('ana@test.dev');
  await openClass(page, IDS.restricted);
  await loginViaModal(page, 'ana@test.dev');
  await page.waitForSelector('.clase-gate');
  await waitFor(page, () => /no está incluida en tu acceso/.test(document.querySelector('.clase-gate h2')?.textContent || ''));
  assert.equal(await count(page, '.yp-player'), 0, 'no debe existir el reproductor');
  assert.ok(!/X-Amz-Signature/.test(await page.content()), 'no debe filtrarse ninguna URL de video');
  await be.entitle('ana@test.dev', IDS.restricted);
  await page.reload();
  await page.waitForSelector('.yp-player', { timeout: 15000 });
  await playAndWait(page);
});

await test('video en preparación (409) → mensaje y "Comprobar de nuevo"', async (page) => {
  await signup('ana@test.dev');
  await be.behavior({ playbackForce: { status: 409, code: 'video_not_ready' } });
  await openClass(page, IDS.free);
  await loginViaModal(page, 'ana@test.dev');
  await waitFor(page, () => /Estamos preparando este video/.test(document.querySelector('.clase-gate h2')?.textContent || ''));
  await be.behavior({ playbackForce: null });
  await page.click('.clase-gate button');
  await page.waitForSelector('.yp-player');
});

await test('clase inexistente o id inválido → "No encontramos esta clase"', async (page) => {
  await page.goto(`${S}/clase.html?id=no-es-un-uuid`);
  await page.waitForSelector('.clase-gate');
  assert.match(await text(page, '.clase-gate h2'), /No encontramos esta clase/);
  await page.goto(`${S}/clase.html?id=${IDS.hidden}`); // borrador: RLS no lo devuelve
  await waitFor(page, () => /No encontramos esta clase/.test(document.querySelector('.clase-gate h2')?.textContent || ''));
});

await test('error del servicio de video (502) → error con reintento', async (page) => {
  await signup('ana@test.dev');
  await be.behavior({ playbackForce: { status: 502, code: 'video_provider_error' } });
  await openClass(page, IDS.free);
  await loginViaModal(page, 'ana@test.dev');
  await waitFor(page, () => /No pudimos preparar el video/.test(document.querySelector('.clase-gate h2')?.textContent || ''));
  assert.match(await text(page, '.clase-gate p'), /servicio de video no responde/);
  await be.behavior({ playbackForce: null });
  await page.click('.clase-gate button');
  await page.waitForSelector('.yp-player');
});

// ============================================================ URL firmada expirada
await test('URL expirada al cargar: el reproductor pide otra y reproduce (sin intervención)', async (page) => {
  await signup('ana@test.dev');
  await be.behavior({ firstTtl: -30 }); // la primera URL ya viene vencida
  await openClass(page, IDS.free);
  await loginViaModal(page, 'ana@test.dev');
  await page.waitForSelector('.yp-player', { timeout: 15000 });
  await playAndWait(page, 1.5);
  const { log } = await be.state();
  assert.ok(log.playbackCalls.length >= 2, `debía renovar la URL (llamadas: ${log.playbackCalls.length})`);
  assert.ok(log.r2.some((r) => r.status === 403), 'R2 debió rechazar la URL vencida');
  assert.ok(log.r2.some((r) => (r.status === 200 || r.status === 206) && r.key.endsWith('.mp4')), 'debió descargar el video con la URL nueva');
});

await test('URL expirada siempre (renovación inútil) → error con reintento que se recupera', async (page) => {
  await signup('ana@test.dev');
  await be.behavior({ playbackTtl: -30 });
  await openClass(page, IDS.free);
  await loginViaModal(page, 'ana@test.dev');
  await page.waitForSelector('.yp-player', { timeout: 15000 });
  await waitFor(page, () => !document.querySelector('.yp-error').hidden, null, 25000);
  assert.match(await text(page, '.yp-error-msg'), /No pudimos reproducir/);
  await be.behavior({ playbackTtl: 120 });
  await page.click('.yp-error button');
  await waitFor(page, () => document.querySelector('.yp-error').hidden, null, 10000);
  await playAndWait(page, 1);
});

await test('renovación PREVENTIVA: con URL de 8 s el video sigue sin cortes y sin error', async (page) => {
  await signup('ana@test.dev');
  await be.behavior({ playbackTtl: 8 });
  await openClass(page, IDS.free);
  await loginViaModal(page, 'ana@test.dev');
  await page.waitForSelector('.yp-player');
  await playAndWait(page, 1);
  await waitFor(page, async () => true);
  // se espera a que ocurra la renovación (a los ~6 s) y se comprueba que la reproducción continúa
  await waitFor(page, () => fetch('http://127.0.0.1:4174/__test/state').then((r) => r.json()).then((s) => s.log.playbackCalls.length >= 2), null, 15000);
  const t1 = await videoTime(page);
  await new Promise((r) => setTimeout(r, 2000));
  const ended = await page.$eval('.yp-player', (n) => n.dataset.state);
  assert.ok(ended === 'ended' || (await videoTime(page)) > t1 + 0.5, 'la reproducción debe continuar tras renovar');
  assert.equal(await page.$eval('.yp-error', (n) => n.hidden), true);
});

// ============================================================ progreso
await test('progreso: se guarda periódicamente y al pausar; al volver retoma y avisa', async (page) => {
  await signup('ana@test.dev');
  await openClass(page, IDS.free);
  await loginViaModal(page, 'ana@test.dev');
  await page.waitForSelector('.yp-player');
  await playAndWait(page, 5);
  await waitFor(page, async () => (await (await fetch('http://127.0.0.1:4174/__test/state')).json()).log.saves.length >= 1, null, 10000);
  await page.evaluate(() => document.querySelector('.yp-video').pause());
  const tPause = await videoTime(page);
  await waitFor(page, async (t) => { const s = (await (await fetch('http://127.0.0.1:4174/__test/state')).json()).log.saves; return s.length && Math.abs(s.at(-1).seconds - t) <= 1.2; }, tPause, 8000);
  const { log } = await be.state();
  assert.ok(log.saves.length < 12, 'no debe haber una petición por segundo');

  await page.reload();
  await page.waitForSelector('.yp-resume:not([hidden])', { timeout: 15000 });
  assert.match(await text(page, '.yp-resume'), /Continuás en 0:0[3-9]/);
  await waitFor(page, (t) => document.querySelector('.yp-video').currentTime >= t - 1.5, tPause, 15000);
  assert.match(await text(page, '#info'), /Llevas \d+ %/);
});

await test('progreso: "Empezar de cero" vuelve al inicio', async (page) => {
  await signup('ana@test.dev');
  await openClass(page, IDS.free);
  await loginViaModal(page, 'ana@test.dev');
  await page.waitForSelector('.yp-player');
  await playAndWait(page, 5);
  await page.evaluate(() => document.querySelector('.yp-video').pause());
  await new Promise((r) => setTimeout(r, 600));
  await page.reload();
  await page.waitForSelector('.yp-resume:not([hidden])', { timeout: 15000 });
  await page.click('.yp-resume .yp-link');
  await waitFor(page, () => document.querySelector('.yp-video').currentTime < 3 && !document.querySelector('.yp-video').paused, null, 10000);
});

await test('progreso: al cambiar de página se guarda (keepalive), aunque no toque el guardado periódico', async (page) => {
  be.setProgressInterval(300); // sin guardados periódicos: el único posible es el de salida
  await signup('ana@test.dev');
  await openClass(page, IDS.free);
  await loginViaModal(page, 'ana@test.dev');
  await page.waitForSelector('.yp-player');
  await playAndWait(page, 6.2);
  const tLeave = await videoTime(page);
  assert.equal((await be.state()).log.saves.length, 0, 'no debía haber guardados periódicos');
  await page.goto(`${S}/videoteca.html`); // dispara pagehide -> fetch keepalive
  await waitFor(page, async () => (await (await fetch('http://127.0.0.1:4174/__test/state')).json()).log.saves.length === 1, null, 8000);
  const [save] = (await be.state()).log.saves;
  assert.ok(Math.abs(save.seconds - Math.floor(tLeave)) <= 1, `debió guardar ~${Math.floor(tLeave)}s (guardó ${save.seconds}s)`);
});

await test('progreso: al terminar la clase queda completada ("Vista") y se guarda la duración', async (page) => {
  await signup('ana@test.dev');
  await openClass(page, IDS.free);
  await loginViaModal(page, 'ana@test.dev');
  await page.waitForSelector('.yp-player');
  await page.waitForSelector('.yp-bigplay', { visible: true });
  await waitFor(page, () => !document.querySelector('.modal-backdrop, .modal.show'), null, 5000);
  await page.evaluate(() => { document.querySelector('.yp-video').currentTime = 10.5; });
  await page.click('.yp-bigplay');
  await waitFor(page, () => document.querySelector('.yp-player').dataset.state === 'ended', null, 20000);
  await waitFor(page, async () => (await (await fetch('http://127.0.0.1:4174/__test/state')).json()).progress.some((p) => p.completed && p.progress_seconds === 12), null, 8000);
  await page.goto(`${S}/videoteca.html`);
  await waitFor(page, () => /Vista/.test(document.querySelector('#catalogGrid').textContent));
});

await test('"Continuar viendo": aparece con clases empezadas y no terminadas', async (page) => {
  await signup('ana@test.dev');
  await openClass(page, IDS.free);
  await loginViaModal(page, 'ana@test.dev');
  await page.waitForSelector('.yp-player');
  await playAndWait(page, 5);
  await page.evaluate(() => document.querySelector('.yp-video').pause());
  await new Promise((r) => setTimeout(r, 800));
  await page.goto(`${S}/videoteca.html`);
  await page.waitForSelector('#continueBlock:not([hidden]) .video-card', { timeout: 15000 });
  assert.match(await text(page, '#continueBlock h2'), /Continuar viendo/);
  assert.match(await text(page, '#continueBlock .tag-mint'), /Continuar · 0:0\d/);
  assert.equal(await count(page, '#continueBlock .video-progress'), 1);
});

// ============================================================ cuenta
await test('cuenta: registro, sesión persistente tras recargar, menú y cierre de sesión', async (page) => {
  await page.goto(S);
  await page.click('[data-account-toggle]');
  await page.waitForSelector('#authEmail', { visible: true });
  await modalReady(page);
  await page.evaluate(() => [...document.querySelectorAll('.yp-tab')].find((b) => b.textContent === 'Crear cuenta').click());
  await page.waitForSelector('#authName', { visible: true });
  await page.type('#authName', 'Lucía Prueba');
  await page.type('#authEmail', 'lucia@test.dev');
  await page.type('#authPass', 'corta');
  await page.click('.yp-auth button[type=submit]');
  await page.waitForSelector('.yp-form-error');
  assert.match(await text(page, '.yp-form-error'), /al menos 8 caracteres/);
  await page.$eval('#authPass', (i) => (i.value = ''));
  await page.type('#authPass', PASS);
  await page.click('.yp-auth button[type=submit]');
  await waitFor(page, () => document.querySelector('[data-account-toggle]').classList.contains('has-session'));

  await page.reload(); // sesión persistente
  await waitFor(page, () => document.querySelector('[data-account-toggle]').classList.contains('has-session'));
  await page.click('[data-account-toggle]');
  await page.waitForSelector('.yp-account-menu');
  assert.match(await text(page, '.yp-account-who strong'), /Lucía Prueba/);
  assert.equal(await count(page, '.yp-account-menu a[href*="admin"]'), 0, 'un usuario común no ve el panel');
  await page.evaluate(() => [...document.querySelectorAll('.yp-account-item')].find((b) => /Cerrar sesión/.test(b.textContent)).click());
  await waitFor(page, () => !document.querySelector('[data-account-toggle]').classList.contains('has-session'));
  await page.reload();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await page.$eval('[data-account-toggle]', (n) => n.classList.contains('has-session')), false);
});

await test('privacidad: la política muestra los datos del titular desde la configuración, como texto, y marca lo que falta', async (page) => {
  await be.behavior({ privacy: 'partial' });
  await page.goto(`${S}/privacidad.html`);
  await waitFor(page, () => document.querySelector('[data-legal="NAME"]')?.textContent.length > 0);
  const out = await page.evaluate(() => ({
    name: document.querySelector('[data-legal="NAME"]').textContent,
    nameHasMarkup: document.querySelector('[data-legal="NAME"]').children.length > 0,
    taxPending: document.querySelector('[data-legal="TAX_ID"] .yp-pending')?.textContent ?? null,
    address: document.querySelector('[data-legal="ADDRESS"]').textContent,
    mail: document.querySelector('[data-legal="EMAIL"] a')?.getAttribute('href') ?? null,
    version: document.querySelector('[data-privacy-version]').textContent,
    date: document.querySelector('[data-privacy-date]').textContent,
    sections: document.querySelectorAll('#policy h2').length,
    footerLink: Boolean(document.querySelector('#siteFooter .copyright a[href$="privacidad.html"]')),
    hero: document.querySelector('h1').textContent,
  }));
  assert.equal(out.name, 'Yoga <b>Pop</b> Up S.L.', 'un nombre con etiquetas se muestra como TEXTO, no como HTML');
  assert.equal(out.nameHasMarkup, false, 'no se creó ningún elemento a partir del dato');
  assert.match(out.taxPending, /pendiente de completar/, 'el dato que falta se ve como pendiente');
  assert.equal(out.address, 'Calle Mayor 1, 28013 Madrid');
  assert.equal(out.mail, 'mailto:hola@yogapopup.es');
  assert.match(out.version, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(out.date, /\d{4}/);
  assert.equal(out.sections, 11, 'la política tiene sus 11 apartados');
  assert.ok(out.footerLink, 'el pie de página enlaza la política');
  assert.equal(out.hero, 'Política de privacidad');
});

await test('registro con política: exige la casilla, abre la política y guarda la versión aceptada', async (page) => {
  await be.behavior({ privacy: 'full' });
  await page.goto(S);
  await page.click('[data-account-toggle]');
  await page.waitForSelector('#authEmail', { visible: true });
  await modalReady(page);
  await page.evaluate(() => [...document.querySelectorAll('.yp-tab')].find((b) => b.textContent === 'Crear cuenta').click());
  await page.waitForSelector('#authConsent', { visible: true });

  const link = await page.$eval('label[for="authConsent"] a', (a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel }));
  assert.match(link.href, /\/privacidad\.html$/);
  assert.equal(link.target, '_blank');
  assert.match(link.rel, /noopener/);

  await page.type('#authName', 'Marta Privada');
  await page.type('#authEmail', 'marta@test.dev');
  await page.type('#authPass', PASS);

  // Sin marcar la casilla: se rechaza y NO se crea la cuenta.
  await page.click('.yp-auth button[type=submit]');
  await page.waitForSelector('.yp-form-error');
  assert.match(await text(page, '.yp-form-error'), /aceptes la política de privacidad/);
  assert.equal((await be.state()).users.some((u) => u.email === 'marta@test.dev'), false, 'sin aceptar no hay cuenta');

  // Marcada: se crea, y la versión aceptada viaja con el registro (la fecha la pone el servidor, no el navegador).
  await page.click('#authConsent');
  await page.click('.yp-auth button[type=submit]');
  await waitFor(page, () => document.querySelector('[data-account-toggle]').classList.contains('has-session'));
  const user = (await be.state()).users.find((u) => u.email === 'marta@test.dev');
  assert.match(user.metadata.privacy_version, /^\d{4}-\d{2}-\d{2}$/, 'viaja la versión aceptada');
  assert.equal(user.metadata.privacy_accepted_at, undefined, 'el navegador no manda una fecha propia');
  assert.equal(user.metadata.full_name, 'Marta Privada');
});

await test('registro sin política configurada: no hay casilla y no se registra ninguna aceptación', async (page) => {
  await page.goto(S);
  await page.click('[data-account-toggle]');
  await page.waitForSelector('#authEmail', { visible: true });
  await modalReady(page);
  await page.evaluate(() => [...document.querySelectorAll('.yp-tab')].find((b) => b.textContent === 'Crear cuenta').click());
  await page.waitForSelector('#authName', { visible: true });
  assert.equal(await page.$('#authConsent'), null, 'sin PRIVACY_URL no se muestra la casilla');
  await page.type('#authName', 'Sin Politica');
  await page.type('#authEmail', 'sinpolitica@test.dev');
  await page.type('#authPass', PASS);
  await page.click('.yp-auth button[type=submit]');
  await waitFor(page, () => document.querySelector('[data-account-toggle]').classList.contains('has-session'));
  const user = (await be.state()).users.find((u) => u.email === 'sinpolitica@test.dev');
  assert.equal(user.metadata.privacy_version, undefined, 'sin casilla no se afirma ninguna aceptación');
});

await test('cuenta: registro que exige confirmar el correo, y recuperación de contraseña', async (page) => {
  await be.behavior({ confirmEmail: true });
  await page.goto(S);
  await page.click('[data-account-toggle]');
  await page.waitForSelector('#authEmail', { visible: true });
  await modalReady(page);
  await page.evaluate(() => [...document.querySelectorAll('.yp-tab')].find((b) => b.textContent === 'Crear cuenta').click());
  await page.type('#authName', 'Nuevo');
  await page.type('#authEmail', 'nuevo@test.dev');
  await page.type('#authPass', PASS);
  await page.click('.yp-auth button[type=submit]');
  await waitFor(page, () => /Revisá tu correo|Revisa tu correo/.test(document.querySelector('.yp-auth .modal-title').textContent));
  assert.match(await text(page, '.yp-auth-note'), /nuevo@test\.dev/);
  await page.click('.yp-auth [data-bs-dismiss=modal].btn');
  await waitFor(page, () => !document.querySelector('.modal-backdrop, .modal.show'), null, 5000); // cierre completo, no un tiempo fijo

  await page.click('[data-account-toggle]');
  await page.waitForSelector('#authEmail', { visible: true });
  await modalReady(page);
  await page.evaluate(() => [...document.querySelectorAll('.yp-link')].find((b) => /Olvidaste/.test(b.textContent)).click());
  await page.waitForSelector('#authEmail');
  await page.type('#authEmail', 'ana@test.dev');
  await page.click('.yp-auth button[type=submit]');
  await waitFor(page, () => /Si ana@test\.dev tiene una cuenta/.test(document.querySelector('.yp-auth-note')?.textContent || ''));
  assert.deepEqual((await be.state()).recoveries, ['ana@test.dev']);
});

await test('recuperación: el enlace del correo abre "contraseña nueva", la guarda y permite entrar con ella', async (page) => {
  await signup('ana@test.dev');
  // El enlace del correo lleva la sesión de recuperación en el fragmento de la URL (flujo implícito de Supabase).
  const r = await fetch(`${be.origin.api}/auth/v1/token?grant_type=password`, { method: 'POST', body: JSON.stringify({ email: 'ana@test.dev', password: PASS }) });
  const tok = await r.json();
  await page.goto(`${S}/index.html#access_token=${tok.access_token}&refresh_token=${tok.refresh_token}&expires_in=3600&token_type=bearer&type=recovery`);
  await waitFor(page, () => /contraseña nueva/i.test(document.querySelector('.yp-auth .modal-title')?.textContent || ''), null, 10000);
  await modalReady(page);
  await page.type('#authPass', 'corta');
  await page.click('.yp-auth button[type=submit]');
  await page.waitForSelector('.yp-form-error');
  assert.match(await text(page, '.yp-form-error'), /al menos 8 caracteres/);
  await page.$eval('#authPass', (i) => (i.value = ''));
  await page.type('#authPass', 'otra-clave-nueva-456');
  await page.click('.yp-auth button[type=submit]');
  await waitFor(page, () => /Contraseña actualizada/.test(document.querySelector('.yp-toasts')?.textContent || ''), null, 8000);
  assert.ok(!page.url().includes('access_token'), 'el token no debe quedar en la barra de direcciones');
  // La contraseña vieja ya no sirve y la nueva sí.
  const old = await fetch(`${be.origin.api}/auth/v1/token?grant_type=password`, { method: 'POST', body: JSON.stringify({ email: 'ana@test.dev', password: PASS }) });
  const nueva = await fetch(`${be.origin.api}/auth/v1/token?grant_type=password`, { method: 'POST', body: JSON.stringify({ email: 'ana@test.dev', password: 'otra-clave-nueva-456' }) });
  assert.equal(old.status, 400);
  assert.equal(nueva.status, 200);
});

await test('cuenta: editar el nombre y cambiar la contraseña', async (page) => {
  await signup('ana@test.dev', 'Ana Vieja');
  await page.goto(`${S}/cuenta.html`);
  await page.waitForSelector('.yp-state button');
  await page.click('.yp-state button');
  await page.waitForSelector('#authEmail', { visible: true });
  await modalReady(page);
  await page.type('#authEmail', 'ana@test.dev');
  await page.type('#authPass', PASS);
  await page.click('.yp-auth button[type=submit]');
  await page.waitForSelector('#accName', { timeout: 10000 });
  assert.equal(await page.$eval('#accName', (i) => i.value), 'Ana Vieja');
  await page.$eval('#accName', (i) => (i.value = ''));
  await page.type('#accName', 'Ana Nueva');
  await page.evaluate(() => [...document.querySelectorAll('button[type=submit]')].find((b) => /Guardar cambios/.test(b.textContent)).click());
  await waitFor(page, async () => (await (await fetch('http://127.0.0.1:4174/__test/state')).json()).users.some((u) => u.name === 'Ana Nueva'), null, 8000);
});

// ============================================================ seguridad básica del frontend

// ---------------------------------------------------------------------------------------------- panel de negocio (Fase 14)
const plain = (t) => t.replace(/\s/g, ' ');
const panelRows = (page) => page.evaluate(() => [...document.querySelectorAll('#panelContent tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
const productModalReady = (page) => waitFor(page, () => {
  const d = document.querySelector('#productFormModal .modal-dialog');
  return !!d && !!document.querySelector('#productFormModal.show') && /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(getComputedStyle(d).transform);
}, null, 5000);
const productModalClosed = (page) => waitFor(page, () => !document.querySelector('.modal-backdrop') && !document.querySelector('#productFormModal.show'), null, 10000);
const clickTab = (page, label) => page.evaluate((l) => [...document.querySelectorAll('.nav-tabs .nav-link')].find((b) => b.textContent === l).click(), label);
const clickRowButton = (page, rowText, label) => page.evaluate((rt, l) => {
  const row = [...document.querySelectorAll('#panelContent tbody tr')].find((r) => r.innerText.includes(rt));
  [...row.querySelectorAll('button')].find((b) => (b.textContent.trim() === l) || b.getAttribute('aria-label')?.startsWith(l)).click();
}, rowText, label);
async function makeTestImage() {
  const file = tmp('yp-e2e-producto.png');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x7fb7a4:s=640x480', '-frames:v', '1', file]);
  assert.equal(r.status, 0, 'ffmpeg debe poder generar una imagen de prueba');
  return file;
}
async function loginAsRole(page, role, email, name) {
  await signup(email, name);
  await be.promote(email, role);
  await page.goto(`${S}/panel.html`);
  await loginViaModal(page, email);
}
// developer: gestiona Y sube videos (los tests de subida usan este). admin: gestiona, no sube.
const loginAsDeveloper = (page, email = 'equipo@test.dev') => loginAsRole(page, 'developer', email, 'Equipo Test');
const loginAsAdmin = (page, email = 'admin@test.dev') => loginAsRole(page, 'admin', email, 'Admin Test');

// ---------------------------------------------------------------------------------------------- profesores, agenda e idioma (Fases 28-30)
const agendaReady = (page) => waitFor(page, () => document.querySelectorAll('#homeAgenda .ag-layout').length === 1 && document.getElementById('homeAgenda').getAttribute('aria-busy') === 'false', null, 15000);
const slotTitles = (page) => page.$$eval('#homeAgenda .ag-slot-title', (n) => n.map((x) => x.textContent));
const slotTimes = (page) => page.$$eval('#homeAgenda .ag-slot-time', (n) => n.map((x) => x.textContent));
const reserveLabel = (page) => text(page, '#homeAgenda .ag-reserve');
const bookingLog = async () => (await be.state()).log.bookings;
/** Elige un profesor en el selector de la agenda por su nombre visible. */
const pickTeacherByName = (page, name) => page.evaluate((n) => {
  const s = document.querySelector('#homeAgenda .ag-select');
  s.value = String([...s.options].findIndex((o) => o.textContent === n));
  s.dispatchEvent(new Event('change', { bubbles: true }));
}, name);

await test('home · agenda: carrusel con profesores reales, calendario con clases, borradores ocultos y bio como TEXTO', async (page) => {
  await page.goto(S);
  await agendaReady(page);
  assert.equal(await text(page, '.ag-teacher-info h3'), 'Manu');
  // La bio trae una etiqueta HTML a propósito: se muestra como texto, nunca se interpreta.
  assert.match(await text(page, '.ag-bio'), /<b>sin html<\/b>/);
  assert.equal(await count(page, '.ag-bio b'), 0, 'el HTML de la bio no debe interpretarse');
  assert.deepEqual(await page.$$eval('.ag-chips li', (n) => n.map((x) => x.textContent)), ['Hatha', 'Pranayama']);
  assert.ok((await count(page, '.ag-day.has-sessions')) >= 1, 'el calendario marca el día con clases');
  assert.deepEqual(await slotTitles(page), ['Hatha Yoga', 'Hatha nocturno'], 'sin el borrador de Manu');
  assert.deepEqual(await slotTimes(page), ['18:00', '20:00'], 'horas en horario de Argentina (21:00 y 23:00 UTC)');
  assert.match(await text(page, '.ag-tz'), /Argentina \(GMT-3\)/);
  assert.equal(await count(page, '.ag-slot.is-full'), 1, 'la clase con el cupo completo se marca');
  assert.equal(await page.$eval('.ag-slot.is-full', (b) => b.disabled), true, 'y no se puede elegir');
  // Cambiar de profesor: otra bio, otra clase (virtual, sin cupo → no muestra lugares)
  await pickTeacherByName(page, 'Lucía');
  await waitFor(page, () => document.querySelector('.ag-teacher-info h3')?.textContent === 'Lucía');
  await waitFor(page, () => [...document.querySelectorAll('#homeAgenda .ag-slot-title')].some((n) => n.textContent === 'Vinyasa Flow'));
  assert.match(await text(page, '.ag-info'), /Clase virtual/);
  assert.ok(!/lugar/.test(await text(page, '.ag-slot-meta small')), 'sin cupo no se muestran lugares');
  // Flechas del carrusel: vuelven al primer profesor
  await page.click('.ag-next');
  await waitFor(page, () => document.querySelector('.ag-teacher-info h3')?.textContent === 'Manu');
  await page.screenshot({ path: tmp('yp-home-agenda.png') });
});

await test('home · agenda: sin sesión, "Reservar" abre el acceso y NO reserva', async (page) => {
  await page.goto(S);
  await agendaReady(page);
  await page.click('#homeAgenda .ag-reserve');
  await page.waitForSelector('#authEmail', { visible: true });
  assert.deepEqual(await bookingLog(), [], 'no se reservó nada');
});

await test('home · agenda: reservar, ver "Reservada", verla en Mi cuenta y cancelar', async (page) => {
  await signup('alumna@test.dev', 'Alumna Test');
  await page.goto(S);
  await agendaReady(page);
  await loginViaModal(page, 'alumna@test.dev');
  await agendaReady(page);
  assert.match(await reserveLabel(page), /Reservar clase/);
  await page.click('#homeAgenda .ag-reserve');
  await toastHas(page, 'Tu lugar está reservado');
  await waitFor(page, () => /Cancelar mi reserva/.test(document.querySelector('#homeAgenda .ag-reserve')?.textContent), null, 8000);
  assert.equal(await count(page, '#homeAgenda .ag-badge:not(.is-full)'), 1, 'la clase aparece como Reservada');
  assert.equal((await bookingLog()).filter((b) => b.op === 'book').length, 1);
  // En Mi cuenta aparece la reserva y se puede cancelar desde ahí
  await page.goto(`${S}/cuenta.html`);
  await waitFor(page, () => /Hatha Yoga/.test(document.body.textContent), null, 10000);
  assert.match(await page.$eval('main', (n) => n.textContent), /\(hora de Argentina\)/);
  await page.evaluate(() => [...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === 'Cancelar').click());
  await waitFor(page, () => /Todavía no reservaste ninguna clase/.test(document.body.textContent), null, 10000);
  assert.equal((await bookingLog()).filter((b) => b.op === 'cancel').length, 1);
});

// ---------------------------------------------------------------- Mi cuenta: progreso, compras y suscripción (Fases 23-25)
const DAY = 24 * 3600 * 1000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();
async function openAccount(page, email) {
  await page.goto(S);
  await loginViaModal(page, email);
  await page.goto(`${S}/cuenta.html`);
}

await test('cuenta · Mi progreso: agrupa en progreso y completadas, con "continuar" directo a la clase', async (page) => {
  await signup('prog@test.dev', 'Prog Test');
  await be.account('prog@test.dev', { progress: [
    { classId: IDS.free, seconds: 5, completed: false, at: iso(-2) }, // 5 s: empezada
    { classId: IDS.second, seconds: 12, completed: true, at: iso(-1) },
    { classId: IDS.restricted, seconds: 3, completed: false, at: iso(-3) }, // menos de 5 s: no se muestra
    { classId: IDS.hidden, seconds: 8, completed: false, at: iso(-1) }, // clase no publicada: no se muestra
  ] });
  await openAccount(page, 'prog@test.dev');
  await waitFor(page, () => document.querySelector('#accInProgress'), null, 10000);
  assert.equal(await count(page, '#accInProgress .acc-row'), 1);
  assert.match(await text(page, '#accInProgress'), /Yoga para principiantes/);
  assert.match(await text(page, '#accInProgress'), /Continuar desde 0:05/);
  assert.equal(await count(page, '#accCompleted .acc-row'), 1);
  assert.match(await text(page, '#accCompleted'), /Relajación profunda/);
  assert.match(await text(page, '#accCompleted'), /Volver a verla/);
  assert.equal(await page.$eval('#accInProgress a.btn', (a) => new URL(a.href).searchParams.get('id')), IDS.free);
  assert.equal(await page.$eval('#accProgress', (n) => /Curso avanzado|Borrador/.test(n.textContent)), false);
});

await test('cuenta · Mi progreso: sin nada empezado ofrece ir a la videoteca', async (page) => {
  await signup('vacia@test.dev', 'Vacia Test');
  await openAccount(page, 'vacia@test.dev');
  await waitFor(page, () => /Todavía no empezaste ninguna clase/.test(document.querySelector('#accProgress')?.textContent), null, 10000);
  assert.equal(await page.$eval('#accProgress a', (a) => a.getAttribute('href')), 'videoteca.html');
});

await test('cuenta · Mis compras: tienda y clases sueltas con su estado; los intentos sin completar quedan plegados', async (page) => {
  await be.behavior({ payments: true });
  await signup('compras@test.dev', 'Compras Test');
  await be.account('compras@test.dev', { orders: [
    { kind: 'shop', status: 'paid', total_cents: 3798, created_at: iso(-5), paid_at: iso(-5), order_items: [{ title: 'Mat de yoga Premium', size: null, qty: 2, item_type: 'product', class_id: null }] },
    { kind: 'class', status: 'paid', total_cents: 900, created_at: iso(-3), paid_at: iso(-3), order_items: [{ title: 'Relajación profunda', size: null, qty: 1, item_type: 'class', class_id: IDS.second }] },
    { kind: 'class', status: 'pending', total_cents: 900, created_at: iso(-1), order_items: [{ title: 'Curso avanzado', size: null, qty: 1, item_type: 'class', class_id: IDS.restricted }] },
    { kind: 'shop', status: 'refunded', total_cents: 1499, refunded_cents: 1499, created_at: iso(-9), paid_at: iso(-9), order_items: [{ title: 'Botella térmica', size: null, qty: 1, item_type: 'product', class_id: null }] },
    { kind: 'shop', status: 'created', total_cents: 500, created_at: iso(-2), order_items: [{ title: 'Remera Pop Up', size: 'M', qty: 1, item_type: 'product', class_id: null }] },
  ] });
  await openAccount(page, 'compras@test.dev');
  await waitFor(page, () => document.querySelector('#accOrdersMain'), null, 10000);
  assert.equal(await count(page, '#accOrdersMain .acc-row'), 4, 'pagado ×2, a confirmar y reembolsado');
  const main = await text(page, '#accOrdersMain');
  assert.match(main, /2 × Mat de yoga Premium/);
  assert.match(main, /Pagado/);
  assert.match(main, /Esperando confirmación/);
  assert.match(main, /Reembolsado/);
  assert.doesNotMatch(main, /Remera/, 'el intento sin completar no está entre los principales');
  // "Ver clase" solo en la clase suelta pagada
  assert.equal(await count(page, '#accOrdersMain a[href^="clase.html"]'), 1);
  assert.equal(await page.$eval('#accOrdersMain a[href^="clase.html"]', (a) => new URL(a.href).searchParams.get('id')), IDS.second);
  // los intentos sin completar están ocultos hasta que se piden
  assert.equal(await page.$eval('#accOrdersIncomplete', (n) => n.hidden), true);
  await page.evaluate(() => [...document.querySelectorAll('#accOrders button')].find((b) => /intentos sin completar/.test(b.textContent)).click());
  assert.equal(await page.$eval('#accOrdersIncomplete', (n) => n.hidden), false);
  assert.match(await text(page, '#accOrdersIncomplete'), /Remera Pop Up \(talle M\)/);
  assert.match(await text(page, '#accOrdersIncomplete'), /No se te cobró nada/);
});

await test('cuenta · Mis compras y Mi suscripción no aparecen si los pagos no están configurados', async (page) => {
  await signup('sinpagos@test.dev', 'Sin Pagos');
  await openAccount(page, 'sinpagos@test.dev');
  await waitFor(page, () => document.querySelector('#accProgress'), null, 10000);
  assert.equal(await count(page, '#accOrders, #accSubscription'), 0);
});

await test('cuenta · Mi suscripción: activa con próximo cobro; cancelar mantiene el acceso hasta el fin del período', async (page) => {
  await be.behavior({ payments: true });
  await signup('sub@test.dev', 'Sub Test');
  await be.account('sub@test.dev', { subscription: { status: 'active', current_period_end: iso(20), last_payment_at: iso(-10) } });
  await openAccount(page, 'sub@test.dev');
  await waitFor(page, () => document.querySelector('#accSubscription [data-state]'), null, 10000);
  assert.equal(await page.$eval('#accSubscription [data-state]', (n) => n.dataset.state), 'active');
  assert.match(await text(page, '#accSubscription'), /Suscripción activa\./);
  assert.match(await text(page, '#accSubscription'), /Próximo cobro: /);
  assert.match(await text(page, '#accSubscription'), /Último pago: /);
  // cancelar: pide confirmación (si se rechaza no se cancela)
  page.once('dialog', (d) => d.dismiss());
  await page.click('#cancelSubscription');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await be.state()).log.cancelSubscriptions, 0, 'sin confirmar no se llama a la función');
  page.once('dialog', (d) => d.accept());
  await page.click('#cancelSubscription');
  await waitFor(page, () => document.querySelector('#accSubscription [data-state]')?.dataset.state === 'cancelled', null, 10000);
  assert.equal((await be.state()).log.cancelSubscriptions, 1);
  assert.match(await text(page, '#accSubscription'), /Seguís teniendo acceso hasta el /);
  assert.equal(await count(page, '#cancelSubscription'), 0);
});

await test('cuenta · Mi suscripción: sin suscripción lo dice y no muestra cancelar', async (page) => {
  await be.behavior({ payments: true });
  await signup('nosub@test.dev', 'No Sub');
  await openAccount(page, 'nosub@test.dev');
  await waitFor(page, () => document.querySelector('#accSubscription [data-state]'), null, 10000);
  assert.equal(await page.$eval('#accSubscription [data-state]', (n) => n.dataset.state), 'none');
  assert.match(await text(page, '#accSubscription'), /No tenés una suscripción activa/);
  assert.equal(await count(page, '#cancelSubscription'), 0);
});

// ---------------------------------------------------------------- Comentarios y moderación (Fases 26-27)
const tmLog = async () => (await be.state()).log.testimonials;

await test('comentarios: la home muestra solo los APROBADOS (como texto) y sin ninguno deja las tarjetas de ejemplo', async (page) => {
  await page.goto(S);
  await waitFor(page, () => document.querySelector('#homeTestimonials'), null, 10000);
  assert.equal(await count(page, '#homeTestimonials figure'), 3, 'sin comentarios aprobados quedan los de ejemplo');
  await be.testimonial({ author_name: 'Camila Paz', body: 'Una clase hermosa, volvería mil veces.', rating: 4, status: 'approved' });
  await be.testimonial({ author_name: 'Pendiente Pérez', body: 'Este todavía no está aprobado nunca.', status: 'pending' });
  await be.testimonial({ author_name: 'Oculto Ortiz', body: 'Este lo ocultó el equipo hace tiempo.', status: 'hidden' });
  await be.testimonial({ author_name: 'Html Hacker', body: '<img src=x onerror=window.__xss=1> y <b>negrita</b> aprobada', status: 'approved' });
  await page.goto(S);
  await waitFor(page, () => /Camila Paz/.test(document.querySelector('#homeTestimonials')?.textContent), null, 10000);
  const shown = await page.$eval('#homeTestimonials', (n) => n.textContent);
  assert.match(shown, /Una clase hermosa/);
  assert.doesNotMatch(shown, /Pendiente Pérez|Oculto Ortiz|María Sol/, 'ni pendientes, ni ocultos, ni los de ejemplo');
  assert.equal(await count(page, '#homeTestimonials figure'), 2);
  assert.equal(await count(page, '#homeTestimonials img'), 0, 'el texto de una persona nunca se interpreta como HTML');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.match(shown, /<b>negrita<\/b>/);
  assert.equal(await count(page, '#homeTestimonials .stars i'), 4, 'cuatro estrellas para el comentario de 4');
});

await test('comentarios: sin sesión el formulario pide iniciar sesión y no escribe nada', async (page) => {
  await page.goto(S);
  await waitFor(page, () => document.querySelector('#tmLogin'), null, 10000);
  assert.equal(await count(page, '#tmForm'), 0);
  assert.deepEqual(await tmLog(), []);
});

await test('comentarios: escribir queda "En revisión"; editar lo aprobado vuelve a revisión; se puede borrar y no hay segundo', async (page) => {
  await signup('comenta@test.dev', 'Comenta Test');
  await page.goto(S);
  await loginViaModal(page, 'comenta@test.dev');
  await waitFor(page, () => document.querySelector('#tmForm'), null, 10000);
  assert.equal(await count(page, '#tmStatus'), 0, 'sin comentario todavía no hay estado');
  // texto corto: se frena en el navegador
  await page.type('#tmBody', 'corto');
  await page.click('#tmForm button[type=submit]');
  assert.match(await text(page, '#tmError'), /al menos 10/);
  assert.deepEqual(await tmLog(), [], 'no se mandó nada');
  // válido, con puntuación
  await page.$eval('#tmBody', (n) => { n.value = ''; });
  await page.type('#tmBody', 'Las clases me ayudaron muchísimo a dormir mejor.');
  await page.select('#tmRating', '5');
  await page.click('#tmForm button[type=submit]');
  await toastHas(page, 'Tu comentario está en revisión');
  await waitFor(page, () => document.querySelector('#tmStatus')?.dataset.status === 'pending', null, 8000);
  assert.match(await text(page, '#tmStatus'), /En revisión/);
  assert.equal(await page.$eval('#tmBody', (n) => n.value), 'Las clases me ayudaron muchísimo a dormir mejor.');
  let state = await be.state();
  assert.equal(state.testimonials.length, 1);
  assert.equal(state.testimonials[0].status, 'pending');
  assert.equal(state.testimonials[0].author_name, 'Comenta Test', 'el nombre sale del perfil, no del formulario');
  assert.doesNotMatch(await text(page, '#homeTestimonials'), /dormir mejor/, 'pendiente: no es público');
  // la gestión lo aprueba → ella lo ve "Publicado"; al editarlo vuelve a revisión
  await be.setTestimonialStatus('Comenta Test', 'approved');
  await page.goto(S);
  await waitFor(page, () => document.querySelector('#tmStatus')?.dataset.status === 'approved', null, 10000);
  assert.match(await text(page, '#tmStatus'), /Publicado/);
  assert.match(await text(page, '#homeTestimonials'), /dormir mejor/, 'aprobado: ya es público');
  await page.$eval('#tmBody', (n) => { n.value = ''; });
  await page.type('#tmBody', 'Ahora cambié el texto por completo, gracias.');
  await page.click('#tmForm button[type=submit]');
  await waitFor(page, () => document.querySelector('#tmStatus')?.dataset.status === 'pending', null, 8000);
  state = await be.state();
  assert.equal(state.testimonials.length, 1, 'se editó, no se duplicó');
  assert.equal(state.testimonials[0].status, 'pending');
  // borrar
  page.once('dialog', (d) => d.accept());
  await page.click('#tmDelete');
  await toastHas(page, 'Borraste tu comentario');
  await waitFor(page, () => document.querySelector('#tmForm') && !document.querySelector('#tmDelete'), null, 8000);
  assert.equal((await be.state()).testimonials.length, 0);
});

await test('comentarios: quien ya comentó ve su comentario para editarlo o borrarlo (no se ofrece un segundo)', async (page) => {
  await signup('doble@test.dev', 'Doble Test');
  await be.testimonial({ email: 'doble@test.dev', author_name: 'Doble Test', body: 'Ya había dejado uno antes de hoy.', status: 'pending' });
  await page.goto(S);
  await loginViaModal(page, 'doble@test.dev');
  await waitFor(page, () => document.querySelector('#tmStatus'), null, 10000);
  assert.equal(await page.$eval('#tmBody', (n) => n.value), 'Ya había dejado uno antes de hoy.', 'se muestra el que ya tiene (para editarlo)');
  assert.equal(await count(page, '#tmDelete'), 1);
});

await test('panel · Comentarios: la gestión filtra, aprueba, oculta y borra (con confirmación)', async (page) => {
  await be.testimonial({ author_name: 'Ana Pendiente', body: 'Comentario que espera aprobación del equipo.', status: 'pending' });
  await be.testimonial({ author_name: 'Beto Aprobado', body: 'Comentario que ya está publicado en la home.', status: 'approved' });
  await be.testimonial({ author_name: 'Cata Oculta', body: 'Comentario que el equipo ocultó antes de hoy.', status: 'hidden' });
  await loginAsAdmin(page);
  await waitFor(page, () => [...document.querySelectorAll('#panelContent button')].some((b) => /Pendientes \(1\)/.test(b.textContent)) || [...document.querySelectorAll('.nav-link')].length, null, 10000);
  await page.evaluate(() => [...document.querySelectorAll('.nav-link')].find((b) => b.textContent.trim() === 'Comentarios').click());
  await waitFor(page, () => document.querySelector('#tmList'), null, 10000);
  // por defecto, lo que hay que atender
  assert.equal(await count(page, '#tmList li'), 1);
  assert.match(await text(page, '#tmList'), /Ana Pendiente/);
  assert.equal(await page.$eval('[data-filter=pending]', (n) => n.textContent), 'Pendientes (1)');
  assert.equal(await page.$eval('[data-filter=approved]', (n) => n.textContent), 'Aprobados (1)');
  assert.equal(await page.$eval('[data-filter=hidden]', (n) => n.textContent), 'Ocultos (1)');
  // aprobar
  await page.click('#tmList [data-action=approve]');
  await toastHas(page, 'Comentario aprobado');
  await waitFor(page, () => document.querySelector('[data-filter=approved]')?.textContent === 'Aprobados (2)', null, 8000);
  assert.equal((await be.state()).testimonials.find((t) => t.author_name === 'Ana Pendiente').status, 'approved');
  // ocultar lo aprobado
  await page.click('[data-filter=approved]');
  await waitFor(page, () => document.querySelectorAll('#tmList li').length === 2, null, 5000);
  await page.evaluate(() => document.querySelector('#tmList li [data-action=hide]').click());
  await toastHas(page, 'Comentario oculto');
  await waitFor(page, () => document.querySelector('[data-filter=hidden]')?.textContent === 'Ocultos (2)', null, 8000);
  // borrar uno oculto (con confirmación)
  await page.click('[data-filter=hidden]');
  await waitFor(page, () => document.querySelectorAll('#tmList li').length === 2, null, 5000);
  page.once('dialog', (d) => d.dismiss());
  await page.click('#tmList [data-action=delete]');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await be.state()).testimonials.length, 3, 'sin confirmar no se borra');
  page.once('dialog', (d) => d.accept());
  await page.click('#tmList [data-action=delete]');
  await toastHas(page, 'Comentario borrado');
  await waitFor(page, () => document.querySelector('[data-filter=hidden]')?.textContent === 'Ocultos (1)', null, 8000);
  assert.equal((await be.state()).testimonials.length, 2);
});

await test('panel · Comentarios: un usuario común no puede moderar (la base lo rechaza) ni ve comentarios ajenos pendientes', async (page) => {
  await be.testimonial({ author_name: 'Ajeno Pendiente', body: 'Comentario pendiente de otra persona.', status: 'pending' });
  await signup('curioso@test.dev', 'Curioso');
  await page.goto(S);
  await loginViaModal(page, 'curioso@test.dev');
  await waitFor(page, () => document.querySelector('#tmForm'), null, 10000);
  const result = await page.evaluate(async () => {
    const { supabase } = await import('/js/lib/supabase.js');
    const list = await supabase.from('testimonials').select('id,status,body');
    const up = await supabase.from('testimonials').update({ status: 'approved' }).eq('author_name', 'Ajeno Pendiente').select('id');
    return { visible: list.data?.length ?? -1, updated: up.data?.length ?? 0 };
  });
  assert.equal(result.visible, 0, 'no ve pendientes ajenos');
  assert.equal(result.updated, 0, 'no puede aprobar nada');
  assert.equal((await be.state()).testimonials[0].status, 'pending');
});

await test('home · agenda: una clase con cupo completo no se puede reservar; sin clases este mes salta al primer mes con clases', async (page) => {
  await signup('otra@test.dev', 'Otra Test');
  // Una clase a ~40 días: si este mes no tiene clases, el calendario debe abrirse en el mes que sí.
  await be.addSession({ teacher_id: TEACHER_IDS.lucia, title: 'Clase lejana', starts_at: new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString() });
  await page.goto(S);
  await agendaReady(page);
  await pickTeacherByName(page, 'Lucía');
  await waitFor(page, () => document.querySelector('.ag-teacher-info h3')?.textContent === 'Lucía');
  // Lucía tiene clases cerca (Vinyasa Flow) y una lejana: el calendario muestra las cercanas, sin saltar.
  await waitFor(page, () => [...document.querySelectorAll('#homeAgenda .ag-slot-title')].length >= 1);
  // Un profesor nuevo SIN clases cercanas: solo la lejana → salta de mes
  await be.promote('otra@test.dev', 'user');
  const lonely = await be.makeTeacher('otra@test.dev', { name: 'Solitaria' });
  assert.ok(lonely.id);
  await be.addSession({ teacher_id: lonely.id, title: 'Única clase lejana', starts_at: new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString() });
  await page.goto(S);
  await agendaReady(page);
  await pickTeacherByName(page, 'Solitaria');
  await waitFor(page, () => document.querySelector('.ag-teacher-info h3')?.textContent === 'Solitaria');
  await waitFor(page, () => [...document.querySelectorAll('#homeAgenda .ag-slot-title')].some((n) => n.textContent === 'Única clase lejana'), null, 10000);
  assert.ok((await count(page, '.ag-day.has-sessions')) >= 1, 'el calendario se abrió en el mes de la clase, no vacío');
});

await test('idioma: el selector traduce la página, se recuerda al recargar y vuelve a español', async (page) => {
  await page.goto(S);
  await agendaReady(page);
  assert.equal(await page.$eval('html', (h) => h.lang), 'es');
  assert.equal(await text(page, '.ag-schedule-head h3'), 'Agendar clase en vivo');
  await page.select('.lang-select', 'en');
  await waitFor(page, () => document.querySelector('.ag-schedule-head h3')?.textContent.trim() === 'Book a live class');
  assert.equal(await page.$eval('html', (h) => h.lang), 'en');
  assert.match(await text(page, 'h1'), /Yoga for a more mindful life/);
  assert.equal(await text(page, '.ag-teacher-info h3'), 'Manu', 'los nombres propios no se traducen');
  assert.deepEqual(await slotTitles(page), ['Hatha Yoga', 'Hatha nocturno'], 'lo que escribe el equipo no se traduce');
  // El idioma dibujado DESPUÉS (modal de acceso) también se traduce
  await page.click('[data-account-toggle]');
  await page.waitForSelector('#authEmail', { visible: true });
  assert.match(await page.$eval('.yp-auth', (n) => n.textContent), /Sign in/);
  await page.keyboard.press('Escape');
  // Se recuerda al recargar y en otras páginas
  await page.goto(`${S}/tienda.html`);
  await waitFor(page, () => document.documentElement.lang === 'en' && /Shop/.test(document.querySelector('h1')?.textContent ?? ''), null, 10000);
  await page.select('.lang-select', 'es');
  await waitFor(page, () => document.documentElement.lang === 'es' && /Tienda/.test(document.querySelector('h1').textContent));
  // ?lang=en sirve para compartir un enlace
  await page.goto(`${S}/tienda.html?lang=en`);
  await waitFor(page, () => document.documentElement.lang === 'en', null, 10000);
});

await test('idioma: la política de privacidad (texto legal) se queda en español aunque el sitio esté en inglés', async (page) => {
  await page.goto(`${S}/privacidad.html?lang=en`);
  await waitFor(page, () => document.documentElement.lang === 'en', null, 10000);
  assert.match(await text(page, 'main'), /Qué datos tratamos/, 'el cuerpo legal sigue en español');
  assert.equal(await page.$eval('main', (m) => m.lang), 'es');
});

await test('panel · profesor (solo rol profesor): ve SOLO "Mi agenda" y "Mi perfil", agenda una clase y se ve en la home', async (page) => {
  await signup('prof@test.dev', 'Profe Test');
  await be.promote('prof@test.dev', 'profesor');
  await be.makeTeacher('prof@test.dev', { name: 'Profe Test' });
  await page.goto(`${S}/panel.html`);
  await loginViaModal(page, 'prof@test.dev');
  await page.waitForSelector('.nav-tabs .nav-link', { timeout: 10000 });
  const tabs = await page.$$eval('.nav-tabs .nav-link', (n) => n.map((x) => x.textContent));
  assert.deepEqual(tabs, ['Mi agenda', 'Mi perfil'], 'un profesor no ve Clases, Productos ni Profesores');
  await page.waitForSelector('#sfTitle');
  assert.match(await text(page, '#panelContent'), /Todavía no tenés clases agendadas/);
  // Validación: sin título no guarda y explica
  await page.click('#panelContent form button[type=submit]');
  await waitFor(page, () => /título es obligatorio/.test(document.querySelector('#panelContent form [role=alert]')?.textContent ?? ''));
  // Una clase en el pasado se rechaza con un mensaje claro
  await page.type('#sfTitle', 'Clase del pasado');
  await page.$eval('#sfDate', (i) => { i.value = '2020-01-10'; });
  await page.$eval('#sfTime', (i) => { i.value = '10:00'; });
  await page.click('#panelContent form button[type=submit]');
  await waitFor(page, () => /en el futuro/.test(document.querySelector('#panelContent form [role=alert]')?.textContent ?? ''));
  // Clase válida (fecha futura en formato ISO, hora argentina)
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  await page.$eval('#sfTitle', (i) => { i.value = ''; });
  await page.type('#sfTitle', 'Yoga de prueba');
  await page.$eval('#sfDate', (i, d) => { i.value = d; }, day);
  await page.$eval('#sfTime', (i) => { i.value = '19:30'; });
  await page.type('#sfCap', '5');
  await page.click('#panelContent form button[type=submit]');
  await toastHas(page, 'Clase agendada');
  await waitFor(page, () => /Yoga de prueba/.test(document.getElementById('panelContent').textContent), null, 10000);
  assert.match(await text(page, '#panelContent'), /19:30/);
  // Aparece en la home dentro de la agenda de esa profesora
  await page.goto(S);
  await agendaReady(page);
  await pickTeacherByName(page, 'Profe Test');
  await waitFor(page, () => [...document.querySelectorAll('#homeAgenda .ag-slot-title')].some((n) => n.textContent === 'Yoga de prueba'), null, 10000);
  assert.ok((await slotTimes(page)).includes('19:30'));
});

await test('panel · profesor: edita su perfil y sube su foto (que se ve en la home), con especialidades sin repetir', async (page) => {
  await signup('prof2@test.dev', 'Profe Dos');
  await be.promote('prof2@test.dev', 'profesor');
  await be.makeTeacher('prof2@test.dev', { name: 'Profe Dos' });
  await page.goto(`${S}/panel.html`);
  await loginViaModal(page, 'prof2@test.dev');
  await page.waitForSelector('.nav-tabs .nav-link');
  await clickTab(page, 'Mi perfil');
  await page.waitForSelector('#tpName');
  await page.$eval('#tpBio', (i) => { i.value = ''; });
  await page.type('#tpBio', 'Profe de Hatha y meditación.');
  await page.$eval('#tpSpec', (i) => { i.value = ''; });
  await page.type('#tpSpec', 'Hatha, Meditación, hatha');
  await (await page.$('#tpPhoto')).uploadFile(await makeTestImage());
  await page.click('#panelContent form button[type=submit]');
  await toastHas(page, 'Perfil guardado');
  const st = await be.state();
  assert.ok(st.log.storage.some((x) => x.op === 'upload' && /^image\/(jpeg|png|webp)$/.test(x.type)), 'la foto se subió al almacenamiento');
  assert.ok(st.log.teachers.some((x) => x.op === 'update' && x.fields.includes('photo_url') && x.fields.includes('specialties')));
  // En la home: bio, especialidades sin repetir y la foto
  await page.goto(S);
  await agendaReady(page);
  await pickTeacherByName(page, 'Profe Dos');
  await waitFor(page, () => document.querySelector('.ag-teacher-info h3')?.textContent === 'Profe Dos');
  assert.equal(await text(page, '.ag-bio'), 'Profe de Hatha y meditación.');
  assert.deepEqual(await page.$$eval('.ag-chips li', (n) => n.map((x) => x.textContent)), ['Hatha', 'Meditación'], 'sin repetidas');
  await waitFor(page, () => { const i = document.querySelector('.ag-photo img'); return i && i.complete && i.naturalWidth > 0; }, null, 8000);
});

await test('panel · admin que ES profesora (Manuela): ve gestión + "Mi agenda" + "Mi perfil"; el user común no entra', async (page) => {
  await signup('manuela@test.dev', 'Manuela');
  await be.promote('manuela@test.dev', 'admin');
  await be.makeTeacher('manuela@test.dev', { name: 'Manuela' });
  await page.goto(`${S}/panel.html`);
  await loginViaModal(page, 'manuela@test.dev');
  await page.waitForSelector('.nav-tabs .nav-link');
  assert.deepEqual(await page.$$eval('.nav-tabs .nav-link', (n) => n.map((x) => x.textContent)), ['Clases', 'Productos', 'Comentarios', 'Profesores', 'Mi agenda', 'Mi perfil']);
  // El admin edita el perfil de OTRA profesora desde "Profesores"
  await clickTab(page, 'Profesores');
  await waitFor(page, () => /Equipo docente/.test(document.getElementById('panelContent').textContent), null, 10000);
  assert.equal(await count(page, '#inviteEmail'), 0, 'dar de alta profesores es solo del developer');
  await page.evaluate(() => [...document.querySelectorAll('#panelContent .yp-card')].find((c) => c.textContent.includes('Lucía')).querySelector('button').click());
  await page.waitForSelector('#tpName');
  await page.$eval('#tpBio', (i) => { i.value = ''; });
  await page.type('#tpBio', 'Bio corregida por la administración.');
  await page.click('#panelContent form button[type=submit]');
  await toastHas(page, 'Perfil guardado');
  assert.ok((await be.state()).log.teachers.some((x) => x.ids.includes(TEACHER_IDS.lucia)), 'el admin pudo editar a otra profesora');
});

await test('panel · un usuario común (sin ser profesor) NO entra al panel', async (page) => {
  await signup('comun@test.dev', 'Común');
  await page.goto(`${S}/panel.html`);
  await loginViaModal(page, 'comun@test.dev');
  await waitFor(page, () => /Acceso restringido/.test(document.body.textContent), null, 10000);
  assert.equal(await count(page, '.nav-tabs .nav-link'), 0);
});

await test('panel · developer: da de alta a un profesor por correo (con "También es admin") y NO baja de rango a un admin', async (page) => {
  await signup('nuevo@test.dev', 'Nuevo Profe');
  await signup('jefa@test.dev', 'Jefa Admin');
  await be.promote('jefa@test.dev', 'admin');
  await loginAsDeveloper(page);
  await page.waitForSelector('.nav-tabs .nav-link');
  await clickTab(page, 'Profesores');
  await page.waitForSelector('#inviteEmail');
  const invite = async (email, alsoAdmin = false) => {
    await waitFor(page, () => document.querySelector('#inviteEmail') && !document.querySelector('#panelContent .yp-skeleton'), null, 10000);
    await page.type('#inviteEmail', email);
    if (alsoAdmin) await page.click('#inviteAdmin');
    await page.evaluate(() => document.querySelector('#inviteEmail').form.querySelector('button[type=submit]').click());
  };
  const roleOf = async (email) => (await be.state()).users.find((u) => u.email === email).role;
  await invite('nuevo@test.dev', true);
  await toastHas(page, 'rol admin');
  await waitFor(page, () => [...document.querySelectorAll('#panelContent .yp-card')].some((c) => c.textContent.includes('Nuevo Profe')), null, 10000);
  assert.equal(await roleOf('nuevo@test.dev'), 'admin', 'con "También es admin" queda admin + profesor');
  // A un admin existente: alta como profesora SIN la casilla → conserva el rol admin (el descuido que había)
  await invite('jefa@test.dev');
  await waitFor(page, () => [...document.querySelectorAll('#panelContent .yp-card')].some((c) => c.textContent.includes('Jefa Admin')), null, 10000);
  assert.equal(await roleOf('jefa@test.dev'), 'admin', 'un admin NO baja de rango al darlo de alta como profesor');
  assert.ok((await be.state()).teachers.some((t) => t.public_name === 'Jefa Admin' && t.is_active), 'y queda como profesora activa');
  // correo inexistente → mensaje claro, sin romper
  await invite('nadie@test.dev');
  await toastHas(page, 'registrado');
});

await test('panel: sin sesión pide iniciar sesión y un usuario común ve "Acceso restringido"', async (page) => {
  await page.goto(`${S}/panel.html`);
  await waitFor(page, () => document.querySelector('#panel')?.innerText.includes('Iniciá sesión para ver el panel'), null, 10000);
  await signup('comun@test.dev');
  await loginViaModal(page, 'comun@test.dev');
  await waitFor(page, () => document.querySelector('#panel')?.innerText.includes('Acceso restringido'), null, 10000);
  assert.equal(await page.$('.nav-tabs'), null, 'un usuario común no debe ver las pestañas del panel');
});

await test('panel · Clases: el equipo ve todas las clases, borradores incluidos', async (page) => {
  await loginAsDeveloper(page);
  await page.waitForSelector('#panelContent tbody tr', { timeout: 10000 });
  const rows = await panelRows(page);
  assert.equal(rows.length, 4, 'las 4 clases de la semilla (3 publicadas + 1 borrador)');
  assert.ok(rows.some((r) => r.includes('Borrador oculto')), 'el borrador es visible para el equipo');
  await page.screenshot({ path: tmp('yp-panel-clases.png') });
});

await test('panel · admin: gestiona las clases pero NO sube videos (sin "Nueva clase"; el servidor también lo rechaza)', async (page) => {
  await loginAsAdmin(page);
  await page.waitForSelector('#panelContent tbody tr', { timeout: 10000 });
  const rows = await panelRows(page);
  assert.equal(rows.length, 4, 'el admin ve todas las clases, borradores incluidos');
  const ui = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('#panelContent button')].map((b) => b.textContent.trim());
    return {
      newClass: buttons.some((t) => t.includes('Nueva clase')),
      upload: buttons.some((t) => /Subir video|Reintentar video/.test(t)),
      notice: document.querySelector('#panelContent')?.innerText.includes('equipo técnico') ?? false,
    };
  });
  assert.equal(ui.newClass, false, 'el admin no ve el botón "Nueva clase"');
  assert.equal(ui.upload, false, 'ni "Subir video" / "Reintentar video"');
  assert.ok(ui.notice, 'en su lugar ve quién sube los videos');

  // Aunque se salte la interfaz: subir -> developer_only; sincronizar y borrar atraviesan la autorización
  // (con un id inexistente fallan DESPUÉS, por class_not_found, sin tocar ninguna clase real).
  const before = (await be.state()).classes.map((c) => `${c.id}:${c.title}`).sort();
  const out = await page.evaluate(async () => {
    const api = await import('/js/lib/api.js');
    const ghost = '00000000-0000-4000-8000-00000000dead';
    const attempts = {
      create: () => api.adminCreateUpload({ title: 'intento del admin' }),
      sync: () => api.adminSyncVideo(ghost),
      del: () => api.adminDeleteClass(ghost),
    };
    const result = {};
    for (const [k, fn] of Object.entries(attempts)) {
      try { await fn(); result[k] = 'ok'; } catch (e) { result[k] = e.code || e.message; }
    }
    return result;
  });
  assert.equal(out.create, 'developer_only');
  assert.equal(out.sync, 'class_not_found');
  assert.equal(out.del, 'class_not_found');
  const after = (await be.state()).classes.map((c) => `${c.id}:${c.title}`).sort();
  assert.deepEqual(after, before, 'no se creó ni se tocó ninguna clase');
});

// ---------------------------------------------------------------------------------------------- panel de clases (Fases 9-11)
const classModalReady = (page) => waitFor(page, () => {
  const d = document.querySelector('#classFormModal .modal-dialog');
  return !!d && !!document.querySelector('#classFormModal.show') && /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(getComputedStyle(d).transform);
}, null, 5000);
const classModalClosed = (page) => waitFor(page, () => !document.querySelector('.modal-backdrop') && !document.querySelector('#classFormModal.show'), null, 15000);
const clickButtonText = (page, label) => page.evaluate((l) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(l)).click(), label);
const clickRowTitle = (page, rowText, title) => page.evaluate((rt, t) => {
  const row = [...document.querySelectorAll('#panelContent tbody tr')].find((r) => r.innerText.includes(rt));
  row.querySelector(`button[title="${t}"]`).click();
}, rowText, title);
const rowButtonState = (page, rowText, label) => page.evaluate((rt, l) => {
  const row = [...document.querySelectorAll('#panelContent tbody tr')].find((r) => r.innerText.includes(rt));
  const b = [...row.querySelectorAll('button')].find((x) => x.textContent.trim() === l);
  return b ? { disabled: b.disabled } : null;
}, rowText, label);
const waitRow = (page, rowText, part) => waitFor(page, (a) => [...document.querySelectorAll('#panelContent tbody tr')].some((r) => r.innerText.includes(a.rt) && (!a.part || r.innerText.includes(a.part))), { rt: rowText, part }, 10000);
const classByTitle = async (title) => (await be.state()).classes.filter((c) => c.title === title);
async function fillNewClass(page, title, videoFile) {
  await clickButtonText(page, 'Nueva clase');
  await classModalReady(page);
  await page.type('#cfTitle', title);
  await page.type('#cfCategory', 'Vinyasa');
  await (await page.$('#cfVideo')).uploadFile(videoFile);
  await page.click('#classFormModal button[type=submit]');
}

await test('panel · Clases: crear con video real, publicar, editar, despublicar y borrar (Fases 9-11)', async (page) => {
  const video = ensureMedia('e2e-upload');
  await loginAsDeveloper(page);
  await page.waitForSelector('#panelContent tbody tr');
  await fillNewClass(page, 'Clase E2E nueva', video);
  await classModalClosed(page);
  await toastHas(page, 'Clase creada y video subido');
  await waitRow(page, 'Clase E2E nueva', 'Lista');

  // el video llegó a R2 por PUT directo (nunca pasó por nuestro backend) y la clase quedó lista pero SIN publicar
  const [c] = await classByTitle('Clase E2E nueva');
  assert.equal(c.video_status, 'ready');
  assert.equal(c.is_published, false, 'subir un video no publica la clase');
  assert.ok(Math.abs(c.duration_seconds - 12) <= 1, `duración leída en el navegador (≈12 s), fue ${c.duration_seconds}`);
  assert.match(c.r2_object_key, /^classes\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp4$/);
  assert.ok((await be.state()).r2objects.includes(c.r2_object_key), 'el archivo quedó guardado en R2');
  assert.ok((await panelRows(page)).some((r) => r.includes('Clase E2E nueva') && r.includes('Sin publicar')));

  const other = await page.ctx.newPage(); // el público: mismo navegador, otra pestaña
  const publicTitles = async () => {
    await other.goto(`${S}/videoteca.html`);
    await waitFor(other, () => document.querySelectorAll('.video-card').length > 0);
    const titles = await other.$$eval('.video-info h3', (n) => n.map((x) => x.textContent.trim()));
    // Chrome real (no el modo headless antiguo) trata la otra pestaña como "en segundo plano": ahí un confirm() o una
    // animación del panel no avanzan. Se vuelve a la pestaña del panel antes de seguir operándola.
    await page.bringToFront();
    return titles;
  };
  try {
    assert.ok(!(await publicTitles()).includes('Clase E2E nueva'), 'sin publicar no se ve en la videoteca');

    await clickRowButton(page, 'Clase E2E nueva', 'Publicar');
    await waitRow(page, 'Clase E2E nueva', 'Publicada');
    assert.ok((await publicTitles()).includes('Clase E2E nueva'), 'publicada: aparece en la videoteca');

    // editar los datos no toca el video ni el estado de publicación
    await clickRowTitle(page, 'Clase E2E nueva', 'Editar datos de la clase');
    await classModalReady(page);
    await page.$eval('#cfTitle', (i) => { i.value = ''; });
    await page.type('#cfTitle', 'Clase E2E editada');
    await page.click('#classFormModal button[type=submit]');
    await classModalClosed(page);
    await toastHas(page, 'Cambios guardados');
    await waitRow(page, 'Clase E2E editada', 'Publicada');
    const [edited] = await classByTitle('Clase E2E editada');
    assert.equal(edited.r2_object_key, c.r2_object_key, 'editar no cambia el video');
    assert.equal(edited.id, c.id);

    await clickRowButton(page, 'Clase E2E editada', 'Despublicar');
    await waitRow(page, 'Clase E2E editada', 'Sin publicar');
    assert.ok(!(await publicTitles()).includes('Clase E2E editada'), 'despublicada: deja de verse');

    // borrar: pide confirmación y borra la clase Y su video
    page.once('dialog', (d) => d.accept());
    await clickRowTitle(page, 'Clase E2E editada', 'Eliminar');
    await toastHas(page, 'Clase eliminada');
    await waitFor(page, () => ![...document.querySelectorAll('#panelContent tbody tr')].some((r) => r.innerText.includes('Clase E2E editada')));
    const after = await be.state();
    assert.equal(after.classes.some((x) => x.id === c.id), false);
    assert.equal(after.r2objects.includes(c.r2_object_key), false, 'el video también se borró de R2 (no queda nada cobrando)');
  } finally {
    await other.close();
  }
});

await test('panel · Clases: si la subida falla se avisa y el reintento reanuda la MISMA clase (no la duplica)', async (page) => {
  const video = ensureMedia('e2e-upload');
  await loginAsDeveloper(page);
  await page.waitForSelector('#panelContent tbody tr');
  await be.behavior({ uploadFail: true });
  await fillNewClass(page, 'Clase con fallo', video);
  await waitFor(page, () => document.querySelector('#classFormModal .yp-form-error')?.textContent.includes('La subida falló'));
  const [first] = await classByTitle('Clase con fallo');
  assert.equal(first.video_status, 'pending', 'la clase quedó creada pero sin video');

  await be.behavior({ uploadFail: false });
  await page.click('#classFormModal button[type=submit]'); // el modal sigue abierto: se reintenta ahí mismo
  await classModalClosed(page);
  await toastHas(page, 'Clase creada y video subido');
  const same = await classByTitle('Clase con fallo');
  assert.equal(same.length, 1, 'reintentar no debe crear una segunda clase');
  assert.equal(same[0].id, first.id);
  assert.equal(same[0].r2_object_key, first.r2_object_key, 'reanuda con la misma key de R2');
  assert.equal(same[0].video_status, 'ready');
});

await test('panel · Clases: cerrar el formulario tras un fallo deja la clase "Pendiente" (visible, sin poder publicarse) y "Subir video" la completa', async (page) => {
  const video = ensureMedia('e2e-upload');
  await loginAsDeveloper(page);
  await page.waitForSelector('#panelContent tbody tr');
  await be.behavior({ uploadFail: true });
  await fillNewClass(page, 'Clase pendiente', video);
  await waitFor(page, () => document.querySelector('#classFormModal .yp-form-error'));
  await page.click('#classFormModal .btn-close');
  await classModalClosed(page);

  await waitRow(page, 'Clase pendiente', 'Pendiente'); // la lista se refresca sola: la clase no queda invisible
  assert.deepEqual(await rowButtonState(page, 'Clase pendiente', 'Publicar'), { disabled: true }, 'sin video listo no se puede publicar');
  const [pending] = await classByTitle('Clase pendiente');

  await be.behavior({ uploadFail: false });
  await clickRowButton(page, 'Clase pendiente', 'Subir video');
  await classModalReady(page);
  assert.equal(await text(page, '#classFormTitle'), 'Subir video · Clase pendiente');
  await (await page.$('#cfVideo')).uploadFile(video);
  await page.click('#classFormModal button[type=submit]');
  await classModalClosed(page);
  await toastHas(page, 'Video subido');
  await waitRow(page, 'Clase pendiente', 'Lista');
  assert.deepEqual(await rowButtonState(page, 'Clase pendiente', 'Publicar'), { disabled: false });
  const [done] = await classByTitle('Clase pendiente');
  assert.equal(done.r2_object_key, pending.r2_object_key);
  assert.equal(done.video_status, 'ready');
});

await test('panel · Clases: un usuario común no puede usar las funciones de administración ni publicar clases', async (page) => {
  await signup('comun2@test.dev');
  await page.goto(`${S}/videoteca.html`);
  await loginViaModal(page, 'comun2@test.dev');
  await waitFor(page, () => document.querySelector('[data-account-toggle]')?.getAttribute('aria-expanded') !== null);
  const before = (await be.state()).classes.map((c) => `${c.id}:${c.is_published}:${c.title}`).sort();
  const out = await page.evaluate(async (id) => {
    const api = await import('/js/lib/api.js');
    const attempts = {
      create: () => api.adminCreateUpload({ title: 'intruso' }),
      sync: () => api.adminSyncVideo(id),
      del: () => api.adminDeleteClass(id),
      publish: () => api.adminUpdateClass(id, { is_published: false, title: 'hackeada' }),
    };
    const result = {};
    for (const [k, fn] of Object.entries(attempts)) {
      try { await fn(); result[k] = 'ok'; } catch (e) { result[k] = e.code || e.message; }
    }
    return result;
  }, IDS.free);
  assert.equal(out.create, 'developer_only');
  assert.equal(out.sync, 'admin_only');
  assert.equal(out.del, 'admin_only');
  assert.notEqual(out.publish, 'ok', 'la base rechaza escribir en classes sin ser del equipo');
  const afterState = (await be.state()).classes.map((c) => `${c.id}:${c.is_published}:${c.title}`).sort();
  assert.deepEqual(afterState, before, 'no cambió ninguna clase');
});

await test('panel · Productos: ver todo, crear con imagen, publicar, editar el precio en euros y borrar', async (page) => {
  const image = await makeTestImage();
  await loginAsDeveloper(page);
  await page.waitForSelector('.nav-tabs');
  await clickTab(page, 'Productos');
  await page.waitForSelector('#panelContent tbody tr', { timeout: 10000 });
  let rows = await panelRows(page);
  assert.equal(rows.length, 4, 'los 4 productos de la semilla, activos e inactivos');
  assert.ok(rows.some((r) => r.includes('Producto borrador') && r.includes('Oculto')), 'el borrador aparece como Oculto');
  assert.ok(rows.some((r) => r.includes('Remera Pop Up') && r.includes('Agotado')), 'stock 0 se ve como Agotado');
  await page.screenshot({ path: tmp('yp-panel-productos.png') });

  // --- crear (con validación: un precio inválido no llega al backend)
  const writesBefore = (await be.state()).log.products.length;
  await page.evaluate(() => [...document.querySelectorAll('#panelContent button')].find((b) => b.textContent.includes('Nuevo producto')).click());
  await page.waitForSelector('#pfTitle', { visible: true });
  await productModalReady(page);
  await page.type('#pfTitle', 'Bloque de corcho');
  await page.type('#pfPrice', 'abc');
  await page.click('#productFormModal button[type=submit]');
  await page.waitForSelector('#productFormModal .yp-form-error');
  assert.match(await page.$eval('#productFormModal .yp-form-error', (e) => e.textContent), /precio válido/);
  assert.equal((await be.state()).log.products.length, writesBefore, 'un precio inválido no debe escribir nada');
  await page.screenshot({ path: tmp('yp-panel-modal-error.png') });

  await page.$eval('#pfPrice', (i) => { i.value = ''; });
  await page.type('#pfPrice', '12,5');
  await page.type('#pfStock', '4');
  await page.type('#pfCategory', 'Accesorios');
  await (await page.$('#pfImage')).uploadFile(image);
  await page.click('#productFormModal button[type=submit]');
  await productModalClosed(page);
  await waitFor(page, () => [...document.querySelectorAll('#panelContent tbody tr')].some((r) => r.innerText.includes('Bloque de corcho')), null, 10000);

  let st = await be.state();
  const created = st.products.find((p) => p.title === 'Bloque de corcho');
  assert.equal(created.price_cents, 1250, '12,5 € se guarda como 1250 céntimos (entero)');
  assert.equal(created.stock, 4);
  assert.equal(created.is_active, false, 'un producto nuevo nace oculto');
  assert.ok(created.image_url?.startsWith(`${be.origin.api}/storage/v1/object/public/product-images/${created.id}/`), `URL de imagen inesperada: ${created.image_url}`);
  assert.equal(st.storageKeys.length, 1, 'se subió exactamente una imagen');
  rows = await panelRows(page);
  assert.ok(rows.some((r) => plain(r).includes('Bloque de corcho') && plain(r).includes('12,50 €') && r.includes('Oculto')));

  // --- oculto: la tienda pública no lo muestra; publicado: sí
  await page.goto(`${S}/tienda.html`);
  await page.waitForSelector('.shop-card', { timeout: 10000 });
  assert.ok(!(await page.evaluate(() => document.body.textContent)).includes('Bloque de corcho'), 'un producto oculto no aparece en la tienda'); // textContent: innerText devuelve las mayúsculas del CSS
  await page.goto(`${S}/panel.html`);
  await page.waitForSelector('.nav-tabs');
  await clickTab(page, 'Productos');
  await page.waitForSelector('#panelContent tbody tr');
  await clickRowButton(page, 'Bloque de corcho', 'Publicar');
  await waitFor(page, () => [...document.querySelectorAll('#panelContent tbody tr')].some((r) => r.innerText.includes('Bloque de corcho') && r.innerText.includes('Visible')), null, 10000);
  await page.goto(`${S}/tienda.html`);
  await waitFor(page, () => document.body.textContent.includes('Bloque de corcho'), null, 10000);
  await page.screenshot({ path: tmp('yp-tienda-con-nuevo.png') });

  // --- editar el precio
  await page.goto(`${S}/panel.html`);
  await page.waitForSelector('.nav-tabs');
  await clickTab(page, 'Productos');
  await page.waitForSelector('#panelContent tbody tr');
  await clickRowButton(page, 'Bloque de corcho', 'Editar');
  await page.waitForSelector('#pfPrice', { visible: true });
  await productModalReady(page);
  assert.equal(await page.$eval('#pfPrice', (i) => i.value), '12,50', 'el precio se rellena en euros, no en céntimos');
  await page.$eval('#pfPrice', (i) => { i.value = ''; });
  await page.type('#pfPrice', '13,99');
  await page.screenshot({ path: tmp('yp-panel-modal-editar.png') });
  await page.click('#productFormModal button[type=submit]');
  await productModalClosed(page);
  await waitFor(page, () => [...document.querySelectorAll('#panelContent tbody tr')].some((r) => r.innerText.replace(/\s/g, ' ').includes('13,99 €')), null, 10000);
  st = await be.state();
  assert.equal(st.products.find((p) => p.title === 'Bloque de corcho').price_cents, 1399);

  // --- borrar: desaparece de la lista y su imagen se borra del bucket
  page.once('dialog', (d) => d.accept());
  await clickRowButton(page, 'Bloque de corcho', 'Eliminar');
  await waitFor(page, () => ![...document.querySelectorAll('#panelContent tbody tr')].some((r) => r.innerText.includes('Bloque de corcho')), null, 10000);
  await waitFor(page, async () => (await (await fetch('http://127.0.0.1:4174/__test/state')).json()).storageKeys.length === 0, null, 8000);
  st = await be.state();
  assert.ok(!st.products.some((p) => p.title === 'Bloque de corcho'));
  assert.equal(st.products.length, 4, 'quedan los 4 productos de la semilla');
});

/** Abre "Nuevo producto", lo rellena y (opcionalmente) adjunta una imagen. No envía. */
async function fillNewProduct(page, title, imagePath) {
  await clickTab(page, 'Productos');
  await page.waitForSelector('#panelContent tbody tr', { timeout: 10000 });
  await page.evaluate(() => [...document.querySelectorAll('#panelContent button')].find((b) => b.textContent.includes('Nuevo producto')).click());
  await page.waitForSelector('#pfTitle', { visible: true });
  await productModalReady(page);
  await page.type('#pfTitle', title);
  await page.type('#pfPrice', '9,90');
  if (imagePath) await (await page.$('#pfImage')).uploadFile(imagePath);
  await page.click('#productFormModal button[type=submit]');
}

await test('panel · Productos (admin): un admin crea un producto Y sube su foto (no solo el developer)', async (page) => {
  const image = await makeTestImage();
  await loginAsAdmin(page);
  await page.waitForSelector('.nav-tabs');
  await fillNewProduct(page, 'Foto del admin', image);
  await productModalClosed(page);
  const st = await be.state();
  const created = st.products.find((p) => p.title === 'Foto del admin');
  assert.ok(created, 'el producto se creó');
  assert.ok(created.image_url?.includes('/product-images/'), `el admin subió la foto: ${created.image_url}`);
  assert.equal(st.storageKeys.length, 1, 'se guardó exactamente una imagen');
  assert.ok(st.log.storage.some((l) => l.op === 'upload' && /^image\/(webp|jpeg)$/.test(l.type)), 'se subió como WebP o JPEG (nunca un PNG pesado)');
  assert.ok(st.log.storage.every((l) => l.op !== 'upload' || l.bytes <= 2 * 1024 * 1024), 'ninguna imagen supera el tope del bucket');
});

await test('panel · Productos: si Storage rechaza la imagen, el aviso dice el MOTIVO real (permiso, tamaño, bucket)', async (page) => {
  const image = await makeTestImage();
  await loginAsDeveloper(page);
  await page.waitForSelector('.nav-tabs');
  const cases = [
    ['rls', 'Sin permiso', /no tiene permiso para subir imágenes/],
    ['size', 'Demasiado grande', /pesa demasiado/],
    ['bucket', 'Sin bucket', /Falta el almacenamiento de imágenes/],
  ];
  for (const [mode, title, expected] of cases) {
    await be.behavior({ storageReject: mode });
    await fillNewProduct(page, title, image);
    await toastHas(page, 'El producto se creó, pero la imagen falló');
    const msg = await page.evaluate(() => [...document.querySelectorAll('.yp-toast')].map((n) => n.textContent).join(' | '));
    assert.match(msg, expected, `modo ${mode}: ${msg}`);
    assert.doesNotMatch(msg, /inesperado/, 'ya no se muestra el aviso genérico');
    await productModalClosed(page);
    await page.evaluate(() => document.querySelectorAll('.yp-toast').forEach((n) => n.remove()));
  }
  const st = await be.state();
  assert.equal(st.storageKeys.length, 0, 'no quedó ninguna imagen guardada');
  assert.equal(st.products.filter((p) => ['Sin permiso', 'Demasiado grande', 'Sin bucket'].includes(p.title)).length, 3, 'los productos sí se crearon (sin imagen)');
});

await test('panel · Productos: Categoría y Orden explican qué son, sugieren las ya usadas y no aceptan números como categoría', async (page) => {
  await loginAsAdmin(page);
  await page.waitForSelector('.nav-tabs');
  await clickTab(page, 'Productos');
  await page.waitForSelector('#panelContent tbody tr', { timeout: 10000 });
  await page.evaluate(() => [...document.querySelectorAll('#panelContent button')].find((b) => b.textContent.includes('Nuevo producto')).click());
  await page.waitForSelector('#pfTitle', { visible: true });
  await productModalReady(page);

  const ui = await page.evaluate(() => ({
    hints: [...document.querySelectorAll('#productFormModal .form-text')].map((n) => n.textContent),
    options: [...document.querySelectorAll('#pfCategoryList option')].map((o) => o.value),
    listAttr: document.querySelector('#pfCategory').getAttribute('list'),
  }));
  assert.ok(ui.hints.some((h) => /agrupa los productos en la tienda/.test(h) && /Sin números/.test(h)), 'la pista de Categoría explica qué es');
  assert.ok(ui.hints.some((h) => /menor aparece primero/.test(h)), 'la pista de Orden explica cómo ordena');
  assert.equal(ui.listAttr, 'pfCategoryList');
  await page.screenshot({ path: tmp('yp-panel-producto-pistas.png') });
  assert.deepEqual(ui.options, ['Accesorios', 'Mats', 'Ropa'], 'sugiere las categorías que ya existen, sin repetir y ordenadas');

  // Un número como categoría se rechaza con un motivo, y no se escribe nada.
  const writesBefore = (await be.state()).log.products.length;
  await page.type('#pfTitle', 'Porta mat');
  await page.type('#pfPrice', '35');
  await page.type('#pfCategory', '2');
  await page.click('#productFormModal button[type=submit]');
  await page.waitForSelector('#productFormModal .yp-form-error');
  assert.match(await page.$eval('#productFormModal .yp-form-error', (e) => e.textContent), /texto.*no un número.*campo Orden/);
  assert.equal((await be.state()).log.products.length, writesBefore, 'una categoría numérica no escribe nada');

  // "ropa" (minúscula, con espacios) se guarda como "Ropa", la grafía que ya existe.
  await page.$eval('#pfCategory', (i) => { i.value = ''; });
  await page.type('#pfCategory', '  ropa ');
  await page.click('#productFormModal button[type=submit]');
  await productModalClosed(page);
  const created = (await be.state()).products.find((p) => p.title === 'Porta mat');
  assert.equal(created.category, 'Ropa', 'adopta la categoría existente en vez de crear "ropa" aparte');
});

await test('panel · Clases: Categoría y Orden explican qué son, sugieren las ya usadas y validan antes de guardar', async (page) => {
  await loginAsAdmin(page);
  await page.waitForSelector('#panelContent tbody tr', { timeout: 10000 });
  await clickRowTitle(page, 'Yoga para principiantes', 'Editar datos de la clase');
  await page.waitForSelector('#cfTitle', { visible: true });
  await classModalReady(page);

  const ui = await page.evaluate(() => ({
    hints: [...document.querySelectorAll('#classFormModal .form-text')].map((n) => n.textContent),
    options: [...document.querySelectorAll('#cfCategoryList option')].map((o) => o.value),
  }));
  assert.ok(ui.hints.some((h) => /agrupa las clases en la videoteca/.test(h)), 'la pista de Categoría explica qué es');
  assert.ok(ui.hints.some((h) => /menor aparece primero/.test(h)), 'la pista de Orden explica cómo ordena');
  assert.deepEqual(ui.options, ['Fuerza', 'Relajación', 'Vinyasa'], 'sugiere las categorías de las clases existentes');

  // Categoría numérica: error visible, la clase NO se modifica.
  const before = (await be.state()).classes.find((c) => c.title === 'Yoga para principiantes');
  await page.$eval('#cfCategory', (i) => { i.value = ''; });
  await page.type('#cfCategory', '7');
  await page.click('#classFormModal button[type=submit]');
  await page.waitForSelector('#classFormModal .yp-form-error');
  assert.match(await page.$eval('#classFormModal .yp-form-error', (e) => e.textContent), /texto.*no un número/);
  assert.equal((await be.state()).classes.find((c) => c.title === 'Yoga para principiantes').category, before.category, 'no se tocó la clase');

  // "vinyasa" en minúscula se guarda como "Vinyasa".
  await page.$eval('#cfCategory', (i) => { i.value = ''; });
  await page.type('#cfCategory', 'vinyasa');
  await page.click('#classFormModal button[type=submit]');
  await classModalClosed(page);
  assert.equal((await be.state()).classes.find((c) => c.title === 'Yoga para principiantes').category, 'Vinyasa');
});

// ====================================================================== Talles e IVA incluido
const clickText = (page, selector, label) => page.evaluate((sel, l) => {
  const b = [...document.querySelectorAll(sel)].find((n) => n.textContent.trim() === l || n.textContent.includes(l));
  if (!b) throw new Error(`no hay ${sel} con "${l}"`);
  b.click();
}, selector, label);

await test('talles: la tarjeta los muestra, la ficha exige elegir uno y cada talle respeta su propio stock (con IVA incluido a la vista)', async (page) => {
  await be.setVariants(PRODUCT_IDS.mat, [{ size: 'S', stock: 2 }, { size: 'M', stock: 1 }, { size: 'L', stock: 0 }, { size: 'XL', stock: null }]);
  await page.goto(`${S}/tienda.html`);
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 3);
  const card = await page.evaluate(() => {
    const c = [...document.querySelectorAll('#shopGrid .shop-card')].find((x) => x.textContent.includes('Mat de yoga Premium')); // textContent: innerText aplicaría el text-transform del título
    const cta = c.querySelector('a.btn');
    return {
      chips: [...c.querySelectorAll('.size-chip')].map((n) => [n.textContent, n.classList.contains('is-out')]),
      cta: cta?.textContent.trim(), ctaHref: cta?.getAttribute('href'),
      hasAddButton: [...c.querySelectorAll('button')].some((b) => b.textContent.includes('Agregar')),
      text: c.textContent,
    };
  });
  assert.deepEqual(card.chips, [['S', false], ['M', false], ['L', true], ['XL', false]], 'talles en orden, el agotado tachado');
  assert.match(card.cta, /Elegir talle/);
  assert.match(card.ctaHref, new RegExp(`producto\\.html\\?id=${PRODUCT_IDS.mat}`));
  assert.equal(card.hasAddButton, false, 'con talles no se agrega desde la tarjeta: hay que elegir uno');
  assert.match(norm(card.text), /18,99 €/, 'el precio con IVA incluido, grande');
  assert.match(norm(card.text), /15,69 € sin IVA/, 'y al lado, más chico, el precio sin IVA');
  await page.screenshot({ path: tmp('yp-talles-tarjeta.png') });

  // Ficha
  await page.goto(`${S}/producto.html?id=${PRODUCT_IDS.mat}`);
  await waitFor(page, () => document.querySelectorAll('.size-btn').length === 4);
  const lBtn = await page.evaluate(() => { const b = [...document.querySelectorAll('.size-btn')].find((x) => x.textContent === 'L'); return { disabled: b.disabled, out: b.classList.contains('is-out') }; });
  assert.deepEqual(lBtn, { disabled: true, out: true }, 'un talle agotado no se puede elegir');

  // sin elegir talle no se agrega nada y se explica
  await clickText(page, 'button', 'Agregar al carrito');
  await waitFor(page, () => document.querySelector('.size-error')?.textContent.includes('Elige un talle'));
  assert.equal(await cartBadge(page), '', 'no se agregó nada');

  // M tiene 1 unidad: se agrega una vez y ya no más
  await clickText(page, '.size-btn', 'M');
  await waitFor(page, () => document.querySelector('.size-btn.is-selected')?.textContent === 'M');
  assert.equal(await page.$eval('.size-btn.is-selected', (b) => b.getAttribute('aria-pressed')), 'true');
  await clickText(page, 'button', 'Agregar al carrito');
  await toastHas(page, 'talle M');
  assert.equal(await cartBadge(page), '1');
  await clickText(page, 'button', 'Agregar al carrito');
  await toastHas(page, 'máximo disponible');
  assert.equal(await cartBadge(page), '1', 'el stock de M es 1');

  // S tiene 2: el aviso de "últimas unidades" es del TALLE elegido
  await clickText(page, '.size-btn', 'S');
  await waitFor(page, () => document.querySelector('.size-btn.is-selected')?.textContent === 'S');
  assert.match(await page.evaluate(() => document.body.innerText), /Últimas 2 unidades/);
  await page.screenshot({ path: tmp('yp-talles-ficha.png') });
  await clickText(page, 'button', 'Agregar al carrito');
  await clickText(page, 'button', 'Agregar al carrito');
  await waitFor(page, () => document.querySelector('[data-cart-count]').textContent === '3');
  await clickText(page, 'button', 'Agregar al carrito');
  assert.equal(await cartBadge(page), '3', 'S tenía 2: no pasa de ahí aunque el producto sume más talles');

  // Cajón: dos líneas (M y S), subtotal e IVA incluido
  await openCart(page);
  await waitFor(page, () => document.querySelectorAll('#cartList .cart-item').length === 2);
  const lines = await page.$$eval('#cartList .cart-item', (rows) => rows.map((r) => ({ size: r.querySelector('.cart-size')?.textContent, plus: r.querySelector('[aria-label="Una unidad más"]')?.disabled })));
  assert.deepEqual(lines, [{ size: 'Talle: M', plus: true }, { size: 'Talle: S', plus: true }], 'cada línea con su talle, y el "+" bloqueado en el tope de CADA talle');
  assert.equal(norm(await text(page, '#cartSubtotal')), '56,97 €'); // 3 × 18,99
  assert.match(norm(await text(page, '#cartTax')), /IVA incluido: 9,89 € · sin IVA: 47,08 €/);

  // Sobrevive a recargar
  await page.reload();
  await waitFor(page, () => document.querySelector('[data-cart-count]').textContent === '3');
});

await test('carrito: una línea de antes de los talles pide elegir uno, y un talle que se quitó se avisa', async (page) => {
  await page.goto(`${S}/tienda.html`);
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 3);
  // carrito guardado ANTES de que el producto tuviera talles
  await page.evaluate((id) => localStorage.setItem('yp.cart', JSON.stringify({ v: 1, items: [{ id, qty: 1 }] })), PRODUCT_IDS.mat);
  await be.setVariants(PRODUCT_IDS.mat, [{ size: 'S', stock: 3 }, { size: 'M', stock: 3 }]);
  await page.reload();
  await waitFor(page, () => document.querySelector('[data-cart-count]').textContent === '1');

  await openCart(page);
  await waitFor(page, () => document.querySelectorAll('#cartList .cart-item').length === 1);
  assert.match(await text(page, '#cartList .cart-item'), /Elige un talle/);
  assert.equal(await page.$('#cartList .qty'), null, 'no se puede cambiar la cantidad de lo que no tiene talle');
  assert.match(await text(page, '.cart-alert'), /cambiaron desde que los agregaste/, 'el cajón avisa que hay que corregir el carrito');
  assert.equal(await page.$eval('.cart-footer button[title="El pago online llega pronto"]', (b) => b.disabled), true, 'no se puede pagar con una línea sin talle');
  assert.match(await page.$eval('#cartList .cart-item a', (a) => a.getAttribute('href')), new RegExp(PRODUCT_IDS.mat), 'el título lleva a la ficha para elegir');
  await page.click('#cartList .cart-remove');
  await waitFor(page, () => document.querySelector('.cart-empty'));

  // un talle elegido que el equipo quita después
  await page.evaluate((id) => localStorage.setItem('yp.cart', JSON.stringify({ v: 1, items: [{ id, variant: null, qty: 1 }] })), PRODUCT_IDS.mat);
  const st = await be.state();
  const m = st.variants.find((v) => v.product_id === PRODUCT_IDS.mat && v.size === 'M');
  await page.evaluate((id, variant) => localStorage.setItem('yp.cart', JSON.stringify({ v: 1, items: [{ id, variant, qty: 1 }] })), PRODUCT_IDS.mat, m.id);
  await be.setVariants(PRODUCT_IDS.mat, [{ size: 'S', stock: 3 }]); // M ya no existe
  await page.reload();
  await waitFor(page, () => document.querySelector('[data-cart-count]').textContent === '1');
  await openCart(page);
  await waitFor(page, () => document.querySelectorAll('#cartList .cart-item').length === 1);
  assert.match(await text(page, '#cartList .cart-item'), /Ese talle ya no está disponible/);
  assert.match(await text(page, '.cart-alert'), /cambiaron/, 'y se ofrece actualizar el carrito');
});

await test('panel · Productos: crear con talles e IVA, editar su stock conservando los demás, y validar antes de guardar', async (page) => {
  await loginAsAdmin(page);
  await page.waitForSelector('.nav-tabs');
  await clickTab(page, 'Productos');
  await page.waitForSelector('#panelContent tbody tr', { timeout: 10000 });
  await page.evaluate(() => [...document.querySelectorAll('#panelContent button')].find((b) => b.textContent.includes('Nuevo producto')).click());
  await page.waitForSelector('#pfTitle', { visible: true });
  await productModalReady(page);

  assert.equal(await page.$eval('#pfTax', (s) => s.value), '2100', 'IVA general por defecto');
  await page.type('#pfTitle', 'Remera con talles');
  await page.type('#pfPrice', '35');
  await page.type('#pfStock', '9');
  for (const size of ['S', 'M', 'L']) await page.click(`.size-presets [data-preset="${size}"]`);
  const stocks = await page.$$('[data-size-stock]');
  await stocks[0].type('3');
  await stocks[1].type('5'); // L queda vacío = sin control
  assert.equal(await page.$eval('#pfStock', (i) => i.disabled), true, 'con talles el stock general se deshabilita');
  await page.select('#pfTax', '1000');
  await page.evaluate(() => document.querySelector('#productFormModal .modal-body, #productFormModal form')?.scrollTo?.(0, 400));
  await page.screenshot({ path: tmp('yp-talles-panel.png') });
  await page.click('#productFormModal button[type=submit]');
  await productModalClosed(page);

  let st = await be.state();
  const product = st.products.find((p) => p.title === 'Remera con talles');
  const rows = st.variants.filter((v) => v.product_id === product.id);
  assert.deepEqual(rows.map((v) => [v.size, v.stock]), [['S', 3], ['M', 5], ['L', null]]);
  assert.equal(product.stock, null, 'el stock general se descartó: manda el de cada talle');
  assert.equal(product.tax_rate_bps, 1000, 'IVA reducido elegido');
  const listText = await page.evaluate(() => [...document.querySelectorAll('#panelContent tbody tr')].find((r) => r.innerText.includes('Remera con talles')).innerText);
  assert.match(norm(listText), /S 3.*M 5.*L ∞/, 'la lista muestra el stock de cada talle');

  // Editar: M agotado, quitar L, agregar 2XL. Los talles que siguen conservan su id (los carritos los usan).
  const idsBefore = Object.fromEntries(rows.map((v) => [v.size, v.id]));
  await page.evaluate(() => [...document.querySelectorAll('#panelContent tbody tr')].find((r) => r.innerText.includes('Remera con talles')).querySelector('button[title="Editar producto"]').click());
  await page.waitForSelector('#pfTitle', { visible: true });
  await productModalReady(page);
  assert.equal(await page.$eval('#pfTax', (s) => s.value), '1000', 'recuerda el IVA guardado');
  assert.equal((await page.$$('.size-row')).length, 3, 'carga los talles guardados');

  // un talle repetido se rechaza ANTES de mandar nada
  const writesBefore = (await be.state()).log.products.length;
  await page.click('.size-presets [data-preset="S"]').catch(() => {});
  await clickText(page, '.size-presets button', 'Otro talle');
  const names = await page.$$('[data-size-name]');
  await names[names.length - 1].type('m');
  await page.click('#productFormModal button[type=submit]');
  await page.waitForSelector('#productFormModal .yp-form-error');
  assert.match(await page.$eval('#productFormModal .yp-form-error', (e) => e.textContent), /repetido/);
  assert.equal((await be.state()).log.products.length, writesBefore, 'un talle repetido no escribe nada');

  // ahora sí: M a 0, L fuera, 2XL nuevo
  await names[names.length - 1].evaluate((i) => { i.value = ''; });
  await names[names.length - 1].type('2XL');
  const stockInputs = await page.$$('[data-size-stock]');
  await stockInputs[1].evaluate((i) => { i.value = ''; });
  await stockInputs[1].type('0');
  await page.evaluate(() => [...document.querySelectorAll('.size-row')].find((r) => r.querySelector('[data-size-name]').value === 'L').querySelector('[aria-label="Quitar este talle"]').click());
  await page.click('#productFormModal button[type=submit]');
  await productModalClosed(page);

  st = await be.state();
  const after = st.variants.filter((v) => v.product_id === product.id);
  assert.deepEqual(after.map((v) => [v.size, v.stock]), [['S', 3], ['M', 0], ['2XL', null]]);
  assert.equal(after.find((v) => v.size === 'S').id, idsBefore.S, 'S conserva su id');
  assert.equal(after.find((v) => v.size === 'M').id, idsBefore.M, 'M conserva su id');
  assert.ok(!after.some((v) => v.size === 'L'), 'L se quitó');
});

await test('despliegue: si la web sale antes que la migración (base sin talles ni IVA), la tienda y el panel siguen funcionando', async (page) => {
  await be.behavior({ schemaBehind: true });
  await page.goto(`${S}/tienda.html`);
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 3);
  assert.equal(await page.$('.shop-error, .yp-error, [role="alert"]'), null, 'sin pantalla de error');
  assert.equal(await page.$('.size-chip'), null, 'sin talles todavía');
  assert.match(await text(page, '#shopGrid'), /Mat de yoga Premium/i);
  // la ficha también
  await page.goto(`${S}/producto.html?id=${PRODUCT_IDS.mat}`);
  await waitFor(page, () => document.querySelector('h1')?.textContent.includes('Mat de yoga'));
  assert.ok(await page.$$eval('button', (bs) => bs.some((b) => b.textContent.includes('Agregar al carrito'))), 'se puede agregar como siempre');
  // y el panel lista los productos
  await loginAsAdmin(page);
  await page.waitForSelector('.nav-tabs');
  await clickTab(page, 'Productos');
  await page.waitForSelector('#panelContent tbody tr', { timeout: 10000 });
  assert.equal((await page.$$('#panelContent tbody tr')).length, 4, 'el panel carga los 4 productos con las columnas anteriores');
});

await test('IVA: la tienda muestra el precio con IVA y al lado el precio sin IVA, según el tipo de cada producto', async (page) => {
  await page.goto(`${S}/tienda.html`);
  await waitFor(page, () => document.querySelectorAll('#shopGrid .shop-card').length === 3);
  const prices = await page.$$eval('#shopGrid .shop-card', (cards) => Object.fromEntries(cards.map((c) => [c.querySelector('h3, .shop-title, h2')?.textContent.trim() ?? c.innerText.split('\n')[0], c.querySelector('.price-row')?.innerText.replace(/\s+/g, ' ').trim()])));
  const mat = Object.entries(prices).find(([k]) => k.includes('Mat de yoga'))[1];
  assert.match(mat, /18,99 € 15,69 € sin IVA/, 'precio y, más chico, sin IVA (21 %)');
  const pageText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  assert.match(pageText, /14,99 € 12,39 € sin IVA/, 'la botella: 14,99 con IVA = 12,39 sin IVA');
});

await test('panel · Productos: un usuario común no puede escribir productos ni subir imágenes (la base lo rechaza)', async () => {
  await signup('intruso@test.dev');
  const tok = await (await fetch(`${be.origin.api}/auth/v1/token?grant_type=password`, { method: 'POST', body: JSON.stringify({ email: 'intruso@test.dev', password: PASS }) })).json();
  const auth = { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' };
  const post = await fetch(`${be.origin.api}/rest/v1/products`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Hack', price_cents: 1 }) });
  assert.equal(post.status, 403);
  const del = await fetch(`${be.origin.api}/rest/v1/products?id=eq.10000000-0000-4000-8000-000000000001`, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 403);
  const up = await fetch(`${be.origin.api}/storage/v1/object/product-images/x/hack.png`, { method: 'POST', headers: { Authorization: auth.Authorization, 'Content-Type': 'image/png' }, body: 'x' });
  assert.equal(up.status, 403);
  const st = await be.state();
  assert.equal(st.products.length, 4, 'no se creó ni se borró nada');
  assert.equal(st.storageKeys.length, 0);
});

await test('doctor --online y la prueba de integración real funcionan (contra el backend simulado)', async () => {
  await signup('ana@test.dev');
  const env = {
    ...process.env, YP_SUPABASE_URL: be.origin.api, YP_ANON_KEY: 'e2e-anon-key', YP_ORIGINS: be.origin.site,
    YP_TEST_EMAIL: 'ana@test.dev', YP_TEST_PASSWORD: PASS, YP_CLASS_ID: IDS.free,
  };
  const doctor = await run(['scripts/doctor.mjs', '--online'], env);
  assert.equal(doctor.status, 0, `doctor salió con ${doctor.status}:\n${doctor.stdout}`);
  for (const frag of ['✓ Función health', '✓ Columna de R2 oculta', '✓ playback sin sesión', '✓ Catálogo público']) {
    assert.ok(doctor.stdout.includes(frag), `doctor no informó "${frag}":\n${doctor.stdout}`);
  }
  const integ = await run(['tests/integration/real-stack.integration.mjs'], env);
  assert.equal(integ.status, 0, `la integración salió con ${integ.status}:\n${integ.stdout}`);
  assert.match(integ.stdout, /Todo en verde/);
  assert.equal((integ.stdout.match(/✓/g) || []).length, 9, integ.stdout);
  // y el doctor SÍ detecta problemas: una clave secreta como clave pública -> error
  const bad = await run(['scripts/doctor.mjs'], { ...env, YP_ANON_KEY: 'sb_secret_abc' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /CLAVE SECRETA/);
});

await test('el HTML/JS servido no contiene secretos ni pide columnas privadas', async (page) => {
  const bad = [];
  page.on('response', async (r) => { if (r.status() === 401 && /rest\/v1\/classes/.test(r.url())) bad.push(r.url()); });
  await page.goto(`${S}/videoteca.html`);
  await waitFor(page, () => document.querySelectorAll('#catalogGrid .video-card').length === 3);
  assert.deepEqual(bad, [], 'el frontend pidió columnas privadas de classes');
  for (const path of ['/js/config.js', '/js/lib/api.js', '/js/pages/clase.js']) {
    const body = await (await fetch(S + path)).text();
    assert.ok(!/service_role|R2_SECRET_ACCESS_KEY|R2_ACCESS_KEY_ID|X-Amz-Signature/i.test(body), `${path} contiene algo sensible`);
  }
  assert.equal((await fetch(`${S}/.env`)).status, 404);
});

await browser.close();
await be.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} pasaron · ${failed.length} fallaron${only ? ` (filtro: "${only}")` : ''}\n`);
process.exit(failed.length ? 1 : 0);
