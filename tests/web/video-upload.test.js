import assert from "node:assert/strict";
import { assertVideoReady, MAX_VIDEO_BYTES, sanitizeDuration, videoFileProblem } from "../../js/lib/video-upload.js";
import { AppError, messageFor } from "../../js/lib/errors.js";

const file = (over = {}) => ({ name: "clase.mp4", type: "video/mp4", size: 5_000_000, ...over });

Deno.test("videoFileProblem: acepta videos normales (con tipo, o sin tipo pero con extensión conocida)", () => {
  assert.equal(videoFileProblem(file()), null);
  assert.equal(videoFileProblem(file({ type: "video/quicktime", name: "a.mov" })), null);
  assert.equal(videoFileProblem(file({ type: "", name: "a.MOV" })), null);
  assert.equal(videoFileProblem(file({ size: MAX_VIDEO_BYTES })), null);
});

Deno.test("videoFileProblem: rechaza lo que no es video, está vacío o pesa de más", () => {
  assert.ok(videoFileProblem(undefined));
  assert.ok(videoFileProblem(null));
  assert.match(videoFileProblem(file({ type: "text/html", name: "a.html" })), /video/i);
  assert.match(videoFileProblem(file({ type: "application/zip", name: "a.zip" })), /video/i);
  assert.match(videoFileProblem(file({ type: "", name: "a.exe" })), /video/i);
  assert.match(videoFileProblem(file({ size: 0 })), /vac/i);
  assert.match(videoFileProblem(file({ size: MAX_VIDEO_BYTES + 1 })), /5 GB/);
});

Deno.test("sanitizeDuration: solo manda lo que el servidor acepta (1 s a 24 h); el resto es 'no informada'", () => {
  assert.equal(sanitizeDuration(2700), 2700);
  assert.equal(sanitizeDuration(2700.4567), 2700.457);
  assert.equal(sanitizeDuration(1), 1);
  assert.equal(sanitizeDuration(86400), 86400);
  for (const bad of [NaN, Infinity, -Infinity, 0, 0.5, -3, 86401, 1e12, "60", null, undefined, true, []]) {
    assert.equal(sanitizeDuration(bad), null, String(bad));
  }
});

Deno.test("assertVideoReady: solo 'ready' es éxito; 'failed' y todo lo demás es un error visible", () => {
  assertVideoReady({ video_status: "ready" });
  const expected = { failed: "video_invalid", pending: "upload_unconfirmed", uploading: "upload_unconfirmed" };
  for (const status of ["failed", "pending", "uploading", undefined]) {
    assert.throws(
      () => assertVideoReady({ video_status: status }),
      (e) => e instanceof AppError && e.code === (expected[status] ?? "upload_unconfirmed"),
      String(status),
    );
  }
  assert.throws(() => assertVideoReady(undefined), (e) => e instanceof AppError);
  try {
    assertVideoReady({ video_status: "failed" });
  } catch (e) {
    assert.match(messageFor(e), /no es un video v/i); // el mensaje explica qué pasó y qué hacer
  }
});

Deno.test("errors: los códigos nuevos del servidor tienen mensaje propio", () => {
  assert.match(messageFor(new AppError("rate_limited")), /Esper/);
  assert.match(messageFor(new AppError("upload_failed")), /subida/i);
});
