/**
 * PRUEBA DE INTEGRACIÓN CONTRA LOS SERVICIOS REALES (Supabase + Cloudflare R2). Se OMITE sola si faltan variables.
 *
 *   YP_SUPABASE_URL=https://xxxx.supabase.co  YP_ANON_KEY=...            (Project Settings → API)
 *   YP_TEST_EMAIL=prueba@tudominio.com  YP_TEST_PASSWORD=...             (una cuenta de prueba YA confirmada)
 *   YP_CLASS_ID=<uuid de una clase gratuita, publicada y con video listo>
 *   npm run test:integration
 *
 * Comprueba lo que ninguna simulación puede: que R2 REAL acepta la URL firmada (SigV4) para el video, que la
 * rechaza sin firma, que soporta Range requests (necesario para buscar/adelantar), y que Supabase REAL guarda
 * el progreso. Además verifica, sin tocar nada que no limpie después: que las tablas privadas (pedidos, pagos, auditoría) no se
 * leen sin sesión, que nadie sin sesión escribe, la agenda pública, una reserva real (se cancela al final) y el circuito de
 * comentarios (queda "pendiente", no es público y no se aprueba solo; se borra al final).
 */
import assert from 'node:assert/strict';

const E = process.env;
const need = ['YP_SUPABASE_URL', 'YP_ANON_KEY', 'YP_TEST_EMAIL', 'YP_TEST_PASSWORD', 'YP_CLASS_ID'];
const missing = need.filter((k) => !E[k]);
if (missing.length) {
  console.log(`OMITIDA · prueba de integración real. Faltan variables: ${missing.join(', ')}`);
  console.log('Ver el encabezado de tests/integration/real-stack.integration.mjs y docs/PUESTA-EN-MARCHA.md');
  process.exit(0);
}

const base = E.YP_SUPABASE_URL.replace(/\/+$/, '');
const fnBase = (E.YP_FUNCTIONS_URL || `${base}/functions/v1`).replace(/\/+$/, '');
const anon = { apikey: E.YP_ANON_KEY, Authorization: `Bearer ${E.YP_ANON_KEY}` };
const json = { 'Content-Type': 'application/json' };
let step = 0;
const check = async (name, fn) => { step++; try { await fn(); console.log(`  ✓ ${step}. ${name}`); } catch (e) { console.log(`  ✗ ${step}. ${name}\n      ${e.message}`); process.exitCode = 1; throw e; } };
const skip = (name, why) => { step++; console.log(`  – ${step}. ${name} (omitida: ${why})`); };
const state = {};
/** Cerrado de verdad: la API lo rechaza (401/403) o, con RLS, devuelve vacío. Un 404 = falta aplicar migraciones. */
const assertClosed = async (r, what) => {
  assert.notEqual(r.status, 404, `${what}: la tabla no existe (¿falta \`npm run sb:db-push\`?)`);
  if ([401, 403].includes(r.status)) return;
  assert.equal(r.status, 200, `${what}: estado ${r.status}`);
  assert.deepEqual(await r.json(), [], `${what}: ¡se leyeron filas sin permiso!`);
};

