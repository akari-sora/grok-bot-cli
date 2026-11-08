/**
 * Full, read-only capture of ONE Grok Bot for migration (archive format v2).
 *
 * Sources, in order of authority:
 *  - backend RPCs (allowlisted in gateway.backendRead): roster row, every transcript page
 *    (ListGrokBotTranscriptEntries, `beforeSeq` pagination, omitted bodies from the store),
 *    automations, todos/tasks, skills, plugins, file lists;
 *  - the box store (ListSandBoxStoreObjects / PresignSandBoxStoreReads): manifest.json maps box
 *    paths to content-addressed blobs. It holds the bot's memory files, automation records,
 *    attachments, the box scripts its prompts call and the shared skill library (workflows/<name>/).
 * The session is backend-only: the box is never described or woken. Nothing here sends a prompt
 * or calls a write RPC. Every read is recorded in `coverage`, so a
 * gap is visible instead of silent.
 */
import { createHash } from 'node:crypto';
import { MigrationError } from './migration.js';

export const ARCHIVE_FORMAT = 'gbot-migration';
export const ARCHIVE_VERSION = 2;
export const TRANSCRIPT_PAGE = 500;
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_TRANSCRIPT_PAGES = 2000;
const BLOB_BATCH = 8;
const MANIFEST_RANGE = 8 * 1024 * 1024;
// The Grok Bot app reads the store 8 requests at a time (node-agent-coordinator readBlobs, n$ = 8)
// and pages transcripts at 500 + 1 rows (cH = 500); capture does the same.
const MANIFEST_PARALLEL = 8;
const MAX_MANIFEST_BYTES = 1024 * 1024 * 1024;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const SHA_RE = /^[0-9a-f]{64}$/;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
};

/** The presigned store host. Only that host (or loopback in tests) may receive a fetch. */
export function assertStoreUrl(raw, env = process.env) {
  let url;
  try { url = new URL(raw); } catch { throw new MigrationError('The store returned an invalid read URL.'); }
  const test = env.GROK_BOT_TEST === '1' || env.NODE_ENV === 'test';
  if (test) {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new MigrationError('Store URL must be loopback in test mode.');
    return url.href;
  }
  if (url.protocol !== 'https:' || !/^sand-box-stores\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)) {
    throw new MigrationError('The store returned a read URL for an unexpected host; nothing was fetched.');
  }
  return url.href;
}

/** GET a presigned URL with a byte cap, no redirects and no credentials. */
export async function fetchStoreBytes(url, { cap, headers = {}, fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  const res = await fetchImpl(assertStoreUrl(url), { redirect: 'error', headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!(res.status === 200 || res.status === 206)) {
    await res.body?.cancel?.();
    const error = new MigrationError(`Store read failed (HTTP ${res.status}).`);
    error.status = res.status;
    throw error;
  }
  const reader = res.body?.getReader();
  if (!reader) throw new MigrationError('Store read returned no body.');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (cap && size > cap) throw new MigrationError('Store object exceeds the read budget.');
      chunks.push(Buffer.from(value));
    }
  } finally { try { await reader.cancel(); } catch { /* closed */ } }
  return { bytes: Buffer.concat(chunks), etag: res.headers.get('etag'), contentRange: res.headers.get('content-range') };
}

/** Decode a proto3-JSON `bytes` field (base64) to a JSON object, or null. */
function decodeBody(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch { return null; }
}

/** One transcript row as role/text/time, keeping the decoded body for the raw log. */
export function normalizeEntry(row, body) {
  const kind = str(row.entryKind) || str(body?.kind) || 'unknown';
  const base = { seq: num(row.seq), entryId: str(row.entryId) || str(body?.id) || null, kind };
  const ts = num(body?.timestampMs) ?? num(body?.createdAt) ?? null;
  if (body && kind === 'message' && (body.role === 'user' || body.role === 'assistant')) {
    return { ...base, role: body.role, text: typeof body.content === 'string' ? body.content : JSON.stringify(body.content ?? ''), timestampMs: ts };
  }
  if (body && kind === 'send-message' && body.message?.type === 'text') {
    return { ...base, role: 'assistant', text: str(body.message.content), timestampMs: ts };
  }
  return { ...base, role: 'event', text: body ? JSON.stringify(body.event ?? body).slice(0, 2000) : '', timestampMs: ts };
}

