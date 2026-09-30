import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Genera (una vez) un video mp4 real de 12 s con ffmpeg: R2 no transcodifica, así que se sirve
 * un único archivo progresivo, igual que en producción.
 */
export function ensureMedia(key) {
  const dir = join(tmpdir(), 'yp-e2e-media', key.replace(/\//g, '_'));
  const file = join(dir, 'video.mp4');
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '64k',
    '-movflags', '+faststart', file], { stdio: 'inherit' });
  return file;
}
