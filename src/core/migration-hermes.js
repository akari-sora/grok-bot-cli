/**
 * Hermes destination for an archive v2 bot: one bot → one new Hermes profile.
 *
 * Mapping (each item is planned, applied idempotently, read back and reported):
 *   instructions            → SOUL.md (only over Hermes' exact seeded default)
 *   memory/profile.md       → USER.md entries   (Hermes MemoryStore: format, threat scan, limits)
 *   memory/log/*.md         → MEMORY.md entries, plus server memories, migration notes and open tasks
 *   skill library           → skills/grok-bot-imports/<slug>/ (every file of the skill)
 *   scheduled automations   → `hermes cron create --paused` jobs (Grok keeps its own copy; with
 *                             --move-routines they are active and the Grok copy is paused after verify)
 *   event automations       → workspace notes (no Hermes event trigger for GitHub/Slack listeners)
 *   main + side transcripts → Hermes sessions via SessionDB.import_foreign_history (searchable)
 *   box files               → <profile>/workspace/grok-bot/grok-box/<box path>
 * Everything else that was captured is listed in notMigrated with the reason. Token-shaped secrets
 * are redacted; an item that still holds one (an encoded token, a binary file) is left out.
 * Commands run without a shell. Nothing is sent to a model until `accept`.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { MigrationError, parseBytes, regularBytes } from './migration.js';
import { selectRoutines } from './migration-capture.js';
import { HERMES_HELPER } from './migration-hermes-helper.js';
import { assertNoSecrets, isText, sanitize, sanitizeBytes } from './migration-redact.js';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEFAULT_MEMORY_LIMIT = 2200;
const DEFAULT_USER_LIMIT = 1375;
const ENTRY_DELIMITER = '\n§\n';
const HISTORY_SESSION_BYTES = 4 * 1024 * 1024;
const HISTORY_SESSION_MESSAGES = 9000;
// At most 3 MiB as JSON even when every UTF-16 unit is escaped (\u0000): one part fits one session.
const HISTORY_PART_CHARS = 512 * 1024;
const SKILL_CATEGORY = 'grok-bot-imports';
const PREVIEW_LIST = 10;
const MARKER = '.gbot-migration.json';
const RUNTIME_MARKER = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SECRET_REASON = 'holds an encoded token-shaped value that cannot be redacted in place';
const SECRET_ALT = 'remove the secret in Grok Bot, or copy the item by hand from the private archive';
const UNSAFE_REASON = 'unsafe destination path (empty, ".", ".." segment, NUL or backslash, or outside its folder)';

/** Run a command without a shell. Resolves {code, stdout, stderr}. */
export function defaultExec(cmd, args, { input, env, timeoutMs = 600_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => { clearTimeout(timer); reject(new MigrationError(`Could not run ${cmd}: ${e.code ?? e.message}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 124 : 1), stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.end(input ?? '');
  });
}

export function profileNameFor(bot) {
  const ascii = String(bot.name ?? '').split(' · ')[0].normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const name = ('grok-' + (ascii.length >= 2 ? ascii : bot.id.slice(0, 8))).slice(0, 48).replace(/-+$/, '');
  if (!PROFILE_ID_RE.test(name)) throw new MigrationError('Could not derive a Hermes profile name; pass --profile.');
  return name;
}

/** Bullet lines of a Grok memory markdown file (HTML comments and headings dropped). */
export function memoryEntries(markdown) {
  const text = String(markdown).replace(/<!--[\s\S]*?-->/g, '');
  const bullets = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).filter(Boolean);
  if (bullets.length) return bullets;
  const body = text.split('\n').filter((l) => !/^#/.test(l.trim())).join('\n').trim();
  return body ? [body] : [];
}

const limitFor = (entries, base) => {
  const need = entries.reduce((n, e) => n + e.length, 0) + Math.max(0, entries.length - 1) * ENTRY_DELIMITER.length;
  return need <= base ? base : Math.ceil(need * 1.25 / 100) * 100;
};

/** sha256 over role, byte length and text of each message: the helper computes the same from Hermes. */
function historyDigest(messages) {
  const h = createHash('sha256');
  for (const m of messages) h.update(`${m.role}\n${Buffer.byteLength(m.content)}\n${m.content}\n`);
  return h.digest('hex');
}

/** A message larger than one import session, as consecutive messages marked with their part. */
function splitMessage(m) {
  if (Buffer.byteLength(JSON.stringify(m)) <= HISTORY_SESSION_BYTES) return [m];
  const pieces = [];
  for (let at = 0; at < m.content.length;) {
    let end = Math.min(m.content.length, at + HISTORY_PART_CHARS);
    const unit = m.content.charCodeAt(end - 1);
    if (end < m.content.length && unit >= 0xd800 && unit <= 0xdbff) end--; // keep a surrogate pair whole
    pieces.push(m.content.slice(at, end));
    at = end;
  }
  return pieces.map((content, i) => ({ ...m, content: `[Grok Bot message, part ${i + 1}/${pieces.length}]\n${content}` }));
}

function historySessions(messages, title, foreignId) {
  const parts = [];
  let current = [], bytes = 0;
  for (const m of messages) {
    const size = Buffer.byteLength(JSON.stringify(m));
    if (current.length && (bytes + size > HISTORY_SESSION_BYTES || current.length >= HISTORY_SESSION_MESSAGES)) { parts.push(current); current = []; bytes = 0; }
    current.push(m); bytes += size;
  }
  if (current.length) parts.push(current);
  return parts.map((msgs, i) => ({
    title: parts.length > 1 ? `${title} (part ${i + 1}/${parts.length})` : title,
    foreign_id: `${foreignId}:${i + 1}`,
    messages: msgs,
    digest: historyDigest(msgs),
  }));
}

/** `root`/`rel` for a relative posix path without empty, `.` or `..` segments, NUL or backslash; null when it would leave `root`. */
function within(root, rel) {
  const parts = String(rel).split('/');
  if (/[\0\\]/.test(rel) || parts.some((p) => !p || p === '.' || p === '..')) return null;
  const base = resolve(root);
  const path = resolve(base, ...parts);
  return path.startsWith(base.endsWith(sep) ? base : base + sep) ? path : null;
}

const skillName = (s) => /^---[\s\S]*?\nname:\s*["']?([^\n"']+)["']?\s*\n/.exec(s.files.find((f) => f.rel === 'SKILL.md')?.bytes.toString('utf8') ?? '')?.[1]?.trim() ?? s.slug;

/**
 * Pure plan from an opened archive. `profileDir` is where the profile lives (or will live).
 * @param {ReturnType<import('./migration-archive.js').openArchive>} archive
 */
export function buildHermesPlan(archive, { profile, profileDir, skills = 'all', activateRoutines = false, moveRoutines = false, routines: only, now = () => new Date() }) {
  const cap = archive.capture;
  if (cap.bot.kind !== 'bot') throw new MigrationError('Only a bot (not a group) can become a Hermes profile.');
  const notMigrated = [];
  const omit = (item, reason, alternative) => notMigrated.push({ item, reason, alternative });
  // Token-shaped secrets stay in the private archive only. A value that still holds one after
  // redaction (an encoded token) is left out and reported under `item`.
  let redactedSecrets = 0;
  const clean = (value, item) => {
    const r = sanitize(value);
    redactedSecrets += r.count;
    if (r.clean) return r.text;
    if (item) omit(item, SECRET_REASON, SECRET_ALT);
    return null;
  };
  // A destination path must hold no token and stay inside its root.
  const destFor = (root, rel, item) => {
    const r = sanitize(rel);
    if (!r.clean || r.count) { omit(item, 'its path holds a token-shaped value', SECRET_ALT); return null; }
    const dest = within(root, rel);
    if (!dest) omit(item, UNSAFE_REASON, 'nothing was written; check the box path in the archive');
    return dest;
  };
  const cleanFile = (row, item) => {
    const r = sanitizeBytes(archive.read(row.path));
    redactedSecrets += r.count;
    if (r.clean) return r;
    omit(item, r.text ? SECRET_REASON : 'binary file with a token-shaped value inside; binary bytes cannot be redacted', SECRET_ALT);
    return null;
  };

  const botName = clean(cap.bot.name, 'bot name') ?? `Grok bot ${cap.bot.id.slice(0, 8)}`;
  const title = clean(cap.bot.title, 'bot title') ?? '';
  const instructions = clean(cap.bot.instructions, 'bot instructions (role)') ?? '';
  const name = profile ?? profileNameFor({ ...cap.bot, name: botName });
  if (!PROFILE_ID_RE.test(name) || name === 'default') throw new MigrationError('Invalid Hermes profile name.');
  const base = join(profileDir, 'workspace', 'grok-bot');
  const boxRoot = join(base, 'grok-box');
  const date = now().toISOString().slice(0, 10);
  const archivePath = sanitize(archive.root);
  const historyPath = archivePath.clean && !archivePath.count ? archive.root : 'grok-bot-archive';

  // Memory files are redacted whole, then split into entries.
  const memFiles = cap.box.filter((b) => b.kind === 'file' && b.boxPath.endsWith('.md') && /\/(memory|user-memory)\//.test(b.boxPath));
  const user = [], memory = [];
  for (const f of memFiles.sort((a, b) => a.boxPath.localeCompare(b.boxPath))) {
    // Bytes first: a memory file in another encoding (UTF-16) is checked as such, not decoded blindly.
    const bytes = archive.read(f.path);
    const raw = sanitizeBytes(bytes);
    if (!raw.text) { omit(f.boxPath, raw.clean ? 'not UTF-8 text' : 'holds a token-shaped value that cannot be removed in place', 'kept only in the private archive'); continue; }
    const r = sanitize(bytes.toString('utf8'));
    redactedSecrets += r.count;
    const into = /\/memory\/profile\.md$/.test(f.boxPath) || f.boxPath.includes('/user-memory/') ? user : memory;
    for (const e of memoryEntries(r.text)) { const c = clean(e, `a memory entry in ${f.boxPath}`); if (c !== null) into.push(c); }
  }
  for (const m of cap.serverMemories ?? []) {
    const c = clean(m.text, `server memory ${m.id}`);
    if (c && !memory.includes(c)) memory.push(c);
  }

  // Main conversation first, then each side conversation: one Hermes session (or several parts) each.
  const docs = new Map();
  const history = [];
  const transcripts = [...cap.transcripts.filter((t) => t.sessionId === ''), ...cap.transcripts.filter((t) => t.sessionId !== '')];
  let side = 0, mainCount = 0, span = 'unknown dates', mainTitle = `Grok Bot · ${botName} · history`;
  for (const t of transcripts) {
    const main = t.sessionId === '';
    const key = basename(t.path, '.jsonl');
    const label = main ? 'the main conversation' : `side conversation ${++side}`;
    const messages = [];
    let other = 0, held = 0;
    for (const m of archive.transcript(t)) {
      if ((m.role !== 'user' && m.role !== 'assistant') || !m.text) { other++; continue; }
      const content = clean(m.text);
      if (content === null) { held++; continue; }
      messages.push({ role: m.role, content, ...(m.timestampMs ? { timestamp: m.timestampMs / 1000 } : {}) });
    }
    if (other) omit(`${other} row(s) of ${label} that are not user or assistant text`, 'tool calls and system events are not chat turns; Hermes sessions hold user and assistant messages', 'they stay in the private archive (transcript/*.raw.jsonl)');
    if (held) omit(`${held} message(s) of ${label}`, SECRET_REASON, SECRET_ALT);
    if (t.unreadable) omit(`${t.unreadable} unreadable row(s) of ${label}`, 'the Grok Bot server could not return them', 'capture again');
    let split = 0;
    const imported = messages.flatMap((m) => { const parts = splitMessage(m); if (parts.length > 1) split++; return parts; });
    if (split) omit(`${split} message(s) of ${label} larger than one Hermes import`, 'split into consecutive messages marked "[Grok Bot message, part i/n]"', `the whole text is in ${join(base, 'history', key + '.md')}`);
    const sessionTitle = `Grok Bot · ${botName} · ${main ? 'history' : label}`;
    history.push(...historySessions(imported, sessionTitle, `${cap.bot.id}:${main ? 'main' : key}`));
    docs.set(join(base, 'history', key + '.md'), Buffer.from(`# ${sessionTitle}\n\n` + messages.map((m) =>
      `## ${m.role === 'user' ? 'You' : 'Bot'} · ${m.timestamp ? new Date(m.timestamp * 1000).toISOString() : 'time unknown'}\n\n${m.content}\n`).join('\n')));
    if (main) {
      mainCount = messages.length;
      mainTitle = history.find((s) => s.foreign_id.startsWith(`${cap.bot.id}:main:`))?.title ?? mainTitle;
      const stamps = messages.filter((m) => m.timestamp).map((m) => new Date(m.timestamp * 1000).toISOString().slice(0, 10));
      if (stamps.length) span = `${stamps[0]} to ${stamps.at(-1)}`;
    }
  }

  const open = [];
  for (const t of cap.todos) {
    if (t.status !== 'pending' && t.status !== 'in_progress') continue;
    const content = clean(t.content, `open task ${t.id}`);
    if (content !== null) open.push({ id: t.id, status: t.status, content });
  }
  const finished = cap.todos.filter((t) => t.status !== 'pending' && t.status !== 'in_progress').length;
  if (finished) omit(`${finished} finished todo(s)`, 'only open tasks are carried over', 'they stay in the private archive (capture.json)');

  const skillRoot = join(profileDir, 'skills', SKILL_CATEGORY);
  const skillDirs = new Map();
  for (const b of cap.box.filter((x) => x.reason === 'skill' && x.kind === 'file')) {
    const m = /^\/home\/box\/sand-data\/workflows\/([^/]+)\/(.+)$/.exec(b.boxPath);
    if (!m) continue;
    if (!skillDirs.has(m[1])) skillDirs.set(m[1], []);
    skillDirs.get(m[1]).push({ rel: m[2], ...b });
  }
  const skillPlan = [];
  for (const [slug, rows] of skills === 'none' ? [] : skillDirs) {
    if (!rows.some((f) => f.rel === 'SKILL.md')) continue;
    const dir = destFor(skillRoot, slug, `skill folder "${slug}"`);
    if (!dir) continue;
    const files = [];
    for (const f of rows) {
      const dest = destFor(dir, f.rel, `skill file ${f.boxPath}`);
      const r = dest && cleanFile(f, `skill file ${f.boxPath}`);
      if (r) files.push({ ...f, dest, bytes: r.bytes, redacted: r.count });
    }
    if (!files.some((f) => f.rel === 'SKILL.md')) { omit(`skill "${slug}"`, 'its SKILL.md was left out (see above)', SECRET_ALT); continue; }
    skillPlan.push({ slug, dir, files, pristine: files.length === rows.length && files.every((f) => !f.redacted) });
  }

  const pathNote = `[Migrated from Grok Bot "${botName}". Box paths /home/box/... now live under ${boxRoot}/home/box/... . CLI logins that existed on the Grok box (for example glab, gh) must exist on this machine.]\n\n`;
  const cron = [], unscheduled = [], routines = [];
  const zones = new Set();
  // Created active: the routines on in Grok Bot with --activate-routines / --move-routines (only those named with --routines).
  const active = new Set(activateRoutines || moveRoutines ? selectRoutines(cap.automations, only) : []);
  for (const a of cap.automations) {
    const routine = clean(a.name, `routine ${a.id}`);
    const prompt = routine === null ? null : clean(a.prompt, `routine "${routine}"`);
    const details = prompt === null ? null : clean(a.triggerDetails, `routine "${routine}"`);
    if (details === null) continue;
    routines.push({ name: routine, instruction: prompt, trigger: a.trigger, schedule_cron: a.scheduleCron, schedule_text: clean(a.scheduleText) ?? '',
      timezone: a.timezone ?? '', paused: !a.enabled, skills: [], trigger_details: details });
    if (a.trigger === 'schedule' && a.scheduleCron) {
      if (a.timezone) zones.add(a.timezone);
      // The source id in the name finds this job again on a re-run, whatever else shares its name.
      const tag = `[grok-bot ${a.id || sha256(a.name).slice(0, 12)}]`;
      cron.push({ name: `${botName}: ${routine} ${tag}`, routine, tag, schedule: a.scheduleCron, timezone: a.timezone, prompt: pathNote + prompt,
        paused: !active.has(a), sourceEnabled: a.enabled, sourceId: a.id });
    } else unscheduled.push({ name: routine, prompt, trigger: a.trigger, enabled: a.enabled, triggerDetails: details });
  }
  const timezone = zones.size === 1 ? [...zones][0] : null;

  const notes = [
    `Migrated from Grok Bot "${botName}" on ${date}. Files from the Grok box are under ${boxRoot}; a path /home/box/X in older instructions or routines now means ${boxRoot}/home/box/X.`,
    `The full Grok Bot conversation (${mainCount} messages, ${span}) is imported as the Hermes session "${mainTitle}"; use session_search to recall it. A readable copy is ${join(base, 'history', 'main.md')}.`,
  ];
  if (side) notes.push(`${side} side conversation(s) from Grok Bot are imported as Hermes sessions titled "Grok Bot · ${botName} · side conversation N"; readable copies are in ${join(base, 'history')}.`);
  for (const t of open) notes.push(`Open task carried over from Grok Bot (${t.status}, id ${t.id}): ${t.content}`);
  if (cron.length) notes.push(`Grok Bot routines migrated as Hermes cron jobs (${cron.every((c) => c.paused) ? 'all created paused' : 'see hermes cron list'}): ${cron.map((c) => `"${c.routine}" (${c.schedule}${c.timezone ? ' ' + c.timezone : ''}, ${c.paused ? 'paused' : 'active'})`).join('; ')}. ${moveRoutines
    ? 'The active ones replace their Grok Bot copies, which the migration pauses in Grok Bot once this profile is verified.'
    : 'Resume one only after turning it off in Grok Bot, so it does not run twice.'}`);
  if (unscheduled.length) notes.push(`Event-triggered Grok Bot routines not scheduled in Hermes: ${unscheduled.map((a) => `"${a.name}" (${a.trigger})`).join('; ')}. Their prompts are in ${join(base, 'routines-not-scheduled.md')}.`);
  if (zones.size > 1) notes.push('Grok routines used several time zones; Hermes cron uses one profile time zone. Check each job schedule.');
  const memoryAll = [...memory, ...notes];
  // Used instead of SOUL.md when the user customized theirs.
  const roleEntry = instructions.trim() ? `Grok Bot role for ${botName}: ${instructions}` : null;

  const files = [];
  for (const b of cap.box) {
    if (b.kind === 'symlink') { omit(b.boxPath, `symlink to ${b.target}; links are not recreated`, 'recreate it on this machine if it is still needed'); continue; }
    if (b.kind !== 'file') continue;
    const dest = destFor(boxRoot, b.boxPath.replace(/^\//, ''), b.boxPath);
    const r = dest && cleanFile(b, b.boxPath);
    if (r) files.push({ ...b, dest, bytes: r.bytes, redacted: r.count, destSha256: r.count ? sha256(r.bytes) : b.sha256 });
  }
  docs.set(join(base, 'AGENTS.md'), Buffer.from(`# Migrated Grok Bot workspace: ${botName}\n\n${notes[0]}\n\nOpen tasks:\n${open.map((t) => `- ${t.content}`).join('\n') || '- none'}\n`));
  if (unscheduled.length) {
    docs.set(join(base, 'routines-not-scheduled.md'), Buffer.from(`# Grok Bot routines with event triggers\n\nHermes cron runs on a schedule; these were triggered by events in Grok Bot (GitHub, Slack, ...), so they were not created as cron jobs. Their full prompts are below.\n\n` +
      unscheduled.map((a) => `## ${a.name}\n\n- Trigger: ${a.trigger}\n- Was enabled in Grok Bot: ${a.enabled}\n- Listeners: \`${a.triggerDetails}\`\n\n${a.prompt}\n`).join('\n')));
  }
  const connectors = cap.connectors.map((c) => clean(c.name)).filter((n) => n !== null);
  docs.set(join(base, 'grok-bot-export.json'), Buffer.from(JSON.stringify({ format: 'grok-bot-export', version: 1, bots: [{
    name: botName, title, instructions, memories: memory, user_facts: user,
    // The official importer copies a folder given as `path`: only skill folders whose archive copy needed no redaction.
    skills: historyPath === archive.root ? skillPlan.filter((s) => s.pristine)
      .map((s) => ({ name: s.slug, path: join(archive.root, ...dirname(s.files.find((f) => f.rel === 'SKILL.md').path).split('/')) })) : [],
    routines, apps: connectors.map((c) => ({ name: c, mcp_url: '' })),
  }] }, null, 2) + '\n'));

  // Everything else that was captured, with the reason it does not become part of the profile.
  for (const a of unscheduled) omit(`routine "${a.name}"`, `event trigger (${a.trigger}); Hermes cron has no ${a.trigger} event source`, `prompt kept in ${join(base, 'routines-not-scheduled.md')}; run it on a schedule or from a webhook`);
  for (const s of cap.skipped) omit(s.boxPath, s.reason,
    /credential/.test(s.reason) ? 'sign in to that service on this machine (the file holds a login)' : /larger than/.test(s.reason) ? 'capture again with a higher --max-file-mb' : 'capture again');
  for (const c of cap.connectors) omit(`connector "${c.name}"`, 'OAuth grants cannot leave Grok Bot', 'connect the same app in Hermes (hermes mcp / hermes setup)');
  omit('Grok Bot platform skills (managed/plugin)', 'owned by the Grok Bot platform', 'Hermes bundled skills cover similar tasks');
  const mappedSkills = new Set(skillPlan.flatMap((s) => [s.slug, skillName(s)]));
  for (const s of cap.serverSkills ?? []) {
    if (!mappedSkills.has(s.name)) omit(`skill "${s.name}"`, /managed|plugin/.test(s.source) ? 'owned by the Grok Bot platform' : 'listed by the server without a folder in the box store', 'its text is kept in the private archive (capture.json)');
  }
  if (cap.tasks?.length) omit(`${cap.tasks.length} Grok Bot task record(s)`, 'task runs are Grok Bot platform state; Hermes has no import for them', 'they stay in the private archive (capture.json); open todos are carried over as memory notes');
  // Older archives only counted subagents and server files in coverage.
  const subagents = cap.subagents ?? [], subagentCount = subagents.length || (cap.coverage.subagents?.running ?? 0);
  if (subagentCount) omit(`${subagentCount} Grok Bot subagent(s)${subagents.length ? ': ' + subagents.map((x) => x.name || x.id).join(', ') : ''}`, 'Grok Bot subagents have no Hermes equivalent', 'they stop with Grok Bot; Hermes starts its own subagents when needed');
  if (cap.library?.length) omit(`${cap.library.length} library document(s): ${cap.library.map((d) => d.title).join(', ')}`, 'documents stay with their provider; Grok Bot library links cannot be reconnected from here', 'connect the provider in Hermes (hermes mcp); titles and URLs are in the private archive (capture.json)');
  const serverFileCount = (cap.serverFiles ?? []).length || (cap.coverage.serverFiles?.count ?? 0);
  if (serverFileCount) omit(`${serverFileCount} file(s) in the Grok Bot file list`, 'the server file list is a listing only', `the files come from the box store and are under ${boxRoot}`);
  for (const r of cap.coverage.boxStore?.unresolvedReferences ?? []) omit(r, 'named by the bot but not in the box store', 'nothing to copy; recreate it if it is still needed');
  for (const g of cap.groups ?? []) omit(`group chat "${g.name}"`, 'a group is shared by several bots', 'migrate its members too; each becomes a Hermes profile, and profiles can work together on the Hermes kanban board');
  omit('teammates (other Grok bots it could message)', 'each bot is its own agent', 'migrate them too; each becomes a Hermes profile');
  for (const [area, c] of Object.entries(cap.coverage)) {
    if (c.status === 'failed') omit(area, 'source read failed: ' + (c.reason ?? ''), 'capture again');
    else if (c.status === 'unavailable') omit(area, 'not readable with this login: ' + (c.reason ?? '') + (c.note ? ` (${c.note})` : ''), 'capture again with a login that can read it');
  }
  const shown = (v) => { const r = sanitize(v); return r.clean ? r.text : '[withheld: holds an encoded token-shaped value]'; };

  return {
    target: 'hermes', profile: name, profileDir, base, boxRoot, timezone, botId: cap.bot.id, botName, historyPath,
    soul: `# ${botName}\n\nYou are ${botName}${title ? ' (' + title + ')' : ''}, migrated from Grok Bot to Hermes. Introduce yourself by this name and keep this role.\n\n${instructions.trim()}\n`,
    roleEntry, user, memory: memoryAll,
    limits: { memory: limitFor(roleEntry ? [roleEntry, ...memoryAll] : memoryAll, DEFAULT_MEMORY_LIMIT), user: limitFor(user, DEFAULT_USER_LIMIT) },
    skills: skillPlan, cron, unscheduled: unscheduled.map((a) => a.name), history, files, docs,
    notMigrated: notMigrated.map((n) => ({ item: shown(n.item), reason: shown(n.reason), alternative: shown(n.alternative) })),
    open: open.map((t) => ({ id: t.id, content: t.content })),
    redactedSecrets,
  };
}

/** Last gate before anything is written or run: no token-shaped value anywhere in the plan. */
function assertPlanClean(plan) {
  const { files, skills, docs, ...rest } = plan;
  assertNoSecrets(JSON.stringify(rest), 'the Hermes plan');
  const text = (bytes) => bytes.toString(isText(bytes) ? 'utf8' : 'latin1');
  for (const f of [...files, ...skills.flatMap((s) => s.files)]) assertNoSecrets(f.dest + '\n' + text(f.bytes), f.dest);
  for (const [path, bytes] of docs) assertNoSecrets(path + '\n' + text(bytes), path);
}

/** Collapse many files skipped for the same reason into one line for the terminal. */
export function groupNotMigrated(items) {
  const big = items.filter((n) => /^larger than/.test(n.reason));
  const cred = items.filter((n) => /credential path/.test(n.reason));
  const rest = items.filter((n) => !big.includes(n) && !cred.includes(n));
  const out = [...rest];
  if (big.length) {
    const sizes = big.map((n) => Number(/\((\d+)\)/.exec(n.reason)?.[1] ?? 0));
    out.push({ item: `${big.length} large file(s), up to ${Math.ceil(Math.max(...sizes) / 1048576)} MiB`, reason: 'over the --max-file-mb limit', alternative: big[0].alternative });
  }
  if (cred.length) out.push({ item: `${cred.length} credential path(s) (${[...new Set(cred.map((n) => n.item.replace(/^\/home\/box\//, '~/').split('/').slice(0, 3).join('/')))].join(', ')})`, reason: 'logins are never exported', alternative: cred[0].alternative });
  return out;
}

/** Human summary of a plan (the "檢查差異" step). */
export function summarizeHermesPlan(plan, destination) {
  const lines = [
    `Destination: Hermes profile "${plan.profile}" (${destination.profileExists ? 'EXISTS — items already present are skipped' : 'new'}) at ${plan.profileDir}`,
    `  Role       → SOUL.md (${plan.soul.length} chars)`,
    `  User facts → USER.md: ${plan.user.length} entries (limit ${plan.limits.user})`,
    `  Memory     → MEMORY.md: ${plan.memory.length} entries incl. ${plan.open.length} open task(s) (limit ${plan.limits.memory})`,
    `  Skills     → ${plan.skills.length} skill folder(s) under skills/${SKILL_CATEGORY}/`,
    `  Schedules  → ${plan.cron.length} cron job(s), ${plan.cron.filter((c) => c.paused).length} created paused${plan.timezone ? `, time zone ${plan.timezone}` : ''}`,
    `  History    → ${plan.history.reduce((n, s) => n + s.messages.length, 0)} messages in ${plan.history.length} Hermes session(s)`,
    `  Files      → ${plan.files.length} box file(s) under ${plan.boxRoot}`,
    `  Secrets    → ${plan.redactedSecrets} token-shaped value(s) replaced with [redacted] (kept only in the private archive)`,
  ];
  const preview = previewHermes(plan, destination);
  if (preview) {
    const list = (kind, paths, note) => {
      for (const path of paths.slice(0, PREVIEW_LIST)) lines.push(`    ${kind.padEnd(9)} ${path}${note ? `  (${note})` : ''}`);
      if (paths.length > PREVIEW_LIST) lines.push(`    … and ${paths.length - PREVIEW_LIST} more ${kind}(s)`);
    };
    const f = preview.files;
    lines.push('Existing profile, compared now with the rules the import uses:');
    if (!preview.created) lines.push('  Import     → refused without --into-existing: this profile was not created by this migration of this bot; with it, existing files are only added to');
    lines.push(`  Files      → ${f.written.length} new, ${f.present.length} unchanged, ${f.updated.length} repaired, ${f.conflict.length} conflict(s), ${f.refused.length} refused`);
    list('conflict', f.conflict, 'left as it is; check reports it');
    list('repair', f.updated, 'still what an earlier run wrote');
    list('refused', f.refused, 'a link or not a regular file: the import stops here');
    lines.push(`  SOUL.md    → ${SOUL_PREVIEW[preview.soul]}`);
    lines.push(`  Memory     → MEMORY.md: ${preview.memory.added} new, ${preview.memory.present} already there; USER.md: ${preview.user.added} new, ${preview.user.present} already there`);
    lines.push(`  Schedules  → ${preview.cron.created} new, ${preview.cron.present} already there`);
    const h = preview.history;
    lines.push(h ? `  History    → ${h.imported} new session(s), ${h.present} already imported${h.differs.length ? `, ${h.differs.length} of them with different content (left as is; check reports it)` : ''}`
      : '  History    → not checked (this Hermes cannot list imported sessions)');
  }
  if (plan.notMigrated.length) {
    lines.push('Not migrated (with the alternative):');
    for (const n of groupNotMigrated(plan.notMigrated)) lines.push(`  - ${n.item}: ${n.reason} → ${n.alternative}`);
  }
  if (destination.hermesVersion) lines.push(`Hermes: ${destination.hermesVersion}`);
  return lines.join('\n');
}

export class Hermes {
  constructor({ exec = defaultExec, bin = process.env.GBOT_HERMES_BIN || 'hermes' } = {}) {
    this.exec = exec;
    this.bin = bin;
  }

  async run(args, opts = {}) {
    assertNoSecrets(args.join('\n'), `hermes ${args.slice(0, 3).join(' ')}`);
    const r = await this.exec(this.bin, args, opts);
    if (r.code !== 0) {
      const tail = (r.stderr || r.stdout).trim().split('\n').slice(-4).join(' ').slice(0, 400);
      throw new MigrationError(`hermes ${args.slice(0, 3).join(' ')} failed (exit ${r.code}): ${tail}`);
    }
    return r.stdout;
  }

  async version() {
    const out = await this.run(['--version'], { timeoutMs: 60_000 });
    return out.split('\n')[0].trim();
  }

  async profiles() {
    const out = await this.run(['profile', 'list'], { timeoutMs: 60_000 });
    return out.split('\n').map((l) => l.replace(/^[\s◆*]+/, '').trim().split(/\s+/)[0]).filter((n) => PROFILE_ID_RE.test(n ?? ''));
  }

  async profileDir(name) {
    const out = await this.run(['-p', name, 'config', 'path'], { timeoutMs: 60_000 });
    const path = out.trim().split('\n').pop().trim();
    if (!path.endsWith('config.yaml')) throw new MigrationError('Could not resolve the Hermes profile path.');
    return dirname(path);
  }

  /** Root of the default profile, to predict a new profile's directory before it exists. */
  async rootDir() {
    return this.profileDir('default');
  }

  async helper(op, payload, { home }) {
    if (!this.runtime) {
      const raw = await this.run(['--print-runtime-command'], { timeoutMs: 60_000 });
      let argv;
      try { argv = JSON.parse(raw.trim()); } catch { throw new MigrationError('This Hermes cannot print its runtime command; update Hermes.'); }
      if (!Array.isArray(argv) || argv.length < 3 || argv.at(-2) !== '-c' || typeof argv.at(-1) !== 'string' || !argv.at(-1).includes(RUNTIME_MARKER)) {
        throw new MigrationError('Unrecognized Hermes runtime command; update gbot or Hermes.');
      }
      this.runtime = argv;
    }
    const argv = this.runtime;
    const boot = argv.at(-1).replace(RUNTIME_MARKER, 'exec(compile(sys.stdin.readline() and __import__("base64").b64decode(sys.argv[1]).decode(), "gbot-hermes-helper", "exec"))');
    const input = JSON.stringify({ op, ...payload });
    assertNoSecrets(input, `the Hermes helper ${op} payload`);
    // The helper source travels in argv as base64 (not secret); the payload goes on stdin.
    const args = [...argv.slice(1, -1), boot, Buffer.from(HERMES_HELPER).toString('base64')];
    const r = await this.exec(argv[0], args, { input: '\n' + input, env: { HERMES_HOME: home }, timeoutMs: 600_000 });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
    if (r.code !== 0 || parsed?.ok !== true) {
      const why = typeof parsed?.error === 'string' ? parsed.error : (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 400);
      throw new MigrationError(`Hermes helper ${op} failed (exit ${r.code}): ${why}`);
    }
    return parsed;
  }

  /**
   * Before any change: the runtime resolves and has every store the helper uses. `root` is the
   * existing Hermes root (a new directory as HERMES_HOME would make Hermes provision a runtime there).
   */
  async preflight(root) {
    return this.helper('preflight', {}, { home: root });
  }
}

/**
 * Destination state used by preview, apply and check. Read-only: the capability preflight, and
 * for an existing profile what it already holds, kept as digests and this migration's own tags and
 * session ids (the preview compares the plan with them; no memory text or prompt is kept).
 */
export async function inspectHermes(hermes, { profile }) {
  const hermesVersion = await hermes.version();
  const profiles = await hermes.profiles();
  const root = await hermes.rootDir();
  const profileExists = profiles.includes(profile);
  const profileDir = profileExists ? await hermes.profileDir(profile) : join(root, 'profiles', profile);
  const { versions, default_souls, import_limits } = await hermes.preflight(root);
  let existing = null;
  if (profileExists) {
    const rb = await hermes.helper('readback', { foreign_ids: [], grok_sessions: true }, { home: profileDir });
    existing = {
      memory: rb.memory.map(sha256), user: rb.user.map(sha256),
      cronTags: rb.cron.map((j) => /\[grok-bot [^\]]*\]$/.exec(String(j.name ?? ''))?.[0]).filter(Boolean),
      sessions: rb.grok_sessions ?? null,
    };
  }
  return { hermesVersion, profileExists, profileDir, root, preflight: { versions, default_souls, import_limits }, existing };
}

// The decisions apply makes, shared with the preview so both always agree.

/** Who owns an existing profile: repairs only in one this migration of this bot created. */
function ownershipFor(profileExists, marker, botId) {
  const ours = marker?.botId === botId;
  const created = ours && marker.createdProfile === true;
  return { ours, created, owned: !profileExists || created, files: { ...(ours ? marker.files : {}) } };
}

/** What writing `bytes` over `current` (null: no file there) does. */
function writeDecision(current, bytes, mayUpdate) {
  if (current === null) return 'written';
  if (current.equals(bytes)) return 'present';
  return mayUpdate(sha256(current)) ? 'updated' : 'conflict';
}

/** SOUL.md: 'present', 'seeded' (Hermes' default: replaced, backup kept), 'ours' (repaired) or 'customized' (kept). */
function soulDecision(current, plan, defaultSouls, owned, files) {
  const text = current.toString('utf8');
  if (text === plan.soul) return 'present';
  if (!text.trim() || defaultSouls.includes(normSoul(text))) return 'seeded';
  return owned && files['SOUL.md'] === sha256(current) ? 'ours' : 'customized';
}
const SOUL_PREVIEW = { present: 'unchanged', seeded: "replaced (it is Hermes' default; a backup is kept)", ours: 'repaired (still what an earlier run wrote)', customized: 'kept (customized); the role goes to MEMORY.md' };

/** A cron job of this routine exists: matched by the routine id tag at the end of its name. */
const jobExists = (names, job) => names.some((n) => String(n ?? '').endsWith(job.tag));

/** What writeInside would do now with `bytes` at `path`, without writing. */
function previewWrite(root, path, bytes, mayUpdate) {
  let dir = resolve(root);
  for (const part of relative(root, path).split(sep).slice(0, -1)) {
    dir = join(dir, part);
    let st;
    try { st = lstatSync(dir); } catch { return 'written'; }
    if (!st.isDirectory() || st.isSymbolicLink()) return 'refused';
  }
  let st;
  try { st = lstatSync(path); } catch { return 'written'; }
  if (!st.isFile() || st.nlink !== 1) return 'refused';
  return writeDecision(readFileSync(path), bytes, mayUpdate);
}

/** The preview of an import into an existing profile (null for a new one). */
function previewHermes(plan, dest) {
  if (!dest.profileExists || !dest.existing) return null;
  const own = ownershipFor(true, readMarker(join(plan.base, MARKER)), plan.botId);
  const key = (path) => relative(plan.profileDir, path).split(sep).join('/');
  const files = { written: [], present: [], updated: [], conflict: [], refused: [] };
  const judge = (path, bytes) => files[previewWrite(plan.profileDir, path, bytes, (sha) => own.owned && own.files[key(path)] === sha)].push(path);
  for (const s of plan.skills) for (const f of s.files) judge(f.dest, f.bytes);
  for (const f of plan.files) judge(f.dest, f.bytes);
  for (const [path, bytes] of plan.docs) judge(path, bytes);
  const soulPath = join(plan.profileDir, 'SOUL.md');
  const soul = soulDecision(existsSync(soulPath) ? readFileSync(soulPath) : Buffer.alloc(0), plan, dest.preflight.default_souls ?? [], own.owned, own.files);
  const count = (have, entries) => {
    const present = entries.filter((e) => have.includes(sha256(e))).length;
    return { present, added: entries.length - present };
  };
  const ex = dest.existing;
  const sessions = ex.sessions && new Map(ex.sessions.map((x) => [x.foreign_id, x]));
  const there = sessions ? plan.history.filter((s) => sessions.has(s.foreign_id)) : [];
  return {
    created: own.created, files, soul,
    memory: count(ex.memory, soul === 'customized' && plan.roleEntry !== null ? [plan.roleEntry, ...plan.memory] : plan.memory),
    user: count(ex.user, plan.user),
    cron: { present: plan.cron.filter((j) => jobExists(ex.cronTags, j)).length, created: plan.cron.filter((j) => !jobExists(ex.cronTags, j)).length },
    history: sessions && { imported: plan.history.length - there.length, present: there.length,
      differs: there.filter((s) => sessions.get(s.foreign_id).digest !== s.digest).map((s) => s.foreign_id) },
  };
}

/** `hermes -p PROFILE cron create …` for one planned job, paused unless --activate-routines. */
export function cronCreateArgs(plan, job) {
  const args = ['-p', plan.profile, 'cron', 'create', '--name', job.name, '--workdir', plan.base];
  if (job.paused) args.push('--paused', '--paused-reason', job.sourceEnabled ? 'Migrated from Grok Bot; the Grok copy still runs. Resume after turning it off there.' : 'Migrated from Grok Bot, where it was turned off.');
  return [...args, job.schedule, job.prompt];
}

/**
 * Write `bytes` to `path` under `root` without following links: every parent from `root` down is
 * a real directory and an existing file is a regular file with one link. A new file is created
 * exclusively. A different existing file is read, judged and rewritten through one descriptor, so
 * `mayUpdate(currentSha256)` decides about the very inode that is written; when it refuses, or the
 * path no longer names that inode (the file was saved over meanwhile), it is a 'conflict'.
 * Returns 'written' | 'present' | 'updated' | 'conflict'.
 */
export function writeInside(root, path, bytes, mode, mayUpdate) {
  const parts = relative(root, path).split(sep);
  if (parts.some((p) => !p || p === '..')) throw new MigrationError('Refusing to write outside the profile: ' + path);
  let dir = realpathSync(root);
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new MigrationError('Refusing to write through a link or a non-directory: ' + dir);
  }
  const target = join(dir, parts.at(-1));
  const sameInode = (st) => { try { const now = lstatSync(target); return now.ino === st.ino && now.dev === st.dev; } catch { return false; } };
  const unchanged = (fd) => { const st = fstatSync(fd); return st.isFile() && st.nlink === 1 && sameInode(st) && realpathSync(dir) === dir; };
  let fd;
  try { fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  if (fd !== undefined) {
    try {
      // A parent swapped for a link after the checks: nothing is written.
      if (!unchanged(fd)) throw new MigrationError('Refusing to write: the destination changed while writing ' + target);
      writeFileSync(fd, bytes);
      fchmodSync(fd, mode);
    } finally { closeSync(fd); }
    return 'written';
  }
  let writable = true;
  try { fd = openSync(target, constants.O_RDWR | NOFOLLOW | (constants.O_NONBLOCK ?? 0)); } catch (e) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') throw new MigrationError('Refusing to write over a link or a non-file: ' + target);
    if (e.code !== 'EACCES') throw e;
    fd = openSync(target, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0)); // read-only: compared, never rewritten
    writable = false;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || !sameInode(st)) throw new MigrationError('Refusing to write over a link or a non-file: ' + target);
    const current = Buffer.alloc(st.size);
    for (let at = 0, n; at < st.size; at += n) if (!(n = readSync(fd, current, at, st.size - at, at))) break;
    const decision = writeDecision(current, bytes, mayUpdate);
    if (decision === 'present') return 'present';
    if (decision === 'conflict' || !writable || !unchanged(fd)) return 'conflict';
    ftruncateSync(fd, 0);
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at, at);
    fchmodSync(fd, mode);
    // Saved over between the last check and the write: the bytes went to the replaced inode only.
    return unchanged(fd) ? 'updated' : 'conflict';
  } finally { closeSync(fd); }
}