/**
 * Read every transcript row of one session, newest page first. A short page does not prove the
 * end (the server may cap a page below the requested limit), so paging stops only at an empty
 * page or at seq 1. Pages are disjoint by `beforeSeq`; a repeated seq with other content means
 * the transcript changed during the read.
 */
export async function readFullTranscript({ rpc, readBlobs, agentId, sessionId = '' }) {
  const rows = new Map();
  let beforeSeq;
  let generation;
  let pages = 0;
  for (;;) {
    if (++pages > MAX_TRANSCRIPT_PAGES) throw new MigrationError('Transcript pagination did not end.');
    const body = { agentId, limit: TRANSCRIPT_PAGE + 1, ...(sessionId ? { sessionId } : {}),
      ...(beforeSeq === undefined ? {} : { beforeSeq: String(beforeSeq) }),
      ...(generation ? { generation } : {}) };
    const page = await rpc('ListGrokBotTranscriptEntries', body);
    const entries = Array.isArray(page?.entries) ? page.entries : [];
    if (generation === undefined) generation = num(page?.generation) ?? 0;
    else if ((num(page?.generation) ?? 0) !== generation) throw new MigrationError('The transcript changed generation during the read; run the capture again.');
    let min = Infinity;
    for (const e of entries) {
      const seq = num(e.seq);
      if (seq === null) throw new MigrationError('Transcript row without a sequence number.');
      const seen = rows.get(seq);
      if (seen && JSON.stringify(seen) !== JSON.stringify(e)) throw new MigrationError(`Transcript row ${seq} changed during the read; run the capture again.`);
      rows.set(seq, e);
      min = Math.min(min, seq);
    }
    if (!entries.length || min <= 1) break;
    if (beforeSeq !== undefined && min >= beforeSeq) throw new MigrationError('Transcript pagination did not advance.');
    beforeSeq = min;
  }
  const ordered = [...rows.values()].sort((a, b) => num(a.seq) - num(b.seq));
  const missing = ordered.filter((e) => !e.body && (e.blobHash || e.bodyOmitted));
  const blobs = missing.length ? await readBlobs(missing.map((e) => e.blobHash).filter((h) => SHA_RE.test(h ?? ''))) : new Map();
  const out = [];
  let unreadable = 0;
  for (const e of ordered) {
    let body = decodeBody(e.body);
    if (!body && e.blobHash && blobs.has(e.blobHash)) {
      try { body = JSON.parse(blobs.get(e.blobHash).toString('utf8')); } catch { body = null; }
    }
    if (!body) unreadable++;
    out.push({ row: { seq: e.seq, entryKind: e.entryKind, entryId: e.entryId ?? null, updatedSeq: e.updatedSeq ?? null }, body, message: normalizeEntry(e, body) });
  }
  const seqs = out.map((e) => num(e.row.seq));
  const gaps = [];
  for (let i = 1; i < seqs.length; i++) if (seqs[i] !== seqs[i - 1] + 1) gaps.push([seqs[i - 1], seqs[i]]);
  return { entries: out, pages, generation, unreadable, firstSeq: seqs[0] ?? null, lastSeq: seqs.at(-1) ?? null, gaps };
}

