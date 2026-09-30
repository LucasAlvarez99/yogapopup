import assert from "node:assert/strict";
import { thumbnailPathFromUrl } from "../_shared/thumbnails.ts";

const SB = "https://abcd.supabase.co";
const ok = `${SB}/storage/v1/object/public/class-thumbnails/`;

Deno.test("thumbnailPathFromUrl: extrae la ruta solo de miniaturas propias", () => {
  assert.equal(thumbnailPathFromUrl(`${ok}clase-1/foto.webp`, SB), "clase-1/foto.webp");
  assert.equal(thumbnailPathFromUrl(`${ok}clase%201/foto%20x.webp`, SB), "clase 1/foto x.webp");
  assert.equal(thumbnailPathFromUrl(`${ok}a/b.webp?t=123`, SB), "a/b.webp"); // query ignorada
});

Deno.test("thumbnailPathFromUrl: rechaza URLs ajenas o sospechosas (nunca borra algo que no es nuestro)", () => {
  assert.equal(thumbnailPathFromUrl(null, SB), null);
  assert.equal(thumbnailPathFromUrl("", SB), null);
  assert.equal(thumbnailPathFromUrl("no es url", SB), null);
  assert.equal(thumbnailPathFromUrl("https://images.unsplash.com/photo.jpg", SB), null);
  assert.equal(
    thumbnailPathFromUrl("https://otro.supabase.co/storage/v1/object/public/class-thumbnails/a.webp", SB),
    null,
  );
  assert.equal(thumbnailPathFromUrl(`${SB}/storage/v1/object/public/otro-bucket/a.webp`, SB), null);
  assert.equal(thumbnailPathFromUrl(`${ok}../secreto.webp`, SB), null);
  assert.equal(thumbnailPathFromUrl(`${ok}%2e%2e/secreto.webp`, SB), null);
  assert.equal(thumbnailPathFromUrl(ok, SB), null); // sin nombre de archivo
});