function readMarker(path) {
  try { return parseBytes(regularBytes(path, 16 * 1024 * 1024)); } catch { return null; }
}

/** The text Hermes compares when it decides whether SOUL.md is still its seeded default. */
const normSoul = (t) => t.replace(/\r\n?/g, '\n').replace(/^\ufeff/, '').trim();

/**
 * Apply a plan. Every step is idempotent: re-running after a failure resumes where it stopped.
 * A profile that already exists is only extended, never overwritten, unless this migration of
 * this bot created it (marker); even then a file is repaired only while it still holds exactly
 * what the migration last wrote there.
 */
export async function applyHermes(hermes, archive, plan, { onProgress = () => {}, allowExisting = false } = {}) {
  assertPlanClean(plan);
  const steps = [];
  const step = (name, status, detail = {}) => { steps.push({ step: name, status, ...detail }); onProgress(`${name}: ${status}`); };
  const dest = await inspectHermes(hermes, { profile: plan.profile });
  const pf = dest.preflight;
  // Every planned session must fit one import of this Hermes, before anything changes.
  const limit = pf.import_limits ?? {};
  for (const s of plan.history) {
    const size = Buffer.byteLength(JSON.stringify(s));
    if (s.messages.length > (limit.session_messages ?? Infinity) || size > (limit.session_bytes ?? Infinity)) {
      throw new MigrationError(`History session "${s.title}" (${s.messages.length} messages, ${size} bytes) is larger than this Hermes imports (${limit.session_messages} messages, ${limit.session_bytes} bytes); nothing was changed.`);
    }
  }
  const botId = archive.capture.bot.id;
  const markerPath = join(plan.base, MARKER);
  const marker = dest.profileExists ? readMarker(markerPath) : null;
  const { ours, created, owned, files: ownFiles } = ownershipFor(dest.profileExists, marker, botId);
  if (dest.profileExists && !allowExisting && !created) {
    throw new MigrationError(`Hermes profile "${plan.profile}" already exists and was not created by this migration of this bot. Pass --profile NEW_NAME, or --into-existing to add to it.`);
  }
  if (!dest.profileExists) {
    await hermes.run(['profile', 'create', plan.profile, '--no-alias', '--description', `Migrated from Grok Bot: ${plan.botName}`], { timeoutMs: 300_000 });
    step('profile', 'created', { profile: plan.profile });
  } else step('profile', 'exists', { profile: plan.profile });
  const profileDir = await hermes.profileDir(plan.profile);
  if (profileDir !== plan.profileDir) throw new MigrationError('The Hermes profile path differs from the plan; plan again.');
  // A marker of another bot is left as it is, and nothing of this run is recorded in it.
  const record = marker && !ours ? null : { botId, createdProfile: owned, archive: plan.historyPath, capturedAt: archive.capture.capturedAt, files: ownFiles };
  const key = (path) => relative(profileDir, path).split(sep).join('/');
  const put = (path, bytes, mode = 0o600, mayUpdate = (sha) => owned && record?.files[key(path)] === sha) => {
    const r = writeInside(profileDir, path, bytes, mode, mayUpdate);
    if (record && r !== 'conflict') record.files[key(path)] = sha256(bytes);
    return r;
  };
  const saveMarker = () => { if (record) writeInside(profileDir, markerPath, Buffer.from(JSON.stringify(record, null, 2) + '\n'), 0o600, () => true); };
  saveMarker();

  if (plan.timezone) { await hermes.run(['-p', plan.profile, 'config', 'set', 'timezone', plan.timezone]); step('timezone', 'set', { timezone: plan.timezone }); }

  // SOUL.md: replace an empty SOUL or exactly Hermes' seeded default (kept as a backup), or repair
  // the one this migration wrote. A customized SOUL is left alone; the role goes to MEMORY.md.
  const soulPath = join(profileDir, 'SOUL.md');
  const soulBytes = existsSync(soulPath) ? readFileSync(soulPath) : Buffer.alloc(0);
  const soul = soulDecision(soulBytes, plan, pf.default_souls ?? [], owned, record?.files ?? {});
  let roleInMemory = false;
  if (soul === 'present') { put(soulPath, soulBytes); step('soul', 'present'); }
  else if (soul === 'seeded' || soul === 'ours') {
    if (soul === 'seeded' && soulBytes.toString('utf8').trim()) put(soulPath + '.bak.grok-bot', soulBytes, 0o600, () => false);
    // Authorized only for the exact bytes judged above: a SOUL saved in between is a conflict.
    const judged = sha256(soulBytes);
    if (put(soulPath, Buffer.from(plan.soul), 0o600, (sha) => sha === judged) === 'conflict') {
      roleInMemory = plan.roleEntry !== null;
      step('soul', 'conflict', { note: 'SOUL.md changed while importing; it was kept and the role was added to MEMORY.md instead' });
    } else step('soul', 'written');
  } else {
    roleInMemory = plan.roleEntry !== null;
    step('soul', 'kept-existing', { note: 'SOUL.md was customized; the role was added to MEMORY.md instead' });
  }

  // Limits fit what the profile already holds plus everything added now.
  const before = await hermes.helper('readback', { foreign_ids: [] }, { home: profileDir });
  const memory = roleInMemory ? [plan.roleEntry, ...plan.memory] : plan.memory;
  const union = (have, add) => [...have, ...add.filter((e) => !have.includes(e))];
  const limits = {
    memory: limitFor(union(before.memory, memory), Math.max(DEFAULT_MEMORY_LIMIT, before.limits.memory)),
    user: limitFor(union(before.user, plan.user), Math.max(DEFAULT_USER_LIMIT, before.limits.user)),
  };
  if (limits.memory > before.limits.memory) await hermes.run(['-p', plan.profile, 'config', 'set', 'memory.memory_char_limit', String(limits.memory)]);
  if (limits.user > before.limits.user) await hermes.run(['-p', plan.profile, 'config', 'set', 'memory.user_char_limit', String(limits.user)]);
  step('memory-limits', 'set', limits);
  const mem = await hermes.helper('memory-add', {
    memory_char_limit: limits.memory, user_char_limit: limits.user,
    entries: [...plan.user.map((c) => ({ target: 'user', content: c })), ...memory.map((c) => ({ target: 'memory', content: c }))],
  }, { home: profileDir });
  const refused = mem.results.filter((r) => r.status === 'refused');
  step('memory', refused.length ? 'partial' : 'done', { added: mem.results.filter((r) => r.status === 'added').length, present: mem.results.filter((r) => r.status === 'present').length, refused });

  const fileMode = (f) => ((f.mode ?? 0o644) & 0o111 ? 0o700 : 0o600);
  let skillWritten = 0; const skillConflicts = [];
  for (const s of plan.skills) {
    for (const f of s.files) {
      const r = put(f.dest, f.bytes, fileMode(f));
      if (r === 'written' || r === 'updated') skillWritten++;
      if (r === 'conflict') skillConflicts.push(f.dest);
    }
  }
  step('skills', skillConflicts.length ? 'partial' : 'done', { skills: plan.skills.length, filesWritten: skillWritten, conflicts: skillConflicts });

  let fileWritten = 0; const fileConflicts = [];
  for (const f of plan.files) {
    const r = put(f.dest, f.bytes, fileMode(f));
    if (r === 'written' || r === 'updated') fileWritten++;
    if (r === 'conflict') fileConflicts.push(f.dest);
  }
  for (const [path, bytes] of plan.docs) if (put(path, bytes) === 'conflict') fileConflicts.push(path);
  saveMarker();
  step('files', fileConflicts.length ? 'partial' : 'done', { files: plan.files.length, written: fileWritten, docs: plan.docs.size, conflicts: fileConflicts });

  let jobsCreated = 0;
  for (const job of plan.cron) {
    if (jobExists(before.cron.map((j) => j.name), job)) continue;
    await hermes.run(cronCreateArgs(plan, job), { timeoutMs: 120_000 });
    jobsCreated++;
  }
  step('cron', 'done', { jobs: plan.cron.length, created: jobsCreated });

  const hist = await hermes.helper('import-history', {
    profile: plan.profile,
    sessions: plan.history.map(({ digest, ...s }) => ({ ...s, path: plan.historyPath, cwd: plan.base })),
  }, { home: profileDir });
  step('history', 'done', { sessions: hist.results });

  return { profile: plan.profile, profileDir, steps };
}

