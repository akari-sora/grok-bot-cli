/** Shared migration errors and safe, private file IO (no symlinks, hardlinks or FIFOs). */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const MAX_MIGRATION_BYTES = 64 * 1024 * 1024;

export class MigrationError extends Error {
  constructor(message) { super(message); this.name = 'MigrationError'; }
}
const fail = (message) => { throw new MigrationError(message); };

export function regularBytes(path, cap = MAX_MIGRATION_BYTES) {
  // NONBLOCK prevents a swapped FIFO from hanging; NOFOLLOW is supplemented by lstat/fstat checks.
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('Expected a regular, non-linked file.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > cap) fail('Unsafe or oversized migration file.');
    const chunks = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, cap - size + 1));
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      size += n;
      if (size > cap) fail('Migration file exceeds read budget.');
      chunks.push(chunk.subarray(0, n));
    }
    return Buffer.concat(chunks);
  } finally { closeSync(fd); }
}
export function parseBytes(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('Migration file is not valid UTF-8 JSON.'); }
}
export function directory(path) {
  const full = resolve(path);
  const st = lstatSync(full);
  if (!st.isDirectory() || st.isSymbolicLink()) fail('Expected an archive directory (not a file or a symlink): ' + full);
  return realpathSync(full);
}
export function safeRelative(path) {
  return typeof path === 'string' && path.length <= 200 && path.split('/').every((part) =>
    /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part) && !part.endsWith('.') && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
}
export function privateWrite(path, bytes) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
