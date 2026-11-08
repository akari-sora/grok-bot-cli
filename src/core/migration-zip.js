/**
 * A small, deterministic zip writer (deflate, no external dependency) for the handoff bundle that
 * Muse and Your dot unzip on their computer. The same files always give the same bytes, so a
 * resumed migration recognises a bundle it already delivered.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import { MigrationError } from './migration.js';

// 1980-01-01 00:00, the zip epoch: entry times carry no information about the run.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** @param {{ path: string, bytes: Buffer }[]} entries @returns {Buffer} */
export function zipFiles(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  const seen = new Set();
  for (const { path, bytes } of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!/^[A-Za-z0-9._-][A-Za-z0-9._\-/]*$/.test(path) || path.split('/').some((p) => !p || p === '.' || p === '..') || seen.has(path)) {
      throw new MigrationError('Unsafe or duplicate bundle path: ' + path);
    }
    seen.add(path);
    const name = Buffer.from(path, 'utf8');
    const packed = deflateRawSync(bytes, { level: 9 });
    const store = packed.length >= bytes.length;
    const data = store ? bytes : packed;
    const crc = crc32(bytes) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(0x031e, 4); // made by: Unix, 3.0
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(store ? 0 : 8, 10);
    head.writeUInt16LE(DOS_TIME, 12);
    head.writeUInt16LE(DOS_DATE, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(bytes.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // regular file, rw-r--r--
    head.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(head, name);
    offset += local.length + name.length + data.length;
    if (offset > 0xffffffff) throw new MigrationError('The bundle is larger than a plain zip can hold.');
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(seen.size, 8);
  end.writeUInt16LE(seen.size, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