/** Null when `path` is a regular file with this sha256, else what is wrong with it. */
function fileIssue(path, digest) {
  let st;
  try { st = lstatSync(path); } catch { return `${path}: missing`; }
  if (!st.isFile()) return `${path}: not a regular file`;
  return sha256(readFileSync(path)) === digest ? null : `${path}: digest differs`;
}

/** Every entry under `dir` that is not a directory (links are listed, not followed). */
const listTree = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listTree(join(dir, e.name)) : [join(dir, e.name)]));

/** Read the destination back through Hermes and compare with the plan. */
export async function verifyHermes(hermes, archive, plan) {
  const checks = [];
  const check = (area, ok, detail = {}) => checks.push({ area, ok, ...detail });
  const profileDir = await hermes.profileDir(plan.profile);
  const soul = existsSync(join(profileDir, 'SOUL.md')) ? readFileSync(join(profileDir, 'SOUL.md'), 'utf8') : '';
  // Read with the profile's configured limits, as the agent loads its memory.
  const rb = await hermes.helper('readback', { foreign_ids: plan.history.map((s) => s.foreign_id), history_path: plan.historyPath }, { home: profileDir });
  check('role', soul === plan.soul || (plan.roleEntry !== null && rb.memory.includes(plan.roleEntry)), { where: soul === plan.soul ? 'SOUL.md' : 'MEMORY.md' });
  const missingUser = plan.user.filter((e) => !rb.user.includes(e));
  const missingMem = plan.memory.filter((e) => !rb.memory.includes(e));
  check('user-facts', !missingUser.length && !rb.user_prompt.includes('[BLOCKED'), { expected: plan.user.length, missing: missingUser });
  check('memory', !missingMem.length && !rb.memory_prompt.includes('[BLOCKED'), { expected: plan.memory.length, missing: missingMem });
  // The files Hermes loads, byte for byte, and nothing else in a migrated skill folder.
  const missingSkills = plan.skills.filter((s) => !rb.skills.includes(s.slug) && !rb.skills.includes(skillName(s)));
  const skillIssues = [];
  for (const s of plan.skills) {
    const planned = new Set(s.files.map((f) => f.dest));
    for (const f of s.files) { const issue = fileIssue(f.dest, sha256(f.bytes)); if (issue) skillIssues.push(issue); }
    if (existsSync(s.dir)) for (const p of listTree(s.dir)) if (!planned.has(p)) skillIssues.push(`${p}: not part of the migrated skill`);
  }
  check('skills', !missingSkills.length && !skillIssues.length, { expected: plan.skills.length, visibleToHermes: plan.skills.length - missingSkills.length, missing: missingSkills.map((s) => s.slug), issues: skillIssues });
  const cronIssues = [];
  for (const job of plan.cron) {
    const found = rb.cron.filter((j) => String(j.name ?? '').endsWith(job.tag));
    if (!found.length) { cronIssues.push(`${job.routine}: missing`); continue; }
    if (found.length > 1) cronIssues.push(`${job.routine}: ${found.length} jobs for one routine`);
    const j = found[0];
    const expr = j.schedule?.expr ?? j.schedule;
    if (expr !== job.schedule) cronIssues.push(`${job.routine}: schedule is ${typeof expr === 'string' ? expr : JSON.stringify(expr)}, expected ${job.schedule}`);
    if (job.timezone && rb.timezone !== job.timezone) cronIssues.push(`${job.routine}: profile time zone is ${rb.timezone || 'server local'}, expected ${job.timezone}`);
    const want = job.paused ? 'paused' : 'scheduled';
    if (j.state !== want) cronIssues.push(`${job.routine}: ${j.state}, expected ${want}`);
    if (j.prompt !== job.prompt) cronIssues.push(`${job.routine}: prompt differs`);
  }
  check('schedules', !cronIssues.length, { expected: plan.cron.length, issues: cronIssues });
  const histIssues = [];
  for (const s of plan.history) {
    const got = rb.sessions.find((r) => r.foreign_id === s.foreign_id);
    if (!got?.session_id) histIssues.push(`${s.foreign_id}: not imported`);
    else if (got.messages !== s.messages.length) histIssues.push(`${s.foreign_id}: ${got.messages}/${s.messages.length} messages`);
    else if (got.digest !== s.digest) histIssues.push(`${s.foreign_id}: message content differs from the archive`);
  }
  check('history', !histIssues.length, { sessions: plan.history.length, messages: plan.history.reduce((n, s) => n + s.messages.length, 0), issues: histIssues });
  // A conflict left at apply time (or a later change) shows here, so the import is not ok.
  const fileIssues = [];
  for (const f of plan.files) { const issue = fileIssue(f.dest, f.destSha256); if (issue) fileIssues.push(issue); }
  for (const [path, bytes] of plan.docs) { const issue = fileIssue(path, sha256(bytes)); if (issue) fileIssues.push(issue); }
  check('files', !fileIssues.length, { expected: plan.files.length, docs: plan.docs.size, issues: fileIssues });
  return { ok: checks.every((c) => c.ok), checks };
}

