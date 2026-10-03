import assert from "node:assert/strict";
import { ATTEMPTS, BUCKET_LIMIT_BYTES, fitImage, storageUploadError, TARGET_BYTES } from "../../js/lib/image.js";
import { AppError, messageFor } from "../../js/lib/errors.js";

const MB = 1024 * 1024;
const blob = (type, size) => ({ type, size });

// --------------------------------------------------------------- navegadores simulados
/** Chrome/Edge/Firefox: codifica WebP y JPEG; el tamaño baja con el ancho y la calidad. */
const chrome = (basePx = 3 * MB) => (width, type, quality) =>
  Promise.resolve({
    type,
    size: Math.round(basePx * (width / 1280) ** 2 * quality * (type === "image/webp" ? 0.6 : 1)),
  });
/** Safari: pide WebP y devuelve PNG (enorme, casi sin respuesta a la calidad). JPEG sí lo codifica bien. */
const safari = (basePx = 3 * MB) => (width, type, quality) =>
  Promise.resolve(
    type === "image/jpeg"
      ? { type, size: Math.round(basePx * (width / 1280) ** 2 * quality) }
      : { type: "image/png", size: Math.round(basePx * 3 * (width / 1280) ** 2) },
  );

Deno.test("fitImage: el tope del bucket es 2 MiB y el objetivo queda por debajo", () => {
  assert.equal(BUCKET_LIMIT_BYTES, 2 * MB);
  assert.ok(TARGET_BYTES < BUCKET_LIMIT_BYTES);
  assert.ok(ATTEMPTS.length >= 3);
});

Deno.test("fitImage: Chrome obtiene WebP a la primera si cabe", async () => {
  const out = await fitImage(chrome(2 * MB));
  assert.equal(out.type, "image/webp");
  assert.ok(out.size <= TARGET_BYTES);
});

Deno.test("fitImage: Safari (devuelve PNG al pedir WebP) cae a JPEG y la imagen cabe en el bucket", async () => {
  // Con el código anterior este caso subía el PNG tal cual: ~9 MB > 2 MB y Storage lo rechazaba.
  const out = await fitImage(safari(3 * MB));
  assert.equal(out.type, "image/jpeg", "no se sube el PNG que Safari devuelve en lugar de WebP");
  assert.ok(out.size <= TARGET_BYTES && out.size < BUCKET_LIMIT_BYTES);
});

Deno.test("fitImage: si no cabe a la primera, baja calidad y tamaño hasta que cabe", async () => {
  const calls = [];
  const encode = chrome(12 * MB);
  const out = await fitImage((w, t, q) => (calls.push([w, q]), encode(w, t, q)));
  assert.ok(out.size <= TARGET_BYTES);
  assert.ok(calls.length > 1, "hizo más de un intento");
  assert.ok(calls.some(([w]) => w < 1280), "llegó a reducir el ancho");
});

Deno.test("fitImage: una imagen imposible de reducir da un error claro, no una subida que Storage rechaza", async () => {
  await assert.rejects(
    fitImage((_w, type) => Promise.resolve(blob(type, 50 * MB))),
    (e) => e instanceof AppError && e.code === "image_too_large",
  );
  assert.match(messageFor(new AppError("image_too_large")), /demasiado/);
});

Deno.test("fitImage: ignora resultados nulos, vacíos o de un tipo no permitido", async () => {
  await assert.rejects(fitImage(() => Promise.resolve(null)), (e) => e.code === "image_too_large");
  await assert.rejects(fitImage((_w, type) => Promise.resolve(blob(type, 0))), (e) => e.code === "image_too_large");
  await assert.rejects(fitImage(() => Promise.resolve(blob("image/gif", 1000))), (e) => e.code === "image_too_large");
  await assert.rejects(fitImage(() => Promise.resolve(blob("text/html", 1000))), (e) => e.code === "image_too_large");
});

Deno.test("fitImage: nunca devuelve algo por encima del límite (propiedad sobre muchos tamaños)", async () => {
  for (const base of [0.2, 1, 3, 6, 9, 15]) {
    for (const browser of [chrome, safari]) {
      try {
        const out = await fitImage(browser(base * MB));
        assert.ok(out.size <= TARGET_BYTES && /^image\/(webp|jpeg|png)$/.test(out.type), `${browser.name} ${base} MB`);
      } catch (e) {
        assert.equal(e.code, "image_too_large", "o cabe, o falla con un mensaje claro: nunca se sube algo grande");
      }
    }
  }
});

// --------------------------------------------------------------- errores de Storage
Deno.test("storageUploadError: cada causa real se traduce a un motivo que la persona entiende", () => {
  const cases = [
    [{ statusCode: "413", message: "The object exceeded the maximum allowed size" }, "image_too_large"],
    [{ message: "Payload too large" }, "image_too_large"],
    [{ statusCode: "403", message: "new row violates row-level security policy" }, "image_forbidden"],
    [{ statusCode: "401", message: "Unauthorized" }, "image_forbidden"],
    [{ message: "mime type image/gif is not supported" }, "invalid_input"],
    [{ statusCode: "415", error: "invalid_mime_type" }, "invalid_input"],
    [{ statusCode: "404", message: "Bucket not found" }, "storage_missing"],
    [{ message: "algo raro" }, "storage_error"],
    [null, "storage_error"],
    [undefined, "storage_error"],
  ];
  for (const [err, code] of cases) assert.equal(storageUploadError(err).code, code, JSON.stringify(err));
  assert.match(messageFor(storageUploadError({ statusCode: "403" })), /permiso/);
  assert.match(messageFor(storageUploadError({ statusCode: "404", message: "Bucket not found" })), /bucket/i);
  assert.equal(
    messageFor(storageUploadError({ message: "algo raro" }, "No se pudo subir la miniatura.")),
    "No se pudo subir la miniatura.",
  );
});
