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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { IDS, PRODUCT_IDS, startBackend } from './fake-backend.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
    await page.screenshot({ path: `/tmp/e2e-fail-${results.length}.png` }).catch(() => {});
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
  // R2 no transcodifica: un solo archivo, sin selector de calidad (el botón queda oculto).
  assert.equal(await page.$eval('.yp-menuwrap:nth-child(2) .yp-text-btn', (b) => b.hidden), true);
  // velocidad
  await page.click('.yp-menuwrap:nth-child(1) .yp-text-btn');
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
  const file = '/tmp/yp-e2e-producto.png';
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x7fb7a4:s=640x480', '-frames:v', '1', file]);
  assert.equal(r.status, 0, 'ffmpeg debe poder generar una imagen de prueba');
  return file;
}
async function loginAsOwner(page, email = 'duena@test.dev') {
  await signup(email, 'Dueña Test');
  await be.promote(email, 'owner');
  await page.goto(`${S}/panel.html`);
  await loginViaModal(page, email);
}

await test('panel: sin sesión pide iniciar sesión y un usuario común ve "Acceso restringido"', async (page) => {
  await page.goto(`${S}/panel.html`);
  await waitFor(page, () => document.querySelector('#panel')?.innerText.includes('Iniciá sesión para ver el panel'), null, 10000);
  await signup('comun@test.dev');
  await loginViaModal(page, 'comun@test.dev');
  await waitFor(page, () => document.querySelector('#panel')?.innerText.includes('Acceso restringido'), null, 10000);
  assert.equal(await page.$('.nav-tabs'), null, 'un usuario común no debe ver las pestañas del panel');
});

await test('panel · Clases: la propietaria ve todas las clases, borradores incluidos', async (page) => {
  await loginAsOwner(page);
  await page.waitForSelector('#panelContent tbody tr', { timeout: 10000 });
  const rows = await panelRows(page);
  assert.equal(rows.length, 4, 'las 4 clases de la semilla (3 publicadas + 1 borrador)');
  assert.ok(rows.some((r) => r.includes('Borrador oculto')), 'el borrador es visible para la propietaria');
  await page.screenshot({ path: '/tmp/yp-panel-clases.png' });
});

await test('panel · Productos: ver todo, crear con imagen, publicar, editar el precio en euros y borrar', async (page) => {
  const image = await makeTestImage();
  await loginAsOwner(page);
  await page.waitForSelector('.nav-tabs');
  await clickTab(page, 'Productos');
  await page.waitForSelector('#panelContent tbody tr', { timeout: 10000 });
  let rows = await panelRows(page);
  assert.equal(rows.length, 4, 'los 4 productos de la semilla, activos e inactivos');
  assert.ok(rows.some((r) => r.includes('Producto borrador') && r.includes('Oculto')), 'el borrador aparece como Oculto');
  assert.ok(rows.some((r) => r.includes('Remera Pop Up') && r.includes('Agotado')), 'stock 0 se ve como Agotado');
  await page.screenshot({ path: '/tmp/yp-panel-productos.png' });

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
  await page.screenshot({ path: '/tmp/yp-panel-modal-error.png' });

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
  await page.screenshot({ path: '/tmp/yp-tienda-con-nuevo.png' });

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
  await page.screenshot({ path: '/tmp/yp-panel-modal-editar.png' });
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