/** Lowercase letters and digits only, so squash-merge matches "squash merge". */
const norm = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
/** `alt` appears in `text`, verbatim (any case) or with punctuation and spacing ignored. */
const mentions = (text, alt) => text.toLowerCase().includes(alt.toLowerCase()) || Boolean(norm(alt) && norm(text).includes(norm(alt)));

// Words any assistant already knows; a keyword check on them proves nothing.
const COMMON_TOKENS = new Set(['github', 'gitlab', 'chatgpt', 'openai', 'google', 'youtube', 'linkedin', 'iphone', 'ipad', 'javascript',
  'typescript', 'whatsapp', 'ios', 'macos', 'json', 'yaml', 'http', 'https', 'url', 'api', 'pdf', 'grok', 'hermes', 'muse', 'slack', 'telegram']);

/**
 * Distinctive tokens of a text, most specific first: identifiers with digits, #/! numbers,
 * hyphenated names, then CamelCase words. Dates, times and URLs are ignored; well-known product
 * names are skipped because an answer could contain them without any migrated data.
 */
// Capitalized words that say nothing about this data: languages, days, months.
const PLAIN_PROPER = /^(User|Users|English|Chinese|Japanese|Korean|French|German|Spanish|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|June|July|August|September|October|November|December)$/;

export function distinctiveTokens(text, max = 3) {
  const cleaned = String(text ?? '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ');
  const seen = new Map();
  const add = (t, score) => {
    t = t.replace(/^[.,;:'"`(]+|[.,;:'"`)]+$/g, '');
    if (t.length < 3 || COMMON_TOKENS.has(t.toLowerCase()) || /^\d+$/.test(t)) return;
    if (!seen.has(t) || seen.get(t) < score) seen.set(t, score);
  };
  for (const m of cleaned.matchAll(/[!#]\d{1,6}\b/g)) add(m[0], 4);
  for (const m of cleaned.matchAll(/\b[A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b/g)) add(m[0], 3);
  // Hyphenated names count only with a digit or three or more parts (resume-skills-2, deploy-qa-scan);
  // two plain words (built-in, squash-merge) are ordinary English and get translated in answers.
  for (const m of cleaned.matchAll(/\b[a-z0-9]+(?:-[a-z0-9]+){1,}\b/g)) if (/\d/.test(m[0]) || m[0].split('-').length >= 3) add(m[0], 2);
  for (const m of cleaned.matchAll(/\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/g)) add(m[0], 1);
  // Plain-language text (no ids, numbers or code names): a proper noun mid-sentence (Kyoto,
  // Taipei) is still something only this data says. Never a sentence's first word.
  if (!seen.size) {
    for (const m of cleaned.matchAll(/(?<=[a-z0-9,;:)][ \t]+)[A-Z][a-z]{3,}\b/g)) if (!PLAIN_PROPER.test(m[0])) add(m[0], 0.5);
  }
  const order = [...seen].map(([t, score], i) => ({ t, score, i: cleaned.indexOf(t) + i * 0 }));
  order.sort((a, b) => b.score - a.score || a.i - b.i);
  return order.slice(0, max).map((o) => o.t);
}

/** `description:` from SKILL.md frontmatter, including YAML folded/literal blocks. */
export function skillDescription(text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(String(text ?? ''))?.[1] ?? '';
  const lines = fm.split('\n');
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i < 0) return '';
  const first = lines[i].replace(/^description:\s*/, '').trim();
  if (/^[>|][-+]?$/.test(first)) {
    const block = [];
    for (const l of lines.slice(i + 1)) { if (/^\S/.test(l)) break; block.push(l.trim()); }
    return block.join(' ').trim();
  }
  return first.replace(/^["']|["']$/g, '');
}

/**
 * Behavioral acceptance: ask the migrated Hermes agent questions only the migrated data can
 * answer, and check the answers. Each question is one real model call. Questions are built from
 * the plan (redacted data), and a keyword the question itself contains never counts.
 */
export function acceptanceQuestions(archive, plan) {
  const qs = [];
  const fresh = (prompt, tokens) => tokens.filter((t) => !(Array.isArray(t) ? t : [t]).some((alt) => mentions(prompt, alt)));
  // False when no expected keyword is left: the caller then tries another source item.
  const ask = (q) => {
    const expect = fresh(q.prompt, q.expect);
    if (!expect.length) return false;
    qs.push({ ...q, expect, ...(q.min ? { min: Math.min(q.min, expect.length) } : {}) });
    return true;
  };
  const name = plan.botName.split(' · ')[0];
  ask({ area: 'role', prompt: 'In one sentence: what is your name and your job? Answer in English.', expect: [name] });
  const facts = [...new Set(plan.user.map((f) => distinctiveTokens(f, 1)[0]).filter(Boolean))].slice(0, 4);
  if (facts.length) ask({ area: 'user-facts', prompt: 'List every fact you remember about the user, one per line, verbatim.', expect: facts, min: Math.max(1, Math.ceil(facts.length * 0.75)) });
  if (plan.cron.length) ask({ area: 'schedules', prompt: 'Which of your Grok Bot routines became Hermes cron jobs, and what state is each one in right now? One line per routine with its exact name.', expect: [...plan.cron.map((c) => c.routine), ...(plan.cron.some((c) => c.paused) ? [['paused', '暫停', '暂停', 'pausiert', 'en pause']] : [])] });
  const openTokens = plan.open.flatMap((t) => distinctiveTokens(t.content, 1)).slice(0, 4);
  if (openTokens.length) ask({ area: 'open-tasks', prompt: 'Which open tasks did you carry over from Grok Bot? Reply with each task on one line.', expect: openTokens });
  // The newest user message, or an older one named by a keyword no newer message contains.
  const users = plan.history.filter((s) => s.foreign_id.startsWith(`${archive.capture.bot.id}:main:`)).flatMap((s) => s.messages).filter((m) => m.role === 'user').reverse().slice(0, 200);
  for (const [i, m] of users.entries()) {
    const tokens = distinctiveTokens(m.content, 3);
    if (i === 0) {
      const prompt = 'Search your imported Grok Bot conversation history (session_search) and quote, verbatim, the most recent message the user sent there. Quote at least its first 120 characters.';
      if (ask({ area: 'history', prompt, expect: fresh(prompt, tokens).slice(0, 2) })) break;
    } else if (tokens.length > 1 && !users.slice(0, i).some((n) => n.content.includes(tokens[0]))) {
      const prompt = 'Search your imported Grok Bot conversation history (session_search) and quote, verbatim, the most recent message from the user that mentions ' + JSON.stringify(tokens[0]) + '. Quote at least its first 120 characters.';
      if (ask({ area: 'history', prompt, expect: fresh(prompt, tokens.slice(1)).slice(0, 1) })) break;
    }
  }
  // A migrated skill must be loadable by the agent's own skills tool.
  for (const sk of plan.skills) {
    const prompt = `Use your skills tool to open the skill "${skillName(sk)}" and quote its description exactly.`;
    const desc = skillDescription(sk.files.find((f) => f.rel === 'SKILL.md').bytes.toString('utf8'));
    if (ask({ area: 'skills', prompt, expect: fresh(prompt, distinctiveTokens(desc, 3)).slice(0, 1) })) break;
  }
  // A file the bot's own prompts name: find a line with a distinctive token and ask for its line number.
  files: for (const f of plan.files.filter((x) => x.reason === 'referenced' && x.size < 64 * 1024)) {
    const lines = f.bytes.toString('utf8').split('\n');
    for (let index = 1; index < Math.min(40, lines.length); index++) {
      const prompt = `Open the file ${f.dest} (migrated from the Grok box path ${f.boxPath}). Copy line ${index + 1} of it exactly, and nothing else.`;
      if (ask({ area: 'files', prompt, expect: fresh(prompt, distinctiveTokens(lines[index], 3)).slice(0, 1) })) break files;
    }
  }
  return qs;
}

export async function acceptHermes(hermes, archive, plan, { onProgress = () => {}, usageDir } = {}) {
  const results = [];
  for (const q of acceptanceQuestions(archive, plan)) {
    // Model answers vary between runs: a question that fails is asked once more, and both answers
    // are kept in the report, so a pass on the second try is visible as such.
    const attempts = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      onProgress(`acceptance: ${q.area}${attempt > 1 ? ' (asked again)' : ''}`);
      const args = ['-p', plan.profile, ...(q.toolsets ? ['-t', q.toolsets] : []), '-z', q.prompt];
      if (usageDir) args.push('--usage-file', join(usageDir, `acceptance-${q.area}-${attempt}.json`));
      let answer = '', error = null;
      try { answer = await hermes.run(args, { timeoutMs: 600_000, cwd: plan.base }); } catch (e) { error = e.message; }
      const hits = q.expect.filter((t) => (Array.isArray(t) ? t : [t]).some((alt) => mentions(answer, alt)));
      const need = q.min ?? q.expect.length;
      attempts.push({ answer: answer.trim().slice(0, 2000), hits, error, ok: !error && hits.length >= need });
      if (attempts.at(-1).ok) break;
    }
    const last = attempts.at(-1);
    results.push({ area: q.area, prompt: q.prompt, expect: q.expect, hits: last.hits, ok: last.ok, answer: last.answer, error: last.error,
      attempts: attempts.length, ...(attempts.length > 1 ? { earlier: attempts.slice(0, -1) } : {}) });
  }
  return { ok: results.length > 0 && results.every((r) => r.ok), results };
}