console.log('\nIntegración real · Supabase + Cloudflare R2\n');
try {
  await check('El catálogo público se lee sin sesión', async () => {
    const r = await fetch(`${base}/rest/v1/classes?select=id,title&is_published=eq.true&limit=5`, { headers: anon });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(await r.json()));
  });

  await check('La key de R2 NO es legible desde el navegador', async () => {
    const r = await fetch(`${base}/rest/v1/classes?select=r2_object_key&limit=1`, { headers: anon });
    assert.ok([401, 403].includes(r.status), `estado ${r.status}: el navegador puede leer r2_object_key`);
  });

  await check('playback sin sesión responde 401', async () => {
    const r = await fetch(`${fnBase}/playback`, { method: 'POST', headers: json, body: JSON.stringify({ class_id: E.YP_CLASS_ID }) });
    assert.equal(r.status, 401);
  });

  await check('Inicio de sesión con la cuenta de prueba', async () => {
    const r = await fetch(`${base}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { ...anon, ...json }, body: JSON.stringify({ email: E.YP_TEST_EMAIL, password: E.YP_TEST_PASSWORD }) });
    assert.equal(r.status, 200, `estado ${r.status} (¿la cuenta existe y está confirmada?)`);
    state.token = (await r.json()).access_token;
    assert.ok(state.token);
  });

  const auth = () => ({ ...json, apikey: E.YP_ANON_KEY, Authorization: `Bearer ${state.token}` });

  await check('playback con sesión devuelve una URL firmada con todos los campos del contrato', async () => {
    const r = await fetch(`${fnBase}/playback`, { method: 'POST', headers: auth(), body: JSON.stringify({ class_id: E.YP_CLASS_ID }) });
    const raw = await r.text(); // se lee UNA vez: el cuerpo no se puede consumir dos veces
    assert.equal(r.status, 200, `estado ${r.status}: ${raw}`);
    const body = JSON.parse(raw);
    assert.deepEqual(Object.keys(body).sort(), ['class_id', 'completed', 'duration_seconds', 'expires_at', 'resume_seconds', 'title', 'video_url']);
    assert.match(body.video_url, /X-Amz-Signature=/);
    assert.ok(body.expires_at > Date.now() / 1000, 'la URL ya vino vencida');
    state.videoUrl = body.video_url;
  });

  await check('R2 acepta la URL firmada: el archivo responde 200', async () => {
    const r = await fetch(state.videoUrl, { method: 'HEAD' });
    assert.equal(r.status, 200, `estado ${r.status}: revisa R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY y el nombre del bucket`);
  });

  await check('R2 soporta Range requests (206, necesario para buscar/adelantar)', async () => {
    const r = await fetch(state.videoUrl, { headers: { Range: 'bytes=0-1023' } });
    assert.equal(r.status, 206, `estado ${r.status}: el reproductor no va a poder buscar dentro del video`);
  });

  await check('Sin firma, R2 rechaza el mismo objeto (403)', async () => {
    const naked = state.videoUrl.split('?')[0];
    assert.notEqual(naked, state.videoUrl);
    const r = await fetch(naked);
    assert.equal(r.status, 403, `estado ${r.status}: ¡el video se puede ver SIN firma! Revisa que el bucket no sea público`);
  });

  await check('El progreso se guarda en Supabase real (save_progress)', async () => {
    const r = await fetch(`${base}/rest/v1/rpc/save_progress`, { method: 'POST', headers: auth(), body: JSON.stringify({ p_class_id: E.YP_CLASS_ID, p_seconds: 7 }) });
    const raw = await r.text();
    assert.equal(r.status, 200, `estado ${r.status}: ${raw}`);
    assert.equal(JSON.parse(raw).progress_seconds, 7);
  });

  // ---------------------------------------------------------------- Seguridad de la base real (sin PayPal)
  await check('Los datos privados (pedidos, pagos, auditoría, reservas ajenas) no se leen sin sesión', async () => {
    for (const table of ['orders', 'order_items', 'subscriptions', 'payment_events', 'audit_log', 'entitlements', 'live_bookings', 'rate_limits', 'profiles']) {
      await assertClosed(await fetch(`${base}/rest/v1/${table}?select=*&limit=1`, { headers: anon }), table);
    }
  });

  await check('Sin sesión no se puede escribir (productos, clases, comentarios, reservas)', async () => {
    const attempts = [
      ['products', { title: 'x', price_cents: 1 }],
      ['classes', { title: 'x' }],
      ['testimonials', { body: 'Intento sin sesión que no debe entrar.' }],
      ['live_bookings', { session_id: '00000000-0000-4000-8000-000000000000' }],
    ];
    for (const [table, body] of attempts) {
      const r = await fetch(`${base}/rest/v1/${table}`, { method: 'POST', headers: { ...anon, ...json }, body: JSON.stringify(body) });
      assert.ok([401, 403].includes(r.status), `${table}: estado ${r.status} (¡se pudo escribir sin sesión!)`);
    }
  });

  await check('La agenda pública responde sin sesión y no expone a los alumnos', async () => {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
    const r = await fetch(`${base}/rest/v1/rpc/live_agenda`, { method: 'POST', headers: { ...anon, ...json }, body: JSON.stringify({ p_teacher: null, p_from: from, p_to: to }) });
    const raw = await r.text();
    assert.equal(r.status, 200, `estado ${r.status}: ${raw}`);
    const rows = JSON.parse(raw);
    assert.ok(Array.isArray(rows));
    for (const row of rows) for (const key of Object.keys(row)) assert.ok(!/email|user_id|attendee|student/i.test(key), `la agenda pública expone "${key}"`);
    state.sessions = rows;
    const t = await fetch(`${base}/rest/v1/teachers?select=public_name,bio,photo_url&limit=5`, { headers: anon });
    assert.equal(t.status, 200, `teachers: estado ${t.status} (¿falta la migración de profesores?)`);
  });

  await check('Las migraciones de pagos y comentarios están aplicadas (las tablas existen para una cuenta común)', async () => {
    for (const table of ['orders', 'subscriptions']) {
      const r = await fetch(`${base}/rest/v1/${table}?select=id&limit=1`, { headers: auth() });
      assert.equal(r.status, 200, `${table}: estado ${r.status} (¿falta \`npm run sb:db-push\`?)`);
      assert.ok(Array.isArray(await r.json()));
    }
    const r = await fetch(`${base}/rest/v1/testimonials?select=id,body&limit=1`, { headers: anon });
    assert.equal(r.status, 200, `testimonials: estado ${r.status} (¿falta aplicar la migración de comentarios?)`);
  });

  const free = (state.sessions ?? []).find((x) => new Date(x.starts_at) > new Date(Date.now() + 60_000) && !x.mine && (x.capacity == null || x.booked < x.capacity));
  if (!free) skip('Reserva real de una clase en vivo (reservar, verla en "Mis clases", cancelar)', 'no hay clases en vivo futuras con lugar; creá una desde el panel y repetí');
  else {
    await check('Reserva real de una clase en vivo: reservar, verla en "Mis clases" y cancelar', async () => {
      const rpc = (name, body) => fetch(`${base}/rest/v1/rpc/${name}`, { method: 'POST', headers: auth(), body: JSON.stringify(body ?? {}) });
      const booked = await rpc('book_live_session', { p_session: free.id });
      assert.equal(booked.status, 200, `reservar: estado ${booked.status}: ${await booked.text()}`);
      try {
        const mine = await (await rpc('my_live_bookings')).json();
        assert.ok(mine.some((b) => (b.session_id ?? b.id) === free.id), 'la reserva no aparece en "Mis clases"');
      } finally {
        const cancelled = await rpc('cancel_live_booking', { p_session: free.id });
        assert.ok([200, 204].includes(cancelled.status), `cancelar: estado ${cancelled.status} (¡quedó una reserva de prueba!)`);
      }
      const after = await (await rpc('my_live_bookings')).json();
      assert.ok(!after.some((b) => (b.session_id ?? b.id) === free.id), 'la reserva sigue después de cancelar');
    });
  }

  const created = await fetch(`${base}/rest/v1/testimonials?select=id,status`, {
    method: 'POST', headers: { ...auth(), Prefer: 'return=representation' },
    body: JSON.stringify({ body: 'Prueba automática de integración: este comentario se borra solo.', rating: 5 }),
  });
  if (created.status === 409) skip('Comentarios: pendiente, no público y no se aprueba solo', 'esta cuenta de prueba ya tiene un comentario (hay uno por persona)');
  else {
    const row = [200, 201].includes(created.status) ? (await created.json())[0] : null;
    try {
      await check('Comentarios: nacen pendientes, no son públicos y la autora no puede aprobarlos', async () => {
        assert.ok([200, 201].includes(created.status), `crear: estado ${created.status}`);
        assert.equal(row.status, 'pending', 'un comentario nuevo tiene que nacer "pendiente"');
        const pub = await fetch(`${base}/rest/v1/testimonials?select=id&id=eq.${row.id}`, { headers: anon });
        assert.deepEqual(await pub.json(), [], '¡un comentario pendiente se ve sin sesión!');
        const col = await fetch(`${base}/rest/v1/testimonials?select=status&limit=1`, { headers: anon });
        assert.ok([401, 403].includes(col.status), `anon puede pedir la columna status (estado ${col.status})`);
        const self = await fetch(`${base}/rest/v1/testimonials?id=eq.${row.id}&select=id,status`, { method: 'PATCH', headers: { ...auth(), Prefer: 'return=representation' }, body: JSON.stringify({ status: 'approved' }) });
        const after = self.status === 200 ? await self.json() : [];
        assert.ok(self.status === 403 || after.length === 0 || after[0].status !== 'approved', '¡la autora aprobó su propio comentario!');
      });
    } finally {
      if (row) await fetch(`${base}/rest/v1/testimonials?id=eq.${row.id}`, { method: 'DELETE', headers: auth() });
    }
  }
} catch { /* el detalle ya se imprimió en check() */ }

console.log(process.exitCode ? '\nHay pasos en rojo.\n' : '\nTodo en verde: la integración real funciona.\n');
process.exit(process.exitCode || 0); // por las dudas: no depender de que undici cierre solo los sockets keep-alive