/** Download the box store manifest with parallel ranges pinned to one ETag. */
export async function readStoreManifest({ presign, fetchImpl = fetch }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = await presign('manifest.json');
    const first = await fetchStoreBytes(url, { cap: MANIFEST_RANGE, headers: { Range: `bytes=0-${MANIFEST_RANGE - 1}` }, fetchImpl });
    const total = Number(/\/(\d+)$/.exec(first.contentRange ?? '')?.[1] ?? first.bytes.length);
    if (!Number.isSafeInteger(total) || total > MAX_MANIFEST_BYTES) throw new MigrationError('The box store manifest is too large.');
    const parts = [first.bytes];
    const ranges = [];
    for (let start = first.bytes.length; start < total; start += MANIFEST_RANGE) ranges.push([start, Math.min(total, start + MANIFEST_RANGE) - 1]);
    let changed = false;
    for (let i = 0; i < ranges.length && !changed; i += MANIFEST_PARALLEL) {
      const batch = await Promise.allSettled(ranges.slice(i, i + MANIFEST_PARALLEL).map(([a, b]) =>
        fetchStoreBytes(url, { cap: b - a + 1, headers: { Range: `bytes=${a}-${b}`, ...(first.etag ? { 'If-Match': first.etag } : {}) }, fetchImpl })));
      for (const r of batch) {
        if (r.status === 'rejected') {
          if (r.reason?.status === 412) { changed = true; break; }
          throw r.reason;
        }
        parts.push(r.value.bytes);
      }
    }
    if (changed) continue; // the box rewrote its manifest between ranges: read it again
    const bytes = Buffer.concat(parts);
    if (bytes.length !== total) throw new MigrationError('The box store manifest read was incomplete.');
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new MigrationError('The box store manifest is not valid JSON.'); }
    if (!object(parsed?.entries)) throw new MigrationError('Unsupported box store manifest.');
    return { updatedAtMs: num(parsed.updatedAtMs), version: parsed.version, entries: parsed.entries, bytes: total };
  }
  throw new MigrationError('The box store manifest kept changing during the read; run the capture again.');
}

// Never exported, even when a prompt names them.
const SECRET_PATH = /(^|\/)(box-secrets\.json|host-secrets\.json|turnkey-agent-credentials\.json|chrome-cookie[^/]*|teach-queue-key\.json|\.env[^/]*|[^/]*\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn)|id_[a-z0-9]+|auth\.json|\.?credentials?[^/]*|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.yarnrc(\.yml)?|\.pgpass|\.my\.cnf|\.boto|\.s3cfg|\.htpasswd|\.vault-token|\.dockercfg|kubeconfig[^/]*|[^/]*service[-_]?account[^/]*\.json|[^/]*token[^/]*|[^/]*secret[^/]*|[^/]*password[^/]*)$/i;
const SECRET_DIR = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.oci|\.secrets|\.docker|\.kube|\.config\/gh|\.config\/glab-cli|\.config\/gcloud|\.config\/rclone|\.config\/hub|\.config\/op|\.config\/doctl|\.local\/share\/keyrings|chrome-profile|\.mozilla|\.password-store)(\/|$)/i;
// A best-effort name list, not a guarantee: content is redacted separately (migration-redact.js).
export const isSecretPath = (p) => SECRET_PATH.test(p) || SECRET_DIR.test(p);

/** Box paths a bot owns or names, from the manifest. Returns [{path, entry, reason}]. */
/** Only the manifest entries at credential paths (for the same-bytes rule in a partial selection). */
const secretEntries = (entries) => Object.fromEntries(Object.entries(entries).filter(([p]) => isSecretPath(p)));

const UNSAFE_PATH = /(^\/|\\|\0|(^|\/)\.\.?(\/|$))/;
export const isUnsafeBoxPath = (p) => typeof p !== 'string' || !p || UNSAFE_PATH.test(p);

