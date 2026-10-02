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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { IDS, PRODUCT_IDS, startBackend } from './fake-backend.mjs';
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

const be = await startBackend({ siteRoot: root });
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: process.env.CHROME_HEADLESS_SHELL ? 'shell' : true,
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
    const where = String(err.stack || '').split('\n').find((l) => l.includes('run.mjs'));
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
const cartRows = (page) => count(page, '#cartList .cart-item');
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
    return other.$$eval('.video-info h3', (n) => n.map((x) => x.textContent.trim()));
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
  let created = st.products.find((p) => p.title === 'Bloque de corcho');
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
