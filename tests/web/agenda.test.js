import assert from "node:assert/strict";
import {
  arDay,
  arMidnight,
  arTime,
  arToIso,
  buildSessionInput,
  buildTeacherProfileInput,
  firstDayWithSessions,
  groupByDay,
  isFull,
  isoToArFields,
  localTimeIfDifferent,
  monthGrid,
  monthRange,
  parseSpecialties,
  seatsLeft,
  shiftMonth,
} from "../../js/lib/agenda.js";
import { agendaError, AppError, messageFor } from "../../js/lib/errors.js";

Deno.test("agenda: el día y la hora se muestran SIEMPRE en hora argentina (GMT-3), esté donde esté el navegador", () => {
  const t = "2026-09-24T21:30:00Z"; // 18:30 en Argentina
  assert.equal(arTime(t), "18:30");
  assert.equal(arDay(t), "2026-09-24");
  // Pasada la medianoche UTC sigue siendo el día anterior en Argentina.
  assert.equal(arDay("2026-09-25T01:30:00Z"), "2026-09-24");
  assert.equal(arTime("2026-09-25T01:30:00Z"), "22:30");
});

Deno.test("agenda: la hora local solo se muestra si difiere de la argentina", () => {
  const t = "2026-09-24T21:30:00Z";
  assert.equal(localTimeIfDifferent(t, "America/Argentina/Buenos_Aires"), null);
  assert.equal(localTimeIfDifferent(t, "Europe/Madrid"), "23:30"); // GMT+2 en septiembre
  assert.match(
    localTimeIfDifferent("2026-09-24T23:30:00Z", "Europe/Madrid"),
    /^01:30 \(25\/09\)$/,
    "si cambia el día, lo aclara",
  );
});

Deno.test("agenda: rango del mes = medianoche argentina del 1 al 1 del mes siguiente", () => {
  assert.deepEqual(monthRange(2026, 8), { from: "2026-09-01T03:00:00.000Z", to: "2026-10-01T03:00:00.000Z" });
  assert.deepEqual(
    monthRange(2026, 11),
    { from: "2026-12-01T03:00:00.000Z", to: "2027-01-01T03:00:00.000Z" },
    "diciembre -> enero",
  );
  assert.equal(arMidnight(2026, 8, 24).toISOString(), "2026-09-24T03:00:00.000Z");
});

Deno.test("agenda: navegación de mes cruza el año en ambos sentidos", () => {
  assert.deepEqual(shiftMonth(2026, 11, 1), { year: 2027, month: 0 });
  assert.deepEqual(shiftMonth(2026, 0, -1), { year: 2025, month: 11 });
  assert.deepEqual(shiftMonth(2026, 8, 0), { year: 2026, month: 8 });
});

Deno.test("agenda: grilla de septiembre 2026 (arranca martes, semana desde el lunes)", () => {
  const weeks = monthGrid(2026, 8);
  assert.ok(weeks.every((w) => w.length === 7), "todas las semanas tienen 7 celdas");
  assert.equal(weeks[0][0].inMonth, false, "el lunes 31/8 no es de septiembre");
  assert.equal(weeks[0][1].ymd, "2026-09-01");
  const days = weeks.flat().filter((c) => c.inMonth);
  assert.equal(days.length, 30);
  assert.equal(days.at(-1).ymd, "2026-09-30");
  // Febrero 2026 empieza domingo: 6 celdas vacías antes.
  assert.equal(monthGrid(2026, 1)[0].filter((c) => !c.inMonth).length, 6);
  // Febrero 2028 (bisiesto) tiene 29 días.
  assert.equal(monthGrid(2028, 1).flat().filter((c) => c.inMonth).length, 29);
});

Deno.test("agenda: agrupa por día argentino, ordenado por hora", () => {
  const rows = [
    { id: "b", starts_at: "2026-09-24T23:30:00Z" }, // 20:30 AR
    { id: "a", starts_at: "2026-09-24T21:30:00Z" }, // 18:30 AR
    { id: "c", starts_at: "2026-09-25T01:30:00Z" }, // 22:30 AR del 24
    { id: "d", starts_at: "2026-09-26T13:00:00Z" },
  ];
  const g = groupByDay(rows);
  assert.deepEqual(g.get("2026-09-24").map((s) => s.id), ["a", "b", "c"]);
  assert.deepEqual(g.get("2026-09-26").map((s) => s.id), ["d"]);
  assert.equal(firstDayWithSessions(rows), "2026-09-24");
  assert.equal(firstDayWithSessions([]), null);
});

Deno.test("agenda: cupos — sin límite, con lugares, completa y nunca negativos", () => {
  assert.equal(seatsLeft({ capacity: null, booked: 5 }), null);
  assert.equal(isFull({ capacity: null, booked: 99 }), false);
  assert.equal(seatsLeft({ capacity: 10, booked: 4 }), 6);
  assert.equal(isFull({ capacity: 10, booked: 10 }), true);
  assert.equal(seatsLeft({ capacity: 2, booked: 5 }), 0, "sobrecupo no da negativo");
});

