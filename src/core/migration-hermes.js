/**
 * Hermes destination for an archive v2 bot: one bot → one new Hermes profile.
 *
 * Mapping (each item is planned, applied idempotently, read back and reported):
 *   instructions            → SOUL.md (the fresh profile still holds Hermes' seeded default)
 *   memory/profile.md       → USER.md entries   (Hermes MemoryStore: format, threat scan, limits)
 *   memory/log/*.md         → MEMORY.md entries, plus migration notes and open tasks
 *   skill library           → skills/grok-bot-imports/<slug>/ (every file of the skill)
 *   scheduled automations   → `hermes cron create --paused` jobs (Grok keeps its own copy)
 *   event automations       → workspace notes (no Hermes event trigger for GitHub/Slack listeners)
 *   full transcript         → Hermes sessions via SessionDB.import_foreign_history (searchable)
 *   box files               → <profile>/workspace/grok-bot/grok-box/<box path>
 * Commands run without a shell. Nothing is sent to a model until `accept`.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MigrationError } from './migration.js';
import { HERMES_HELPER } from './migration-hermes-helper.js';
import { isText, redactor } from './migration-redact.js';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEFAULT_MEMORY_LIMIT = 2200;
const DEFAULT_USER_LIMIT = 1375;
const ENTRY_DELIMITER = '\n§\n';
const HISTORY_SESSION_BYTES = 4 * 1024 * 1024;
const HISTORY_SESSION_MESSAGES = 9000;
const SKILL_CATEGORY = 'grok-bot-imports';

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

function historySessions(capture, transcriptRows, title) {
  const messages = transcriptRows.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text)
    .map((m) => ({ role: m.role, content: m.text, ...(m.timestampMs ? { timestamp: m.timestampMs / 1000 } : {}) }));
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
    foreign_id: `${capture.bot.id}:main:${i + 1}`,
    messages: msgs,
  }));
}

/**
 * Pure plan from an opened archive. `profileDir` is where the profile lives (or will live).
 * @param {ReturnType<import('./migration-archive.js').openArchive>} archive
 */
