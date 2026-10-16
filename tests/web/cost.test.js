import assert from "node:assert/strict";
import { parseArgs, projectCost } from "../../scripts/lib/cost.mjs";

Deno.test("projectCost: lo ya subido y la proyección al catálogo completo", () => {
  // 3 videos que pesan 2,4 GB en total → 0,8 GB cada uno → 40 videos = 32 GB → 22 GB pagos
  const r = projectCost({ videos: 3, totalGb: 2.4, target: 40 });
  assert.deepEqual(r, { avgGb: 0.8, projectedGb: 32, billableGb: 22, usdPerMonth: 0.33 });
});

Deno.test("projectCost: bajo los 10 GB gratis no se paga nada; sin target usa lo subido", () => {
  assert.equal(projectCost({ videos: 3, totalGb: 2.4 }).usdPerMonth, 0);
  assert.equal(projectCost({ videos: 3, totalGb: 2.4 }).projectedGb, 2.4);
});

Deno.test("projectCost: el supuesto del README (80 GB) da unos 1,05 USD al mes", () => {
  assert.equal(projectCost({ videos: 40, totalGb: 80 }).usdPerMonth, 1.05);
});

Deno.test("projectCost: datos inválidos son un error con motivo", () => {
  assert.throws(() => projectCost({ videos: 0, totalGb: 1 }), /videos/);
  assert.throws(() => projectCost({ videos: 2.5, totalGb: 1 }), /videos/);
  assert.throws(() => projectCost({ videos: 3, totalGb: -1 }), /gb/);
  assert.throws(() => projectCost({ videos: 3, totalGb: Number.NaN }), /gb/);
  assert.throws(() => projectCost({ videos: 5, totalGb: 1, target: 3 }), /target/);
});

Deno.test("parseArgs: --clave valor y --clave=valor", () => {
  assert.deepEqual(parseArgs(["--videos", "3", "--gb=2.4"]), { videos: "3", gb: "2.4" });
  assert.throws(() => parseArgs(["videos"]), /no reconocido/);
});