Deno.test("agenda: fecha+hora (Argentina) -> ISO y vuelta; fechas imposibles se rechazan", () => {
  assert.equal(arToIso("2026-09-24", "18:30"), "2026-09-24T21:30:00.000Z");
  assert.deepEqual(isoToArFields("2026-09-24T21:30:00.000Z"), { date: "2026-09-24", time: "18:30" });
  assert.equal(arToIso("2026-02-30", "10:00"), null, "30 de febrero no existe");
  assert.equal(arToIso("2026-09-24", "25:00"), null);
  assert.equal(arToIso("24/09/2026", "18:30"), null);
  assert.equal(arToIso("", ""), null);
  assert.equal(arToIso(undefined, undefined), null);
});

const NOW = new Date("2026-10-06T12:00:00Z");
const ok = {
  title: "Vinyasa Flow",
  date: "2026-10-10",
  time: "20:00",
  level: "intermedio",
  mode: "live",
  duration: "60",
  capacity: "12",
};
const invalid = (patch, re, opts) =>
  assert.throws(
    () => buildSessionInput({ ...ok, ...patch }, { now: NOW, ...opts }),
    (e) => e instanceof AppError && e.code === "invalid_input" && re.test(e.message),
  );

Deno.test("agenda: formulario de clase válido arma lo que va a la base", () => {
  assert.deepEqual(buildSessionInput(ok, { now: NOW }), {
    title: "Vinyasa Flow",
    level: "intermedio",
    mode: "live",
    starts_at: "2026-10-10T23:00:00.000Z",
    duration_minutes: 60,
    capacity: 12,
    is_published: true,
  });
  assert.equal(buildSessionInput({ ...ok, capacity: "" }, { now: NOW }).capacity, null, "cupo vacío = sin límite");
  assert.equal(buildSessionInput({ ...ok, is_published: false }, { now: NOW }).is_published, false);
  assert.equal(buildSessionInput({ ...ok, title: "  Yoga  " }, { now: NOW }).title, "Yoga", "recorta espacios");
});

Deno.test("agenda: formulario de clase — cada error dice qué corregir", () => {
  invalid({ title: "   " }, /título es obligatorio/);
  invalid({ title: "x".repeat(101) }, /100 caracteres/);
  invalid({ level: "experto" }, /nivel/);
  invalid({ mode: "presencial" }, /en vivo o virtual/);
  invalid({ date: "2026-02-30" }, /fecha y una hora válidas/);
  invalid({ time: "" }, /fecha y una hora válidas/);
  invalid({ date: "2026-10-01" }, /futuro/);
  invalid({ duration: "14" }, /entre 15 y 240/);
  invalid({ duration: "241" }, /entre 15 y 240/);
  invalid({ duration: "abc" }, /entre 15 y 240/);
  invalid({ duration: "" }, /entre 15 y 240/);
  invalid({ capacity: "0" }, /cupo/);
  invalid({ capacity: "501" }, /cupo/);
  invalid({ capacity: "2,5" }, /cupo/);
  invalid({ capacity: "-3" }, /cupo/);
  // Editar una clase que ya pasó no obliga a cambiar la fecha.
  assert.doesNotThrow(() => buildSessionInput({ ...ok, date: "2026-10-01" }, { now: NOW, allowPast: true }));
});

Deno.test("agenda: especialidades — sin vacías ni repetidas, tope 8 y 30 caracteres", () => {
  assert.deepEqual(parseSpecialties("Hatha, Vinyasa , Yoga Flow"), ["Hatha", "Vinyasa", "Yoga Flow"]);
  assert.deepEqual(parseSpecialties("hatha, Hatha, ,HATHA"), ["hatha"]);
  assert.deepEqual(parseSpecialties(""), []);
  assert.deepEqual(parseSpecialties(null), []);
  assert.equal(parseSpecialties("a,b,c,d,e,f,g,h,i,j").length, 8);
  assert.equal(parseSpecialties("x".repeat(50))[0].length, 30);
});

Deno.test("agenda: perfil del profesor — nombre obligatorio, bio con tope, bio vacía = null", () => {
  assert.deepEqual(buildTeacherProfileInput({ public_name: " Lucía ", bio: "  ", specialties: "Vinyasa" }), {
    public_name: "Lucía",
    bio: null,
    specialties: ["Vinyasa"],
  });
  assert.throws(
    () => buildTeacherProfileInput({ public_name: " ", bio: "", specialties: "" }),
    /nombre es obligatorio/,
  );
  assert.throws(() => buildTeacherProfileInput({ public_name: "x".repeat(81), bio: "", specialties: "" }), /80/);
  assert.throws(() => buildTeacherProfileInput({ public_name: "Ana", bio: "x".repeat(601), specialties: "" }), /600/);
});

Deno.test("agenda: errores de la base se traducen a mensajes claros", () => {
  assert.equal(agendaError({ code: "23514" }).code, "session_full");
  assert.equal(agendaError({ code: "22023" }).code, "session_started");
  assert.equal(agendaError({ code: "P0002", message: "session not found" }).code, "session_not_found");
  assert.equal(agendaError({ code: "P0002", message: "user not found" }).code, "user_not_found");
  assert.equal(agendaError({ code: "42501" }).code, "forbidden");
  assert.equal(agendaError({ code: "PGRST301" }).code, "unauthenticated");
  assert.equal(agendaError({ message: "TypeError: Failed to fetch" }).code, "network");
  assert.equal(agendaError({ code: "XX000", message: "boom" }).code, "internal_error");
  assert.match(messageFor(agendaError({ code: "23514" })), /no tiene lugares/);
  assert.match(messageFor(agendaError({ code: "P0002", message: "user not found" })), /registrado/);
});
