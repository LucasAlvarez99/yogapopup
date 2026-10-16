#!/usr/bin/env node
/**
 * Proyecta el costo mensual de R2 con lo que pesan tus videos reales.
 *   npm run cost -- --videos 3 --gb 2.4            costo con lo que ya subiste
 *   npm run cost -- --videos 3 --gb 2.4 --target 40   proyección al catálogo completo
 * `--gb` es lo que ocupa el bucket (Cloudflare → R2 → tu bucket → Métricas, o la suma de los pesos de los archivos).
 */
import { parseArgs, projectCost } from './lib/cost.mjs';

try {
  const a = parseArgs(process.argv.slice(2));
  const r = projectCost({ videos: Number(a.videos), totalGb: Number(a.gb), target: a.target === undefined ? undefined : Number(a.target) });
  console.log(`Promedio por video: ${r.avgGb} GB`);
  console.log(`Catálogo (${a.target ?? a.videos} videos): ${r.projectedGb} GB`);
  console.log(`Se cobra: ${r.billableGb} GB (los primeros 10 GB son gratis) → ~${r.usdPerMonth} USD/mes`);
  console.log('La estimación del README (80 GB para 40 clases) se valida con este número en las Fases 34 y 36.');
} catch (e) {
  console.error(`✗ ${e.message}\nUso: npm run cost -- --videos 3 --gb 2.4 [--target 40]`);
  process.exit(1);
}
