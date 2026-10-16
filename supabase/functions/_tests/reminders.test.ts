import assert from "node:assert/strict";
import { createHandler } from "../live-reminders/handler.ts";
import { buildReminderEmail, firstName, runReminders } from "../_shared/reminders/logic.ts";
import { loadRemindersConfig } from "../_shared/reminders/config.ts";
import { MailError, ResendMail } from "../_shared/reminders/mail.resend.ts";
import type {
  MailMessage,
  MailPort,
  ReminderRow,
  RemindersConfig,
  RemindersDeps,
  RemindersRepo,
} from "../_shared/reminders/ports.ts";
import { FakeAudit, FakeAuth, FakeLimiter, FakeRepo, post } from "./fakes.ts";

const CRON = "secreto-largo-del-cron";
const CFG: RemindersConfig = {
  allowedOrigins: ["https://yogapopup.test"],
  cronSecret: CRON,
  timezone: "Europe/Madrid",
  siteUrl: "https://yogapopup.test",
  brandName: "Yoga Pop Up",
  batchLimit: 100,
};

const row = (over: Partial<ReminderRow> = {}): ReminderRow => ({
  booking_id: crypto.randomUUID(),
  user_id: crypto.randomUUID(),
  email: "ana@test.dev",
  display_name: "Ana Pérez",
  session_id: crypto.randomUUID(),
  title: "Vinyasa de la mañana",
  starts_at: "2026-10-15T10:00:00Z", // 12:00 en Madrid (verano)
  duration_minutes: 60,
  mode: "live",
  teacher_name: "Profe Luz",
  ...over,
});

class FakeRemindersRepo implements RemindersRepo {
  pending: ReminderRow[] = [];
  released: string[] = [];
  claimCalls: { tz: string; limit: number }[] = [];
  claim(tz: string, limit: number) {
    this.claimCalls.push({ tz, limit });
    const out = this.pending.splice(0, limit);
    return Promise.resolve(out);
  }
  release(ids: string[]) {
    this.released.push(...ids);
    return Promise.resolve();
  }
}
class FakeMail implements MailPort {
  sent: MailMessage[] = [];
  failFor = new Set<string>();
  send(m: MailMessage) {
    if (this.failFor.has(m.to)) return Promise.reject(new Error("provider down"));
    this.sent.push(m);
    return Promise.resolve();
  }
}

function make(over: Partial<RemindersConfig> = {}, withMail = true) {
  const repo = new FakeRemindersRepo();
  const mail = new FakeMail();
  const audit = new FakeAudit();
  const limiter = new FakeLimiter();
  const deps: RemindersDeps = {
    mail: withMail ? mail : null,
    repo,
    auth: new FakeAuth(new FakeRepo()),
    audit,
    limiter,
    config: { ...CFG, ...over },
  };
  return { deps, repo, mail, audit, limiter };
}

Deno.test("firstName: primer nombre o vacío", () => {
  assert.equal(firstName("Ana Pérez"), "Ana");
  assert.equal(firstName("  Luz "), "Luz");
  assert.equal(firstName(null), "");
  assert.equal(firstName(""), "");
});

Deno.test("buildReminderEmail: hora en la zona del negocio, saludo, enlace a la cuenta y asunto", () => {
  const m = buildReminderEmail(row(), CFG);
  assert.equal(m.to, "ana@test.dev");
  assert.equal(m.subject, "Hoy a las 12:00: Vinyasa de la mañana");
  assert.match(m.text, /^Hola Ana,/);
  assert.match(m.text, /«Vinyasa de la mañana» con Profe Luz/);
  assert.match(m.text, /jueves,? 15 de octubre, a las 12:00 \(60 min\)/);
  assert.match(m.text, /https:\/\/yogapopup\.test\/cuenta\.html/);
  assert.match(m.html, /<a href="https:\/\/yogapopup\.test\/cuenta\.html">tu cuenta<\/a>/);
  // otra zona: la misma clase se ve a otra hora
  assert.match(
    buildReminderEmail(row(), { ...CFG, timezone: "America/Argentina/Buenos_Aires" }).subject,
    /^Hoy a las 07:00/,
  );
});