export function selectBoxFiles(entries, { agentId, referenced = [], skillDirs = [], projects = [] }) {
  const picks = new Map();
  // The same bytes under a credential path and under an ordinary name are still a credential.
  const secretShas = new Set(Object.entries(entries).filter(([p, e]) => isSecretPath(p) && e?.sha).map(([, e]) => e.sha));
  const add = (path, reason) => {
    const entry = entries[path];
    if (!entry || picks.has(path) || isSecretPath(path) || isUnsafeBoxPath(path) || (entry.sha && secretShas.has(entry.sha))) return;
    picks.set(path, { path, entry, reason });
  };
  // Grok Bot memory has three tiers (its prompt says so): shared user memory (every assistant's
  // shard under user-memory/by-agent, visible to all bots), project memory for the projects the
  // bot joined, and the bot's own memory folder.
  const prefixes = [
    [`home/box/sand-data/agents/${agentId}/`, 'bot-data'],
    ['home/box/sand-data/user-memory/', 'user-memory'],
    ...projects.map((slug) => [`home/box/sand-data/projects/${slug}/`, 'project-memory']),
    [`home/box/sand-data/agent-transcripts/${agentId}/`, 'box-transcript'],
    ...skillDirs.map((d) => [`home/box/sand-data/workflows/${d}/`, 'skill']),
  ];
  for (const path of Object.keys(entries)) {
    for (const [prefix, reason] of prefixes) if (path.startsWith(prefix)) add(path, reason);
  }
  for (const ref of referenced) {
    const p = ref.replace(/^\/+/, '').replace(/^~\//, 'home/box/').replace(/^home\/box\/agent-data\//, 'home/box/sand-data/');
    if (entries[p]) add(p, 'referenced');
    else {
      // A referenced directory: take its files one level deep.
      const dir = p.endsWith('/') ? p : p + '/';
      for (const path of Object.keys(entries)) if (path.startsWith(dir) && !path.slice(dir.length).includes('/')) add(path, 'referenced');
    }
  }
  return [...picks.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Absolute box paths mentioned in text: /home/box/..., ~/... (box home). */
export function referencedBoxPaths(texts) {
  const found = new Set();
  for (const t of texts) {
    for (const m of String(t ?? '').matchAll(/(?:\/home\/box\/|\/workspace\/|~\/)[A-Za-z0-9._\-/]+[A-Za-z0-9_\-]/g)) {
      const p = m[0].startsWith('~/') ? '/home/box/' + m[0].slice(2) : m[0];
      if (!p.includes('..')) found.add(p);
    }
  }
  return [...found].sort();
}

function parseCron(schedule) {
  const s = str(schedule).trim();
  const m = /^CRON_TZ=(\S+)\s+(.+)$/.exec(s);
  return m ? { cron: m[2].trim(), timezone: m[1] } : { cron: s, timezone: null };
}

/** An automation record as a portable routine. Event triggers keep their listener details. */
export function normalizeAutomation(record) {
  const trigger = object(record.trigger) ? record.trigger : {};
  const schedule = str(trigger.schedule) || str(record.schedule);
  const isCron = trigger.type === 'cron' || (!!schedule && !trigger.listeners);
  const listeners = Array.isArray(trigger.listeners) ? trigger.listeners : [];
  const eventKinds = [...new Set(listeners.map((l) => str(l?.type)).filter(Boolean))];
  const { cron, timezone } = isCron ? parseCron(schedule) : { cron: '', timezone: null };
  return {
    id: str(record.id), name: str(record.name), prompt: str(record.prompt),
    enabled: record.isEnabled === true,
    trigger: isCron ? 'schedule' : (eventKinds.length === 1 ? eventKinds[0] : eventKinds.length ? 'other' : 'other'),
    scheduleCron: cron, timezone, scheduleText: str(record.triggerDescription),
    triggerDetails: isCron ? '' : JSON.stringify(listeners),
    lastRunAt: record.lastRunAt ?? null, nextRunAt: record.nextRunAt ?? null,
    runs: Array.isArray(record.runs) ? record.runs.length : 0,
    provenance: str(record.provenance), boxPath: str(record.filePath),
  };
}

/**
 * Capture one bot. `io` is injected so tests can run without a network:
 *   rpc(name, body) → JSON; presign(relPath) → url; fetchImpl
 *   onProgress(text)
 */
export async function captureBot(io, { agentId, timeZone = 'UTC', maxFileBytes = DEFAULT_MAX_FILE_BYTES, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES, now = () => new Date() }) {
  const progress = io.onProgress ?? (() => {});
  const coverage = {};
  const note = (area, status, detail = {}) => { coverage[area] = { status, ...detail }; };
  const attempt = async (area, fn, onError) => {
    try { return await fn(); } catch (error) {
      const message = String(error?.message ?? error).slice(0, 300);
      note(area, /403|permission/i.test(message) ? 'unavailable' : /404|not_found|not available/i.test(message) ? 'not-applicable' : 'failed', { reason: message });
      return onError;
    }
  };

  progress('roster');
  const roster = await io.rpc('ListGrokBotAgents', {});
  const row = (roster?.agents ?? []).find((a) => a?.agentId === agentId || a?.legacyAgentId === agentId);
  if (!row) throw new MigrationError('The selected bot is not in this login\'s roster.');
  const bot = {
    id: row.agentId, serverId: str(row.id), name: str(row.name), title: str(row.title),
    instructions: str(row.description), kind: row.kind === 'GROK_BOT_AGENT_KIND_ROOM' ? 'group' : 'bot',
    harness: str(row.harness), avatar: { shape: str(row.avatarShape), color: str(row.avatarColor) },
    createdAtMs: num(row.createdAtMs), updatedAtMs: num(row.updatedAtMs),
    members: Array.isArray(row.memberAgentIds) ? row.memberAgentIds : [],
  };
  note('identity', 'complete', { source: 'ListGrokBotAgents' });
  const groups = (roster?.agents ?? []).filter((a) => a?.kind === 'GROK_BOT_AGENT_KIND_ROOM' && (a.memberAgentIds ?? []).includes(agentId))
    .map((a) => ({ id: str(a.agentId), name: str(a.name), members: (a.memberAgentIds ?? []).map((m) => {
      const peer = (roster.agents ?? []).find((x) => x?.agentId === m);
      return { id: m, name: str(peer?.name) };
    }) }));
  note('groups', 'complete', { count: groups.length, note: groups.length ? 'Group chats are listed; their conversations belong to the group, not this bot.' : undefined });

  const blobReader = async (hashes) => {
    const out = new Map();
    for (let i = 0; i < hashes.length; i += BLOB_BATCH) {
      const batch = hashes.slice(i, i + BLOB_BATCH);
      const urls = await io.presignMany(batch.map((h) => 'blobs/' + h));
      await Promise.all(batch.map(async (h) => {
        const url = urls.get('blobs/' + h);
        if (!url) return;
        const { bytes } = await fetchStoreBytes(url, { cap: 64 * 1024 * 1024, fetchImpl: io.fetchImpl });
        if (sha256(bytes) === h) out.set(h, bytes);
      }));
    }
    return out;
  };

  progress('sessions');
  const sessions = await attempt('sessions', async () => {
    const r = await io.rpc('ListGrokBotAgentSessions', { agentId });
    const list = Array.isArray(r?.sessions) ? r.sessions : [];
    note('sessions', 'complete', { count: list.length });
    return list.map((s) => ({ sessionId: str(s.sessionId), kind: str(s.kind), createdAtMs: num(s.createdAtMs), lastActivityAtMs: num(s.lastActivityAtMs) }));
  }, []);

  const transcripts = [];
  for (const sessionId of ['', ...sessions.map((s) => s.sessionId).filter(Boolean)]) {
    progress('transcript ' + (sessionId || 'main'));
    const t = await attempt('transcript' + (sessionId ? ':' + sessionId : ''), () => readFullTranscript({ rpc: io.rpc, readBlobs: blobReader, agentId, sessionId }), null);
    if (t) transcripts.push({ sessionId, ...t });
  }
  const main = transcripts.find((t) => t.sessionId === '');
  if (main) {
    const messages = main.entries.filter((e) => e.message.role === 'user' || e.message.role === 'assistant').length;
    note('transcript', main.unreadable ? 'partial' : 'complete', {
      source: 'ListGrokBotTranscriptEntries (beforeSeq pagination)', rows: main.entries.length, messages,
      firstSeq: main.firstSeq, lastSeq: main.lastSeq, pages: main.pages, unreadableRows: main.unreadable,
      seqGaps: main.gaps.length, note: main.gaps.length ? 'Sequence numbers with no row (deleted, rolled back or never written); the API returns nothing for them.' : undefined,
    });
  }

  progress('automations');
  const automations = await attempt('automations', async () => {
    const r = await io.rpc('ListGrokBotAgentAutomations', { agentId, timeZone });
    const list = (r?.automations ?? []).map((a) => { try { return normalizeAutomation(JSON.parse(a.recordJson)); } catch { return null; } });
    note('automations', list.includes(null) ? 'partial' : 'complete', { count: list.filter(Boolean).length });
    return list.filter(Boolean);
  }, []);
  await attempt('routines', async () => {
    const r = await io.rpc('ListGrokBotAgentRoutines', { agentId, timeZone });
    note('routines', 'complete', { count: (r?.routines ?? []).length, note: 'Routines are listed with automations.' });
  });

  progress('tasks');
  const todos = await attempt('todos', async () => {
    const r = await io.rpc('ListGrokBotAgentTodos', { agentId });
    const list = (r?.todos ?? []).map((t) => ({ id: str(t.id), content: str(t.content), status: str(t.status).replace('TODO_STATUS_', '').toLowerCase(), createdAt: num(t.createdAt), updatedAt: num(t.updatedAt), dependencies: t.dependencies ?? [] }));
    note('todos', 'complete', { count: list.length, open: list.filter((t) => t.status === 'pending' || t.status === 'in_progress').length });
    return list;
  }, []);
  const tasks = await attempt('tasks', async () => {
    const a = await io.rpc('ListGrokBotAgentTasks', { agentId, includeRecentlyDone: true });
    const b = await io.rpc('ListGrokBotTasks', { agentId });
    const list = [...(a?.tasks ?? []).map((t) => ({ source: 'agent-task', ...t })), ...(b?.tasks ?? []).map((t) => ({ source: 'task', ...t }))];
    note('tasks', 'complete', { count: list.length });
    return list;
  }, []);
  const subagents = await attempt('subagents', async () => {
    const r = await io.rpc('ListGrokBotSubagents', { agentId });
    const list = (r?.subagents ?? []).map((a) => ({ id: str(a.id ?? a.subagentId), name: str(a.name ?? a.title), status: str(a.status ?? a.state) }));
    note('subagents', 'complete', { running: list.length });
    return list;
  }, []);

  progress('memory (server)');
  const serverMemories = await attempt('serverMemories', async () => {
    const r = await io.rpc('ListGrokBotUserBotMemories', { agentId });
    const list = (r?.memories ?? []).map((m) => ({ id: str(m.factId), text: str(m.text), learnedAtMs: num(m.learnedAtMs) }));
    note('serverMemories', 'complete', { count: list.length });
    return list;
  }, []);
  if (coverage.serverMemories?.status === 'unavailable') coverage.serverMemories.note = 'Team-bot memory API only; personal bot memory is read from the box store below.';

  progress('skills');
  const serverSkills = await attempt('serverSkills', async () => {
    const r = await io.rpc('ListGrokBotAgentSkills', { agentId });
    const list = (r?.skills ?? []).map((s) => ({ id: str(s.id), name: str(s.name), description: str(s.description), body: str(s.body), source: str(s.source) }));
    note('serverSkills', 'complete', { count: list.length });
    return list;
  }, []);

  const plugins = await attempt('connectors', async () => {
    const r = await io.rpc('GetGrokBotAgentPlugins', { agentId, includeMcpConfig: false });
    const list = (r?.plugins ?? []).map((p) => ({ id: String(p.pluginId ?? ''), name: str(p.displayName) || str(p.name), description: str(p.description), installMode: str(p.installMode), mcpServers: p.mcpServerNames ?? [] }));
    note('connectors', 'complete', { count: list.length, note: 'Connector logins and OAuth grants stay in Grok Bot; they cannot be exported.' });
    return list;
  }, []);
  const library = await attempt('libraryDocs', async () => {
    const r = await io.rpc('ListGrokBotLibraryDocs', { agentId });
    const list = (r?.docs ?? []).map((d) => ({ title: str(d.title), url: str(d.url), provider: str(d.provider), kind: str(d.kind) }));
    note('libraryDocs', 'complete', { count: list.length });
    return list;
  }, []);
  const serverFiles = await attempt('serverFiles', async () => {
    let pageToken = '';
    const list = [];
    do {
      const r = await io.rpc('ListGrokBotAgentFiles', { agentId, pageToken });
      for (const f of r?.files ?? []) list.push({ path: str(f.path ?? f.relPath ?? f.name), size: num(f.size ?? f.sizeBytes) });
      pageToken = str(r?.nextPageToken);
    } while (pageToken);
    note('serverFiles', 'complete', { count: list.length, note: list.length ? 'Listed only; agent files live in the box store and are captured from there.' : undefined });
    return list;
  }, []);

  progress('box store manifest');
  const files = [];
  const skipped = [];
  const store = await attempt('boxStore', () => readStoreManifest({ presign: io.presign, fetchImpl: io.fetchImpl }), null);
  if (store) {
    const texts = [bot.instructions, ...automations.map((a) => a.prompt), ...todos.map((t) => t.content),
      ...(main?.entries ?? []).filter((e) => e.message.role !== 'event').map((e) => e.message.text)];
    // Skills are shared by every bot of the login (Grok Bot docs), so the whole user skill library
    // travels with the bot. Platform-owned managed/plugin skills are not the user's and stay.
    const skillDirs = new Set();
    for (const path of Object.keys(store.entries)) {
      const m = /^home\/box\/sand-data\/workflows\/([^/.][^/]*)\/SKILL\.md$/.exec(path);
      if (m) skillDirs.add(m[1]);
    }
    const memoryTexts = [];
    // Projects this bot joined (agents/<id>/projects.json); their shared memory travels with it.
    let projects = [];
    const pjPath = `home/box/sand-data/agents/${agentId}/projects.json`;
    const pj = store.entries[pjPath];
    // Read only what selection would also allow (same credential rules, same bytes rule).
    if (pj?.kind === 'file' && SHA_RE.test(str(pj.sha)) && selectBoxFiles({ [pjPath]: pj, ...secretEntries(store.entries) }, { agentId, referenced: ['/' + pjPath] }).length) {
      const got = (await blobReader([pj.sha])).get(pj.sha);
      try {
        const parsed = JSON.parse(got?.toString('utf8') ?? 'null');
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.projects) ? parsed.projects : Array.isArray(parsed?.joined) ? parsed.joined : [];
        projects = list.map((p) => (typeof p === 'string' ? p : str(p?.slug))).filter((p) => /^[A-Za-z0-9._-]+$/.test(p));
      } catch { /* unreadable projects.json: reported below as no projects */ }
    }
    const picks0 = selectBoxFiles(store.entries, { agentId, skillDirs: [...skillDirs], projects });
    const picks = selectBoxFiles(store.entries, { agentId, skillDirs: [...skillDirs], projects, referenced: referencedBoxPaths(texts) });
    let total = 0;
    const toRead = [];
    for (const p of picks) {
      const e = p.entry;
      if (e.kind === 'symlink') { files.push({ boxPath: '/' + p.path, reason: p.reason, kind: 'symlink', target: str(e.target) }); continue; }
      if (e.kind !== 'file' || !SHA_RE.test(str(e.sha))) { skipped.push({ boxPath: '/' + p.path, reason: 'not a regular file' }); continue; }
      if (e.size > maxFileBytes) { skipped.push({ boxPath: '/' + p.path, reason: `larger than ${maxFileBytes} bytes (${e.size})`, size: e.size }); continue; }
      if (total + e.size > maxTotalBytes) { skipped.push({ boxPath: '/' + p.path, reason: 'total size budget reached', size: e.size }); continue; }
      total += e.size;
      toRead.push(p);
    }
    progress(`box files (${toRead.length})`);
    const blobs = await blobReader([...new Set(toRead.map((p) => p.entry.sha))]);
    for (const p of toRead) {
      const bytes = blobs.get(p.entry.sha);
      if (!bytes) { skipped.push({ boxPath: '/' + p.path, reason: 'blob unreadable or digest mismatch' }); continue; }
      if (bytes.length !== p.entry.size) { skipped.push({ boxPath: '/' + p.path, reason: `size ${bytes.length} differs from the manifest (${p.entry.size})` }); continue; }
      files.push({ boxPath: '/' + p.path, reason: p.reason, kind: 'file', size: bytes.length, sha256: p.entry.sha, mode: p.entry.mode ?? null, bytes });
      if (p.path.includes('/memory/') && p.path.endsWith('.md')) memoryTexts.push(bytes.toString('utf8'));
    }
    // Second pass: paths the bot's own memory names (scripts, config) are "necessary files" too.
    const memoryRefs = referencedBoxPaths(memoryTexts).filter((r) => !picks.some((p) => '/' + p.path === r));
    if (memoryRefs.length) {
      const have = new Set([...files.map((f) => f.boxPath), ...skipped.map((x) => x.boxPath)]);
      const extra = [];
      for (const p of selectBoxFiles(store.entries, { agentId: '\0', referenced: memoryRefs })) {
        if (have.has('/' + p.path) || p.path.startsWith('home/box/sand-data/user-memory/')) continue;
        const e = p.entry;
        if (e.kind !== 'file' || !SHA_RE.test(str(e.sha))) { skipped.push({ boxPath: '/' + p.path, reason: 'not a regular file' }); continue; }
        if (e.size > maxFileBytes) { skipped.push({ boxPath: '/' + p.path, reason: `larger than ${maxFileBytes} bytes (${e.size})`, size: e.size }); continue; }
        if (total + e.size > maxTotalBytes) { skipped.push({ boxPath: '/' + p.path, reason: 'total size budget reached', size: e.size }); continue; }
        total += e.size;
        extra.push(p);
      }
      const extraBlobs = await blobReader([...new Set(extra.map((p) => p.entry.sha))]);
      for (const p of extra) {
        const bytes = extraBlobs.get(p.entry.sha);
        if (!bytes) { skipped.push({ boxPath: '/' + p.path, reason: 'blob unreadable or digest mismatch' }); continue; }
        if (bytes.length !== p.entry.size) { skipped.push({ boxPath: '/' + p.path, reason: `size ${bytes.length} differs from the manifest (${p.entry.size})` }); continue; }
        files.push({ boxPath: '/' + p.path, reason: 'referenced-by-memory', kind: 'file', size: bytes.length, sha256: p.entry.sha, mode: p.entry.mode ?? null, bytes });
      }
    }
    const refs = referencedBoxPaths(texts);
    const credentialRefs = refs.filter((r) => isSecretPath(r.replace(/^\/+/, '')));
    for (const r of credentialRefs) skipped.push({ boxPath: r, reason: 'credential path; never exported (sign in again on the destination)' });
    const unresolved = refs.filter((r) => !credentialRefs.includes(r) && !files.some((f) => f.boxPath === r || f.boxPath.startsWith(r + '/') || f.boxPath === r.replace('/home/box/agent-data/', '/home/box/sand-data/')) && !skipped.some((s) => s.boxPath === r));
    note('boxStore', skipped.length || unresolved.length ? 'partial' : 'complete', {
      source: 'box store manifest', manifestUpdatedAtMs: store.updatedAtMs, manifestBytes: store.bytes,
      captured: files.length, skipped: skipped.length, botFiles: picks0.length, projects,
      unresolvedReferences: unresolved, credentialReferences: credentialRefs.length,
    });
  }

  const memory = files.filter((f) => f.kind === 'file' && /\/(memory|user-memory)\//.test(f.boxPath) && f.boxPath.endsWith('.md'));
  note('memory', memory.length ? 'complete' : (store ? 'empty' : 'failed'), {
    source: 'box store: own memory/, shared user-memory/ (every assistant\'s shard), joined projects',
    own: memory.filter((f) => f.boxPath.includes(`/agents/${agentId}/memory/`)).length,
    sharedUser: memory.filter((f) => f.boxPath.includes('/user-memory/')).length,
    project: memory.filter((f) => f.boxPath.includes('/projects/')).length,
  });

  return {
    format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, capturedAt: now().toISOString(),
    source: { platform: 'grok-bot', harness: bot.harness },
    bot, groups, sessions, transcripts, automations, todos, tasks, subagents, serverMemories, serverSkills,
    connectors: plugins, library, serverFiles, files, skipped, coverage,
  };
}