export function buildHermesPlan(archive, { profile, profileDir, skills = 'all', activateRoutines = false, now = () => new Date() }) {
  const cap = archive.capture;
  if (cap.bot.kind !== 'bot') throw new MigrationError('Only a bot (not a group) can become a Hermes profile.');
  // Token-shaped secrets stay in the private archive only.
  const redact = redactor();
  const cleanBytes = (path) => {
    const bytes = archive.read(path);
    if (!isText(bytes)) return { bytes, redacted: 0 };
    const before = redact.tally.count;
    const text = redact(bytes.toString('utf8'));
    const n = redact.tally.count - before;
    return n ? { bytes: Buffer.from(text, 'utf8'), redacted: n } : { bytes, redacted: 0 };
  };
  const name = profile ?? profileNameFor(cap.bot);
  if (!PROFILE_ID_RE.test(name) || name === 'default') throw new MigrationError('Invalid Hermes profile name.');
  const base = join(profileDir, 'workspace', 'grok-bot');
  const boxRoot = join(base, 'grok-box');
  const date = now().toISOString().slice(0, 10);
  const botName = cap.bot.name;

  const memFiles = cap.box.filter((b) => b.kind === 'file' && b.boxPath.endsWith('.md') && /\/(memory|user-memory)\//.test(b.boxPath));
  const user = [], memory = [];
  for (const f of memFiles.sort((a, b) => a.boxPath.localeCompare(b.boxPath))) {
    const entries = memoryEntries(redact(archive.read(f.path).toString('utf8')));
    if (/\/memory\/profile\.md$/.test(f.boxPath) || f.boxPath.includes('/user-memory/')) user.push(...entries);
    else memory.push(...entries);
  }
  const mainRows = cap.transcripts.find((t) => t.sessionId === '');
  const rows = (mainRows ? archive.transcript(mainRows) : []).map((m) => ({ ...m, text: redact(m.text) }));
  const historyTitle = `Grok Bot · ${botName} · history`;
  const history = historySessions(cap, rows, historyTitle);
  const msgCount = history.reduce((n, s) => n + s.messages.length, 0);
  const firstTs = rows.find((r) => r.timestampMs)?.timestampMs;
  const lastTs = [...rows].reverse().find((r) => r.timestampMs)?.timestampMs;
  const span = firstTs && lastTs ? `${new Date(firstTs).toISOString().slice(0, 10)} to ${new Date(lastTs).toISOString().slice(0, 10)}` : 'unknown dates';

  const notes = [
    `Migrated from Grok Bot "${botName}" on ${date}. Files from the Grok box are under ${boxRoot}; a path /home/box/X in older instructions or routines now means ${boxRoot}/home/box/X.`,
    `The full Grok Bot conversation (${msgCount} messages, ${span}) is imported as the Hermes session "${history[0]?.title ?? historyTitle}"; use session_search to recall it. A readable copy is ${join(base, 'history', 'main.md')}.`,
  ];
  const open = cap.todos.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  for (const t of open) notes.push(`Open task carried over from Grok Bot (${t.status}, id ${t.id}): ${redact(t.content)}`);
  const memoryAll = [...memory, ...notes];

  const skillRows = cap.box.filter((b) => b.reason === 'skill' && b.kind === 'file');
  const skillDirs = new Map();
  for (const b of skillRows) {
    const m = /^\/home\/box\/sand-data\/workflows\/([^/]+)\/(.+)$/.exec(b.boxPath);
    if (!m) continue;
    if (!skillDirs.has(m[1])) skillDirs.set(m[1], []);
    skillDirs.get(m[1]).push({ rel: m[2], ...b });
  }
  const skillPlan = skills === 'none' ? [] : [...skillDirs].filter(([, files]) => files.some((f) => f.rel === 'SKILL.md'))
    .map(([slug, files]) => ({ slug, dir: join(profileDir, 'skills', SKILL_CATEGORY, slug), files }));

  const pathNote = `[Migrated from Grok Bot "${botName}". Box paths /home/box/... now live under ${boxRoot}/home/box/... . CLI logins that existed on the Grok box (for example glab, gh) must exist on this machine.]\n\n`;
  const cron = [], unscheduled = [];
  const zones = new Set();
  for (const a of cap.automations) {
    if (a.trigger === 'schedule' && a.scheduleCron) {
      if (a.timezone) zones.add(a.timezone);
      cron.push({ name: `${botName}: ${a.name}`, schedule: a.scheduleCron, timezone: a.timezone, prompt: pathNote + redact(a.prompt),
        paused: !(activateRoutines && a.enabled), sourceEnabled: a.enabled, sourceId: a.id });
    } else unscheduled.push(a);
  }
  const timezone = zones.size === 1 ? [...zones][0] : null;
  if (cron.length) notes.push(`Grok Bot routines migrated as Hermes cron jobs (${cron.every((c) => c.paused) ? 'all created paused' : 'see hermes cron list'}): ${cron.map((c) => `"${c.name.split(': ').slice(1).join(': ')}" (${c.schedule}${c.timezone ? ' ' + c.timezone : ''}, ${c.paused ? 'paused' : 'active'})`).join('; ')}. Resume one only after turning it off in Grok Bot, so it does not run twice.`);
  if (unscheduled.length) notes.push(`Event-triggered Grok Bot routines not scheduled in Hermes: ${unscheduled.map((a) => `"${a.name}" (${a.trigger})`).join('; ')}. Their prompts are in ${join(base, 'routines-not-scheduled.md')}.`);
  if (zones.size > 1) notes.push('Grok routines used several time zones; Hermes cron uses one profile time zone. Check each job schedule.');

  const files = cap.box.filter((b) => b.kind === 'file').map((b) => {
    const { bytes, redacted } = cleanBytes(b.path);
    return { ...b, dest: join(boxRoot, b.boxPath.replace(/^\/+/, '')), bytes, redacted, destSha256: redacted ? sha256(bytes) : b.sha256 };
  });
  for (const sk of skillPlan) for (const f of sk.files) Object.assign(f, cleanBytes(f.path));
  const docs = new Map();
  docs.set(join(base, 'history', 'main.md'), cleanBytes(mainRows ? mainRows.path.replace(/\.jsonl$/, '.md') : 'REPORT.md').bytes);
  docs.set(join(base, 'AGENTS.md'), Buffer.from(`# Migrated Grok Bot workspace: ${botName}\n\n${notes[0]}\n\nOpen tasks:\n${open.map((t) => `- ${t.content}`).join('\n') || '- none'}\n`));
  if (unscheduled.length) {
    docs.set(join(base, 'routines-not-scheduled.md'), Buffer.from(`# Grok Bot routines with event triggers\n\nHermes cron runs on a schedule; these were triggered by events in Grok Bot (GitHub, Slack, ...), so they were not created as cron jobs. Their full prompts are below.\n\n` +
      unscheduled.map((a) => `## ${a.name}\n\n- Trigger: ${a.trigger}\n- Was enabled in Grok Bot: ${a.enabled}\n- Listeners: \`${a.triggerDetails}\`\n\n${redact(a.prompt)}\n`).join('\n')));
  }
  docs.set(join(base, 'grok-bot-export.json'), Buffer.from(JSON.stringify({ format: 'grok-bot-export', version: 1, bots: [{
    name: botName, title: cap.bot.title, instructions: redact(cap.bot.instructions), memories: memory, user_facts: user,
    // The archive keeps every skill folder; the official importer copies a folder given as `path`.
    skills: skillPlan.map((s) => ({ name: s.slug, path: join(archive.root, ...dirname(s.files.find((f) => f.rel === 'SKILL.md').path).split('/')) })),
    routines: cap.automations.map((a) => ({ name: a.name, instruction: redact(a.prompt), trigger: a.trigger, schedule_cron: a.scheduleCron,
      schedule_text: a.scheduleText, timezone: a.timezone ?? '', paused: !a.enabled, skills: [], trigger_details: a.triggerDetails })),
    apps: cap.connectors.map((c) => ({ name: c.name, mcp_url: '' })),
  }] }, null, 2) + '\n'));

  const notMigrated = [
    ...unscheduled.map((a) => ({ item: `routine "${a.name}"`, reason: `event trigger (${a.trigger}); Hermes cron has no ${a.trigger} event source`, alternative: `prompt kept in ${join(base, 'routines-not-scheduled.md')}; run it on a schedule or from a webhook` })),
    ...cap.skipped.map((s) => ({ item: s.boxPath, reason: s.reason,
      alternative: /credential/.test(s.reason) ? 'sign in to that service on this machine (the file holds a login)' : /larger than/.test(s.reason) ? 'capture again with a higher --max-file-mb' : 'capture again' })),
    ...(cap.connectors.length ? [{ item: 'connector logins', reason: 'OAuth grants cannot leave Grok Bot', alternative: 'connect the same apps in Hermes (hermes mcp / hermes setup)' }] : []),
    { item: 'Grok Bot platform skills (managed/plugin)', reason: 'owned by the Grok Bot platform', alternative: 'Hermes bundled skills cover similar tasks' },
    ...(cap.groups ?? []).map((g) => ({ item: `group chat "${g.name}"`, reason: 'a group is shared by several bots', alternative: 'migrate its members too; each becomes a Hermes profile, and profiles can work together on the Hermes kanban board' })),
    { item: 'teammates (other Grok bots it could message)', reason: 'each bot is its own agent', alternative: 'migrate them too; each becomes a Hermes profile' },
  ];
  for (const [area, c] of Object.entries(cap.coverage)) {
    if (c.status === 'failed') notMigrated.push({ item: area, reason: 'source read failed: ' + (c.reason ?? ''), alternative: 'capture again' });
  }

  return {
    target: 'hermes', profile: name, profileDir, base, boxRoot, timezone,
    soul: `# ${botName}\n\nYou are ${botName}${cap.bot.title ? ' (' + cap.bot.title + ')' : ''}, migrated from Grok Bot to Hermes. Introduce yourself by this name and keep this role.\n\n${redact(cap.bot.instructions).trim()}\n`,
    user, memory: memoryAll,
    limits: { memory: limitFor(memoryAll, DEFAULT_MEMORY_LIMIT), user: limitFor(user, DEFAULT_USER_LIMIT) },
    skills: skillPlan, cron, unscheduled: unscheduled.map((a) => a.name), history, files, docs, notMigrated,
    open: open.map((t) => ({ id: t.id, content: redact(t.content) })),
    redactedSecrets: redact.tally.count,
  };
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
    const raw = await this.run(['--print-runtime-command'], { timeoutMs: 60_000 });
    let argv;
    try { argv = JSON.parse(raw.trim()); } catch { throw new MigrationError('This Hermes cannot print its runtime command; update Hermes.'); }
    const marker = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
    const code = argv[argv.length - 1];
    if (!Array.isArray(argv) || argv[argv.length - 2] !== '-c' || !code.includes(marker)) throw new MigrationError('Unrecognized Hermes runtime command; update gbot or Hermes.');
    const boot = code.replace(marker, 'exec(compile(sys.stdin.readline() and __import__("base64").b64decode(sys.argv[1]).decode(), "gbot-hermes-helper", "exec"))');
    // The helper source travels in argv as base64 (not secret); the payload goes on stdin.
    const args = [...argv.slice(1, -1), boot, Buffer.from(HERMES_HELPER).toString('base64')];
    const r = await this.exec(argv[0], args, { input: '\n' + JSON.stringify({ op, ...payload }), env: { HERMES_HOME: home }, timeoutMs: 600_000 });
    let parsed;
    try { parsed = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {
      throw new MigrationError(`Hermes helper ${op} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
    }
    if (!parsed.ok) throw new MigrationError(`Hermes helper ${op}: ${parsed.error}`);
    return parsed;
  }
}

/** Destination state used by plan and apply. Read-only. */
export async function inspectHermes(hermes, { profile }) {
  const hermesVersion = await hermes.version();
  const profiles = await hermes.profiles();
  const root = await hermes.rootDir();
  const profileExists = profiles.includes(profile);
  const profileDir = profileExists ? await hermes.profileDir(profile) : join(root, 'profiles', profile);
  return { hermesVersion, profileExists, profileDir, root };
}

/**
 * Create a file, or leave an identical one. A different existing file is a conflict, unless
 * `owned` (inside the folders this migration created in a profile it created): then a re-run
 * updates it, so a newer gbot can repair what an older run wrote.
 */
function writeCreateOnly(path, bytes, mode = 0o600, owned = false) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) throw new MigrationError('Refusing to write over a non-file: ' + path);
    const current = readFileSync(path);
    if (current.equals(bytes)) return 'present';
    if (!owned) return 'conflict';
    writeFileSync(path, bytes, { mode });
    return 'updated';
  }
  writeFileSync(path, bytes, { mode, flag: 'wx' });
  return 'written';
}

/**
 * Apply a plan. Every step is idempotent: re-running after a failure resumes where it stopped.
 * `owned` must be true when the profile was created by this migration (state file), so an
 * existing user profile is only extended, never overwritten.
 */
export async function applyHermes(hermes, archive, plan, { onProgress = () => {}, allowExisting = false } = {}) {
  const steps = [];
  const step = (name, status, detail = {}) => { steps.push({ step: name, status, ...detail }); onProgress(`${name}: ${status}`); };
  const dest = await inspectHermes(hermes, { profile: plan.profile });
  if (dest.profileExists && !allowExisting) {
    const marker = join(dest.profileDir, 'workspace', 'grok-bot', '.gbot-migration.json');
    if (!existsSync(marker)) throw new MigrationError(`Hermes profile "${plan.profile}" already exists and was not created by this migration. Pass --profile NEW_NAME, or --into-existing to add to it.`);
  }
  if (!dest.profileExists) {
    await hermes.run(['profile', 'create', plan.profile, '--no-alias', '--description', `Migrated from Grok Bot: ${archive.capture.bot.name}`], { timeoutMs: 300_000 });
    step('profile', 'created', { profile: plan.profile });
  } else step('profile', 'exists', { profile: plan.profile });
  const profileDir = await hermes.profileDir(plan.profile);
  if (profileDir !== plan.profileDir) throw new MigrationError('The Hermes profile path differs from the plan; plan again.');
  const markerPath = join(plan.base, '.gbot-migration.json');
  const owned = !dest.profileExists || existsSync(markerPath);
  if (!existsSync(markerPath)) writeCreateOnly(markerPath, Buffer.from(JSON.stringify({ botId: archive.capture.bot.id, createdProfile: !dest.profileExists, archive: archive.root, capturedAt: archive.capture.capturedAt }, null, 2) + '\n'));

  if (plan.timezone) { await hermes.run(['-p', plan.profile, 'config', 'set', 'timezone', plan.timezone]); step('timezone', 'set', { timezone: plan.timezone }); }
  if (plan.limits.memory > DEFAULT_MEMORY_LIMIT) await hermes.run(['-p', plan.profile, 'config', 'set', 'memory.memory_char_limit', String(plan.limits.memory)]);
  if (plan.limits.user > DEFAULT_USER_LIMIT) await hermes.run(['-p', plan.profile, 'config', 'set', 'memory.user_char_limit', String(plan.limits.user)]);
  step('memory-limits', 'set', plan.limits);

  // SOUL.md: replace Hermes' seeded default only; keep a backup. A customized SOUL is left alone.
  const soulPath = join(profileDir, 'SOUL.md');
  const currentSoul = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : '';
  if (currentSoul === plan.soul) step('soul', 'present');
  else if (!currentSoul.trim() || currentSoul.startsWith('You are Hermes Agent, built by Nous Research.')) {
    if (currentSoul) writeFileSync(soulPath + '.bak.grok-bot', currentSoul, { mode: 0o600 });
    writeFileSync(soulPath, plan.soul, { mode: 0o600 });
    step('soul', 'written');
  } else {
    plan.memory.unshift(`Grok Bot role for ${archive.capture.bot.name}: ${archive.capture.bot.instructions}`);
    step('soul', 'kept-existing', { note: 'SOUL.md was customized; the role was added to MEMORY.md instead' });
  }

  const mem = await hermes.helper('memory-add', {
    memory_char_limit: plan.limits.memory, user_char_limit: plan.limits.user,
    entries: [...plan.user.map((c) => ({ target: 'user', content: c })), ...plan.memory.map((c) => ({ target: 'memory', content: c }))],
  }, { home: profileDir });
  const refused = mem.results.filter((r) => r.status === 'refused');
  step('memory', refused.length ? 'partial' : 'done', { added: mem.results.filter((r) => r.status === 'added').length, present: mem.results.filter((r) => r.status === 'present').length, refused });

  let skillWritten = 0, skillConflicts = [];
  for (const s of plan.skills) {
    for (const f of s.files) {
      const r = writeCreateOnly(join(s.dir, f.rel), f.bytes ?? archive.read(f.path), (f.mode ?? 0o644) & 0o111 ? 0o700 : 0o600, owned);
      if (r === 'written' || r === 'updated') skillWritten++;
      if (r === 'conflict') skillConflicts.push(join(s.dir, f.rel));
    }
  }
  step('skills', skillConflicts.length ? 'partial' : 'done', { skills: plan.skills.length, filesWritten: skillWritten, conflicts: skillConflicts });

  let fileWritten = 0; const fileConflicts = [];
  for (const f of plan.files) {
    const r = writeCreateOnly(f.dest, f.bytes, (f.mode ?? 0o644) & 0o111 ? 0o700 : 0o600, owned);
    if (r === 'written' || r === 'updated') fileWritten++;
    if (r === 'conflict') fileConflicts.push(f.dest);
  }
  for (const [path, bytes] of plan.docs) {
    const r = writeCreateOnly(path, bytes, 0o600, owned);
    if (r === 'conflict') fileConflicts.push(path);
  }
  step('files', fileConflicts.length ? 'partial' : 'done', { files: plan.files.length, written: fileWritten, docs: plan.docs.size, conflicts: fileConflicts });

  const before = await hermes.helper('readback', { foreign_ids: [] }, { home: profileDir });
  const existingJobs = new Set(before.cron.map((j) => j.name));
  let created = 0;
  for (const job of plan.cron) {
    if (existingJobs.has(job.name)) continue;
    const args = ['-p', plan.profile, 'cron', 'create', '--name', job.name, '--workdir', plan.base];
    if (job.paused) args.push('--paused', '--paused-reason', job.sourceEnabled ? 'Migrated from Grok Bot; the Grok copy still runs. Resume after turning it off there.' : 'Migrated from Grok Bot, where it was turned off.');
    args.push(job.schedule, job.prompt);
    await hermes.run(args, { timeoutMs: 120_000 });
    created++;
  }
  step('cron', 'done', { jobs: plan.cron.length, created });

  const hist = await hermes.helper('import-history', {
    profile: plan.profile,
    sessions: plan.history.map((s) => ({ ...s, path: archive.root, cwd: plan.base })),
  }, { home: profileDir });
  step('history', 'done', { sessions: hist.results });

  return { profile: plan.profile, profileDir, steps };
}

/** Read the destination back through Hermes and compare with the plan. */
export async function verifyHermes(hermes, archive, plan) {
  const checks = [];
  const check = (area, ok, detail = {}) => checks.push({ area, ok, ...detail });
  const profileDir = await hermes.profileDir(plan.profile);
  const soul = existsSync(join(profileDir, 'SOUL.md')) ? readFileSync(join(profileDir, 'SOUL.md'), 'utf8') : '';
  check('role', soul === plan.soul, { where: 'SOUL.md' });
  const rb = await hermes.helper('readback', {
    memory_char_limit: plan.limits.memory, user_char_limit: plan.limits.user,
    foreign_ids: plan.history.map((s) => s.foreign_id), history_path: archive.root,
  }, { home: profileDir });
  const missingUser = plan.user.filter((e) => !rb.user.includes(e));
  const missingMem = plan.memory.filter((e) => !rb.memory.includes(e) && !e.startsWith('Grok Bot role for '));
  check('user-facts', !missingUser.length && !rb.user_prompt.includes('[BLOCKED'), { expected: plan.user.length, missing: missingUser });
  check('memory', !missingMem.length && !rb.memory_prompt.includes('[BLOCKED'), { expected: plan.memory.length, missing: missingMem });
  const missingSkills = plan.skills.filter((s) => !rb.skills.includes(s.slug) && !rb.skills.includes(skillName(archive, s)));
  check('skills', !missingSkills.length, { expected: plan.skills.length, visibleToHermes: plan.skills.length - missingSkills.length, missing: missingSkills.map((s) => s.slug) });
  const jobs = new Map(rb.cron.map((j) => [j.name, j]));
  const cronIssues = [];
  for (const job of plan.cron) {
    const j = jobs.get(job.name);
    if (!j) { cronIssues.push(`${job.name}: missing`); continue; }
    if (job.paused && j.state !== 'paused') cronIssues.push(`${job.name}: expected paused, is ${j.state}`);
    if (j.prompt !== job.prompt) cronIssues.push(`${job.name}: prompt differs`);
  }
  check('schedules', !cronIssues.length, { expected: plan.cron.length, issues: cronIssues });
  const histIssues = [];
  for (const s of plan.history) {
    const got = rb.sessions.find((r) => r.foreign_id === s.foreign_id);
    if (!got?.session_id) histIssues.push(`${s.foreign_id}: not imported`);
    else if (got.messages !== s.messages.length) histIssues.push(`${s.foreign_id}: ${got.messages}/${s.messages.length} messages`);
  }
  check('history', !histIssues.length, { sessions: plan.history.length, messages: plan.history.reduce((n, s) => n + s.messages.length, 0), issues: histIssues });
  const fileIssues = [];
  for (const f of plan.files) {
    if (!existsSync(f.dest)) { fileIssues.push(`${f.dest}: missing`); continue; }
    if (sha256(readFileSync(f.dest)) !== f.destSha256) fileIssues.push(`${f.dest}: digest differs`);
  }
  check('files', !fileIssues.length, { expected: plan.files.length, issues: fileIssues });
  return { ok: checks.every((c) => c.ok), checks };
}

function skillName(archive, s) {
  const row = s.files.find((f) => f.rel === 'SKILL.md');
  const text = row ? archive.read(row.path).toString('utf8') : '';
  return /^---[\s\S]*?\nname:\s*["']?([^\n"']+)["']?\s*\n/.exec(text)?.[1]?.trim() ?? s.slug;
}

// Words any assistant already knows; a keyword check on them proves nothing.
/** Lowercase letters and digits only, so squash-merge matches "squash merge". */
const norm = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const COMMON_TOKENS = new Set(['github', 'gitlab', 'chatgpt', 'openai', 'google', 'youtube', 'linkedin', 'iphone', 'ipad', 'javascript',
  'typescript', 'whatsapp', 'ios', 'macos', 'json', 'yaml', 'http', 'https', 'url', 'api', 'pdf', 'grok', 'hermes', 'muse', 'slack', 'telegram']);

/**
 * Distinctive tokens of a text, most specific first: identifiers with digits, #/! numbers,
 * hyphenated names, then CamelCase words. Dates, times and URLs are ignored; well-known product
 * names are skipped because an answer could contain them without any migrated data.
 */
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
 * answer, and check the answers. Each question is one real model call.
 */
export function acceptanceQuestions(archive, plan) {
  const qs = [];
  const name = archive.capture.bot.name.split(' · ')[0];
  qs.push({ area: 'role', prompt: 'In one sentence: what is your name and your job? Answer in English.', expect: [name] });
  const facts = [...new Set(plan.user.map((f) => distinctiveTokens(f, 1)[0]).filter(Boolean))].slice(0, 4);
  if (facts.length) qs.push({ area: 'user-facts', prompt: 'List every fact you remember about the user, one per line, verbatim.', expect: facts, min: Math.max(1, Math.ceil(facts.length * 0.75)) });
  if (plan.cron.length) qs.push({ area: 'schedules', prompt: 'Which of your Grok Bot routines became Hermes cron jobs, and is each one paused or active? One line per routine with its exact name.', expect: [...plan.cron.map((c) => c.name.split(': ').slice(1).join(': ')), ...(plan.cron.some((c) => c.paused) ? [['paused', '暫停', '暂停', 'pausiert', 'en pause']] : [])] });
  const openTokens = plan.open.flatMap((t) => distinctiveTokens(t.content, 1)).slice(0, 4);
  if (openTokens.length) qs.push({ area: 'open-tasks', prompt: 'Which open tasks did you carry over from Grok Bot? Reply with each task on one line.', expect: openTokens });
  const lastUser = [...(plan.history.at(-1)?.messages ?? [])].reverse().find((m) => m.role === 'user' && distinctiveTokens(m.content, 2).length);
  if (lastUser) qs.push({ area: 'history', prompt: 'Search your imported Grok Bot conversation history (session_search) and quote, verbatim, the most recent message from the user that mentions ' + JSON.stringify(distinctiveTokens(lastUser.content, 1)[0]) + '. Quote at least its first 120 characters.', expect: distinctiveTokens(lastUser.content, 2) });
  // A migrated skill must be loadable by the agent's own skills tool.
  for (const sk of plan.skills) {
    const row = sk.files.find((f) => f.rel === 'SKILL.md');
    const text = row ? archive.read(row.path).toString('utf8') : '';
    const desc = skillDescription(text);
    const token = distinctiveTokens(desc, 1)[0];
    if (!token) continue;
    qs.push({ area: 'skills', prompt: `Use your skills tool to open the skill "${skillName(archive, sk)}" and quote its description exactly.`, expect: [token] });
    break;
  }
  // A file the bot's own prompts name: find a line with a distinctive token and ask for its line number.
  for (const f of plan.files.filter((x) => x.reason === 'referenced' && x.size < 64 * 1024)) {
    const lines = f.bytes.toString('utf8').split('\n');
    const index = lines.findIndex((l, i) => i > 0 && i < 40 && distinctiveTokens(l, 1).length);
    if (index < 0) continue;
    const token = distinctiveTokens(lines[index], 1)[0];
    qs.push({ area: 'files', prompt: `Open the file ${f.dest} (migrated from the Grok box path ${f.boxPath}). Copy line ${index + 1} of it exactly, and nothing else.`, expect: [token] });
    break;
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
      const lower = answer.toLowerCase();
      const flat = norm(answer);
      const hits = q.expect.filter((t) => (Array.isArray(t) ? t : [t]).some((alt) => lower.includes(alt.toLowerCase()) || (norm(alt) && flat.includes(norm(alt)))));
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
