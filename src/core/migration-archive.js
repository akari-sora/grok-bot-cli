/** Archive v2: one captured bot on disk. Create-only, private files, manifest written last. */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ARCHIVE_FORMAT, ARCHIVE_VERSION } from './migration-capture.js';
import { MigrationError, directory, parseBytes, privateWrite, regularBytes, safeRelative } from './migration.js';

const MAX_ARCHIVE_FILE = 512 * 1024 * 1024;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const json = (v) => JSON.stringify(v, null, 2) + '\n';
const fail = (m) => { throw new MigrationError(m); };

/** A box path as a safe archive path. Unsafe segments become a stable hash-named segment. */
export function archivePathFor(boxPath) {
  const parts = boxPath.replace(/^\/+/, '').split('/').filter(Boolean).map((part) =>
    safeRelative(part) && part.length <= 120 ? part : 'x-' + sha256(part).slice(0, 16));
  const path = ['box', ...parts].join('/');
  return path.length <= 200 && safeRelative(path) ? path : 'box/long/' + sha256(boxPath).slice(0, 32);
}

const ROLE = (m) => (m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Bot' : 'event');

function reportMarkdown(cap) {
  const lines = [`# Grok Bot capture: ${cap.bot.name}`, '', `Captured ${cap.capturedAt}. Bot id \`${cap.bot.id}\`.`, '', '## Coverage', '',
    '| Area | Status | Detail |', '| --- | --- | --- |'];
  for (const [area, c] of Object.entries(cap.coverage)) {
    const { status, ...rest } = c;
    const detail = Object.entries(rest).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`).join('; ');
    lines.push(`| ${area} | ${status} | ${detail.replace(/\|/g, '\\|').slice(0, 400)} |`);
  }
  if (cap.skipped.length) {
    lines.push('', '## Files not captured', '');
    for (const s of cap.skipped) lines.push(`- \`${s.boxPath}\`: ${s.reason}`);
  }
  lines.push('', 'Connector logins, OAuth grants, secrets and payment methods stay in Grok Bot by design.', '');
  return lines.join('\n');
}

/** Serialize a capture. Bytes of box files are stored verbatim; the index keeps their digests. */
export function captureFiles(cap) {
  const files = new Map();
  const add = (path, content) => {
    if (files.has(path)) fail('Archive path collision: ' + path);
    files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  };
  const transcripts = [];
  for (const t of cap.transcripts) {
    const name = t.sessionId ? 'session-' + sha256(t.sessionId).slice(0, 16) : 'main';
    add(`transcript/${name}.jsonl`, t.entries.map((e) => JSON.stringify(e.message)).join('\n') + (t.entries.length ? '\n' : ''));
    add(`transcript/${name}.raw.jsonl`, t.entries.map((e) => JSON.stringify({ row: e.row, body: e.body })).join('\n') + (t.entries.length ? '\n' : ''));
    add(`transcript/${name}.md`, `# ${cap.bot.name} — full conversation (${t.sessionId || 'main'})\n\n` + t.entries
      .filter((e) => e.message.role !== 'event')
      .map((e) => `## ${ROLE(e.message)} · ${e.message.timestampMs ? new Date(e.message.timestampMs).toISOString() : 'time unknown'} · #${e.message.seq}\n\n${e.message.text}\n`).join('\n'));
    transcripts.push({ sessionId: t.sessionId, path: `transcript/${name}.jsonl`, rows: t.entries.length, pages: t.pages,
      generation: t.generation, firstSeq: t.firstSeq, lastSeq: t.lastSeq, unreadable: t.unreadable, gaps: t.gaps });
  }
  const boxIndex = [];
  for (const f of cap.files) {
    if (f.kind === 'symlink') { boxIndex.push({ boxPath: f.boxPath, kind: 'symlink', target: f.target, reason: f.reason }); continue; }
    const path = archivePathFor(f.boxPath);
    if (sha256(f.bytes) !== f.sha256) fail('Box file digest changed in memory: ' + f.boxPath);
    add(path, f.bytes);
    boxIndex.push({ boxPath: f.boxPath, path, kind: 'file', size: f.size, sha256: f.sha256, mode: f.mode, reason: f.reason });
  }
  const { transcripts: _t, files: _f, ...rest } = cap;
  add('capture.json', json({ ...rest, transcripts, box: boxIndex }));
  add('REPORT.md', reportMarkdown(cap));
  return files;
}

/** Write a new archive directory (refuses an existing one). Returns { root, manifest }. */
export function writeArchive(cap, out) {
  const files = captureFiles(cap);
  const destination = resolve(out);
  const parent = directory(dirname(destination));
  const root = join(parent, basename(destination));
  mkdirSync(root, { mode: 0o700 });
  const index = [];
  for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!safeRelative(path) || path === 'manifest.json') fail('Unsafe archive path: ' + path);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = join(root, ...parts.slice(0, i));
      try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) fail('Unsafe archive subdirectory.');
    }
    privateWrite(join(root, ...parts), bytes);
    index.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, capturedAt: cap.capturedAt,
    bot: { id: cap.bot.id, name: cap.bot.name }, files: index };
  privateWrite(join(root, 'manifest.json'), Buffer.from(json(manifest)));
  return { root, manifest };
}

/** Read and fully verify an archive. Returns { root, manifest, capture, read(path) }. */
export function openArchive(path) {
  const root = directory(path);
  const manifest = parseBytes(regularBytes(join(root, 'manifest.json'), 64 * 1024 * 1024));
  if (manifest?.format !== ARCHIVE_FORMAT || manifest.version !== ARCHIVE_VERSION || !Array.isArray(manifest.files)) fail('Not a gbot migration archive (v2).');
  const wanted = new Map();
  for (const row of manifest.files) {
    if (!safeRelative(row.path) || wanted.has(row.path) || !/^[0-9a-f]{64}$/.test(row.sha256 ?? '') || !Number.isSafeInteger(row.bytes)) fail('Invalid archive index.');
    wanted.set(row.path, row);
  }
  const cache = new Map();
  const read = (p) => {
    const row = wanted.get(p);
    if (!row) fail('Not in the archive: ' + p);
    if (cache.has(p)) return cache.get(p);
    const bytes = regularBytes(join(root, ...p.split('/')), Math.min(row.bytes, MAX_ARCHIVE_FILE));
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) fail('Archive checksum mismatch: ' + p);
    cache.set(p, bytes);
    return bytes;
  };
  for (const p of wanted.keys()) read(p);
  // No untracked files.
  const dirs = new Set();
  for (const p of [...wanted.keys(), 'manifest.json']) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
  const walk = (rel = '') => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) fail('Unexpected symlink in archive.');
      if (e.isDirectory()) { if (!dirs.has(p)) fail('Unexpected directory in archive: ' + p); walk(p); }
      else if (!(wanted.has(p) || p === 'manifest.json')) fail('Unexpected file in archive: ' + p);
    }
  };
  walk();
  const capture = parseBytes(read('capture.json'));
  const transcript = (t) => read(t.path).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const boxFile = (boxPath) => {
    const row = capture.box.find((b) => b.boxPath === boxPath && b.kind === 'file');
    return row ? read(row.path) : null;
  };
  return { root, manifest, capture, read, transcript, boxFile };
}
