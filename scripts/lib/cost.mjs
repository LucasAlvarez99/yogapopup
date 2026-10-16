/**
 * Estimación del costo de almacenamiento en Cloudflare R2 a partir de lo que pesan los videos REALES (Fases 34 y 36).
 * R2: primeros 10 GB gratis por mes, ~0,015 USD por GB/mes después y sin cargo por salida de datos (verificar en la página
 * oficial de Cloudflare: los precios pueden cambiar). Se prueba en tests/web/cost.test.js.
 */
export const R2_FREE_GB = 10;
export const R2_USD_PER_GB = 0.015;

const positive = (n) => Number.isFinite(n) && n > 0;

/**
 * @param {{ videos: number, totalGb: number, target?: number, freeGb?: number, usdPerGb?: number }} input
 *   videos / totalGb: lo que ya está subido y lo que ocupa en R2; target: cuántos videos tendrá el catálogo completo.
 * @returns {{ avgGb: number, projectedGb: number, billableGb: number, usdPerMonth: number }}
 */
export function projectCost({ videos, totalGb, target = videos, freeGb = R2_FREE_GB, usdPerGb = R2_USD_PER_GB }) {
  if (!positive(videos) || !Number.isInteger(videos)) throw new Error('videos tiene que ser un entero mayor que 0');
  if (!positive(totalGb)) throw new Error('gb tiene que ser un número mayor que 0 (lo que ocupan los videos en R2)');
  if (!positive(target) || !Number.isInteger(target) || target < videos) throw new Error('target tiene que ser un entero mayor o igual a videos');
  const avgGb = totalGb / videos;
  const projectedGb = avgGb * target;
  const billableGb = Math.max(0, projectedGb - freeGb);
  return {
    avgGb: round(avgGb, 3),
    projectedGb: round(projectedGb, 1),
    billableGb: round(billableGb, 1),
    usdPerMonth: round(billableGb * usdPerGb, 2),
  };
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

/** Lee `--videos 3 --gb 2.4 --target 40` (también `--clave=valor`). */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error(`argumento no reconocido: ${argv[i]}`);
    out[m[1]] = m[2] ?? argv[++i];
  }
  return out;
}