Deno.test("buildReminderEmail: virtual, sin nombre, sin profesor y sin enlace", () => {
  const m = buildReminderEmail(row({ mode: "virtual", display_name: null, teacher_name: null }), {
    ...CFG,
    siteUrl: null,
  });
  assert.match(m.text, /^Hola,/);
  assert.match(m.text, /tu clase virtual «Vinyasa de la mañana»\./);
  assert.doesNotMatch(m.text, /https?:\/\//);
  assert.doesNotMatch(m.html, /<a /);
});

Deno.test("buildReminderEmail: lo que escribe una persona va escapado en el HTML", () => {
  const m = buildReminderEmail(
    row({
      title: `<img src=x onerror=alert(1)> & "comillas"`,
      display_name: "<b>Eva</b>",
      teacher_name: "<script>x</script>",
    }),
    CFG,
  );
  assert.doesNotMatch(m.html, /<img|<script|<b>Eva/);
  assert.match(m.html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;comillas&quot;/);
});

Deno.test("runReminders: manda un correo por reserva y cuenta sin correo como omitida", async () => {
  const t = make();
  t.repo.pending = [row(), row({ email: "bruno@test.dev", display_name: "Bruno" }), row({ email: null })];
  const s = await runReminders({ repo: t.repo, mail: t.mail, config: t.deps.config });
  assert.deepEqual(s, { claimed: 3, sent: 2, failed: 0, skipped: 1 });
  assert.deepEqual(t.mail.sent.map((m) => m.to), ["ana@test.dev", "bruno@test.dev"]);
  assert.deepEqual(t.repo.released, [], "nada para reintentar");
  assert.deepEqual(t.repo.claimCalls, [{ tz: "Europe/Madrid", limit: 100 }]);
});

Deno.test("runReminders: un correo que falla vuelve a la cola y no frena a los demás", async () => {
  const t = make();
  const a = row({ email: "falla@test.dev" });
  const b = row({ email: "ok@test.dev" });
  t.repo.pending = [a, b];
  t.mail.failFor.add("falla@test.dev");
  const s = await runReminders({ repo: t.repo, mail: t.mail, config: t.deps.config });
  assert.deepEqual(s, { claimed: 2, sent: 1, failed: 1, skipped: 0 });
  assert.deepEqual(t.repo.released, [a.booking_id], "solo la fallida se devuelve para el próximo barrido");
  assert.deepEqual(t.mail.sent.map((m) => m.to), ["ok@test.dev"]);
});

Deno.test("live-reminders: el cron entra con su secreto; sin secreto o con otro, 401/403", async () => {
  const t = make();
  t.repo.pending = [row()];
  const h = createHandler(t.deps);
  const ok = await h(post({}, undefined, { "x-cron-secret": CRON }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { claimed: 1, sent: 1, failed: 0, skipped: 0 });
  assert.equal(t.audit.entries.at(-1)?.action, "live_reminders.run");
  assert.equal(t.audit.entries.at(-1)?.actorId, null, "lo hizo el sistema");
  assert.equal((await h(post({}, undefined, { "x-cron-secret": "otro" }))).status, 401);
  assert.equal((await h(post({}))).status, 401);
  assert.equal(t.mail.sent.length, 1, "los rechazados no mandaron nada");
});

Deno.test("live-reminders: sin cronSecret configurado el cron no entra; el personal sí, una persona común no", async () => {
  const t = make({ cronSecret: null });
  t.repo.pending = [row()];
  const h = createHandler(t.deps);
  assert.equal((await h(post({}, undefined, { "x-cron-secret": CRON }))).status, 401);
  assert.equal((await h(post({}, "user"))).status, 403, "una persona común no dispara avisos");
  const staff = await h(post({}, "admin"));
  assert.equal(staff.status, 200);
  assert.equal(t.audit.entries.at(-1)?.actorId !== null, true, "queda quién lo disparó");
});

Deno.test("live-reminders: sin correo configurado 503 mail_not_configured y no se reclama nada", async () => {
  const t = make({}, false);
  t.repo.pending = [row()];
  const r = await createHandler(t.deps)(post({}, undefined, { "x-cron-secret": CRON }));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, "mail_not_configured");
  assert.equal(t.repo.claimCalls.length, 0, "sin correo no se marcan reservas como avisadas");
  assert.equal(t.repo.pending.length, 1);
});

Deno.test("live-reminders: solo POST y el disparo manual tiene límite de frecuencia", async () => {
  const t = make();
  const h = createHandler(t.deps);
  assert.equal((await h(new Request("https://fn.test/x", { method: "GET" }))).status, 405);
  let last = 200;
  for (let i = 0; i < 8; i++) last = (await h(post({}, "admin"))).status;
  assert.equal(last, 429);
});

Deno.test("ResendMail: manda JSON con la clave en la cabecera y no filtra el cuerpo de error del proveedor", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const ok = new ResendMail(
    { apiKey: "re_123", from: "Yoga <avisos@yogapopup.test>" },
    ((url: string, init: RequestInit) => {
      seen = { url, init };
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch,
  );
  await ok.send({ to: "ana@test.dev", subject: "Hola", text: "t", html: "<p>t</p>" });
  assert.equal(seen!.url, "https://api.resend.com/emails");
  assert.equal((seen!.init.headers as Record<string, string>).authorization, "Bearer re_123");
  const body = JSON.parse(seen!.init.body as string);
  assert.deepEqual(body.to, ["ana@test.dev"]);
  assert.equal(body.from, "Yoga <avisos@yogapopup.test>");

  const bad = new ResendMail(
    { apiKey: "k", from: "f" },
    (() =>
      Promise.resolve(
        new Response('{"message":"ana@test.dev is invalid"}', { status: 422 }),
      )) as unknown as typeof fetch,
  );
  await assert.rejects(bad.send({ to: "ana@test.dev", subject: "s", text: "t", html: "h" }), (e) => {
    assert.ok(e instanceof MailError);
    assert.equal(e.status, 422);
    assert.doesNotMatch(e.message, /ana@test\.dev/, "el mensaje no nombra a la destinataria");
    return true;
  });
});

Deno.test("loadRemindersConfig: valores por defecto, correo opcional y zona horaria validada", () => {
  const base = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s" };
  const c = loadRemindersConfig({ ...base, ALLOWED_ORIGINS: "http://localhost:8080, https://yogapopup.com" });
  assert.equal(c.mail, null, "sin RESEND_API_KEY / MAIL_FROM no hay correo");
  assert.equal(c.app.timezone, "Europe/Madrid");
  assert.equal(c.app.siteUrl, "https://yogapopup.com", "el sitio sale del primer origen no local");
  assert.equal(c.app.batchLimit, 100);
  const full = loadRemindersConfig({
    ...base,
    RESEND_API_KEY: "re_1",
    MAIL_FROM: "Yoga <a@b.c>",
    SITE_URL: "https://otro.test",
    REMINDERS_TZ: "Atlantic/Canary",
    REMINDERS_BATCH: "20",
  });
  assert.deepEqual(full.mail, { apiKey: "re_1", from: "Yoga <a@b.c>" });
  assert.equal(full.app.siteUrl, "https://otro.test");
  assert.equal(full.app.timezone, "Atlantic/Canary");
  assert.equal(full.app.batchLimit, 20);
  assert.throws(() => loadRemindersConfig({ ...base, REMINDERS_TZ: "Narnia/Cair" }), /REMINDERS_TZ/);
  assert.throws(() => loadRemindersConfig({ SUPABASE_URL: "x" }), /SUPABASE_ANON_KEY/);
});
