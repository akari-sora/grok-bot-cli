/**
 * The user-facing migration flow, shared by the CLI routes and the interactive wizard:
 *   bots (pick a bot) → capture (archive v2) → preview (destination diff) → import → verify → accept.
 * Hermes is imported directly; Muse and dot go through trinity-cli (migration-trinity.js).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { captureBot, DEFAULT_MAX_FILE_BYTES } from './migration-capture.js';
import { openArchive, writeArchive } from './migration-archive.js';
import { openLiveCapture } from './migration-source.js';
import { Hermes, acceptHermes, applyHermes, buildHermesPlan, inspectHermes, summarizeHermesPlan, verifyHermes } from './migration-hermes.js';
import { MigrationError } from './migration.js';

const progress = (text) => process.stderr.write(`gbot migrate: ${text}\n`);

export function migrationsHome(env = process.env) {
  return env.GBOT_MIGRATIONS_DIR || join(homedir(), '.grok-bot-cli', 'migrations');
}

/** A roster row matching an id, a full name, the name before " · ", or a title. */
export function resolveBot(agents, ref) {
  const needle = String(ref ?? '').trim().toLowerCase();
  if (!needle) throw new MigrationError('Choose a bot: --bot NAME_OR_ID (see gbot migrate bots).');
  const bots = agents.filter((a) => a.kind !== 'GROK_BOT_AGENT_KIND_ROOM');
  const byId = bots.filter((a) => a.agentId?.toLowerCase() === needle || a.legacyAgentId?.toLowerCase() === needle);
  if (byId.length === 1) return byId[0];
  for (const match of [
    (a) => a.name?.toLowerCase() === needle,
    (a) => a.name?.split(' · ')[0].toLowerCase() === needle,
    (a) => a.title && a.title.toLowerCase() === needle,
  ]) {
    const found = bots.filter(match);
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new MigrationError(`Several bots match "${ref}": ${found.map((a) => `${a.name} (${a.agentId})`).join(', ')}. Use the id.`);
  }
  throw new MigrationError(`No bot named "${ref}". Run gbot migrate bots to list them.`);
}

/** @param {{account?: string}} [opts] */
export async function listBots({ account } = {}) {
  const io = await openLiveCapture({ account });
  const roster = await io.rpc('ListGrokBotAgents', {});
  return (roster?.agents ?? []).filter((a) => a?.agentId && a.kind !== 'GROK_BOT_AGENT_KIND_ROOM')
    .map((a) => ({ id: a.agentId, name: a.name ?? '', title: a.title ?? '', instructionsChars: (a.description ?? '').length,
      updatedAt: a.updatedAtMs ? new Date(Number(a.updatedAtMs)).toISOString() : null }));
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const slug = (name, id) => (String(name).split(' · ')[0].normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || id.slice(0, 8)).slice(0, 40);

/** @param {{account?: string, bot: string, out?: string, maxFileMb?: number, timeZone?: string, onProgress?: (t: string) => void}} opts */
export async function captureToArchive({ account, bot, out, maxFileMb, timeZone, onProgress = progress }) {
  const io = await openLiveCapture({ account, onProgress });
  const roster = await io.rpc('ListGrokBotAgents', {});
  const row = resolveBot(roster?.agents ?? [], bot);
  const target = out ? resolve(out) : join(migrationsHome(), `${slug(row.name, row.agentId)}-${stamp()}`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const cap = await captureBot(io, {
    agentId: row.agentId,
    timeZone: timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    maxFileBytes: maxFileMb ? Math.round(maxFileMb * 1024 * 1024) : DEFAULT_MAX_FILE_BYTES,
  });
  onProgress('writing archive');
  const { root, manifest } = writeArchive(cap, target);
  openArchive(root); // verify what was written, byte for byte
  return { archive: root, files: manifest.files.length, bot: { id: cap.bot.id, name: cap.bot.name }, coverage: cap.coverage };
}

function usageDir(archiveRoot, to, profile) {
  const dir = join(dirname(archiveRoot), `${basename(archiveRoot)}.${to}-${profile}.usage`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function reportPath(archiveRoot, to, profile) {
  return join(dirname(archiveRoot), `${basename(archiveRoot)}.${to}-${profile}.report.json`);
}

const hermesSkills = (skills = 'all') => {
  if (skills !== 'all' && skills !== 'none') throw new MigrationError('For Hermes, --skills is all or none (the whole skill folders are copied).');
  return skills;
};
const trinityOpts = ({ via, history, skills, folder }) => ({ via, history, skills, folder });

/** @param {{archive: string, profile?: string, skills?: string, activateRoutines?: boolean, hermes?: any}} opts */
async function hermesContext({ archive, profile, skills: wanted, activateRoutines = false, hermes }) {
  const skills = hermesSkills(wanted);
  const opened = openArchive(archive);
  const h = hermes ?? new Hermes();
  const name = profile ?? buildHermesPlan(opened, { profileDir: '/', skills }).profile;
  const dest = await inspectHermes(h, { profile: name });
  const plan = buildHermesPlan(opened, { profile: name, profileDir: dest.profileDir, skills, activateRoutines });
  return { opened, hermes: h, dest, plan };
}

function planFacts(plan) {
  return {
    profile: plan.profile, profileDir: plan.profileDir,
    role: { chars: plan.soul.length }, userFacts: plan.user.length, memoryEntries: plan.memory.length,
    openTasks: plan.open, skills: plan.skills.map((s) => s.slug), cron: plan.cron.map((c) => ({ name: c.name, schedule: c.schedule, timezone: c.timezone, paused: c.paused })),
    unscheduledRoutines: plan.unscheduled, historyMessages: plan.history.reduce((n, s) => n + s.messages.length, 0),
    historySessions: plan.history.length, files: plan.files.length, notMigrated: plan.notMigrated,
  };
}

/** @param {{archive: string, to: string, profile?: string, skills?: string, via?: string, history?: string, folder?: string, activateRoutines?: boolean}} opts */
export async function previewMigration({ archive, to, profile, skills, via, history, folder, activateRoutines = false }) {
  if (to !== 'hermes') {
    const { previewTrinity } = await import('./migration-trinity.js');
    return previewTrinity({ archive, to, activateRoutines, ...trinityOpts({ via, history, skills, folder }) });
  }
  const { dest, plan } = await hermesContext({ archive, profile, skills, activateRoutines });
  return { exitCode: 0, to, destination: dest, summary: summarizeHermesPlan(plan, dest), plan: planFacts(plan) };
}

/** @param {{archive: string, to: string, profile?: string, skills?: string, via?: string, history?: string, folder?: string, yes?: boolean, accept?: boolean, intoExisting?: boolean, activateRoutines?: boolean, onProgress?: (t: string) => void}} opts */
export async function importMigration({ archive, to, profile, skills, via, history, folder, yes = false, accept = true, intoExisting = false, activateRoutines = false, onProgress = progress }) {
  if (!yes) throw new MigrationError('Review gbot migrate preview first, then pass --yes to import.');
  if (to !== 'hermes') {
    const { importTrinity } = await import('./migration-trinity.js');
    return importTrinity({ archive, to, accept, activateRoutines, onProgress, ...trinityOpts({ via, history, skills, folder }) });
  }
  const { opened, hermes, dest, plan } = await hermesContext({ archive, profile, skills, activateRoutines });
  const applied = await applyHermes(hermes, opened, plan, { onProgress, allowExisting: intoExisting });
  onProgress('reading the destination back');
  const verified = await verifyHermes(hermes, opened, plan);
  let acceptance = null;
  if (accept) acceptance = await acceptHermes(hermes, opened, plan, { onProgress, usageDir: usageDir(opened.root, to, plan.profile) });
  const ok = verified.ok && (!acceptance || acceptance.ok);
  const report = { exitCode: ok ? 0 : 3, to, profile: plan.profile, destination: dest.hermesVersion, archive: opened.root,
    bot: opened.capture.bot.name, steps: applied.steps, verify: verified, acceptance, plan: planFacts(plan), finishedAt: new Date().toISOString() };
  const path = reportPath(opened.root, to, plan.profile);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return { ...report, report: path };
}

/**
 * Read the destination back (and with accept, ask again). Never delivers: for Muse/dot it runs
 * trinity-cli migrate --check-only, so a step that was not delivered is reported, not sent.
 * Use the same --via/--history/--skills/--folder as the import.
 * @param {{archive: string, to: string, profile?: string, skills?: string, via?: string, history?: string, folder?: string, accept?: boolean, activateRoutines?: boolean, onProgress?: (t: string) => void}} opts
 */
export async function checkMigration({ archive, to, profile, skills, via, history, folder, accept = false, activateRoutines = false, onProgress = progress }) {
  if (to !== 'hermes') {
    const { checkTrinity } = await import('./migration-trinity.js');
    return checkTrinity({ archive, to, accept, activateRoutines, onProgress, ...trinityOpts({ via, history, skills, folder }) });
  }
  const { opened, hermes, plan } = await hermesContext({ archive, profile, skills, activateRoutines });
  const verified = await verifyHermes(hermes, opened, plan);
  const acceptance = accept ? await acceptHermes(hermes, opened, plan, { onProgress, usageDir: usageDir(opened.root, to, plan.profile) }) : null;
  const ok = verified.ok && (!acceptance || acceptance.ok);
  const report = { exitCode: ok ? 0 : 3, to, profile: plan.profile, verify: verified, acceptance, checkedAt: new Date().toISOString() };
  const path = join(dirname(opened.root), `${basename(opened.root)}.${to}-${plan.profile}.check-${report.checkedAt.replace(/[-:.]/g, '').slice(0, 15)}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return { ...report, report: path };
}

/** Capture, preview and (with --yes) import, verify and accept, in one command. */
/** @param {{account?: string, bot: string, to: string, profile?: string, out?: string, maxFileMb?: number, skills?: string, via?: string, history?: string, folder?: string, yes?: boolean, accept?: boolean, intoExisting?: boolean, activateRoutines?: boolean, onProgress?: (t: string) => void}} opts */
export async function runMigration({ account, bot, to, profile, out, maxFileMb, skills, via, history, folder, yes = false, accept = true, intoExisting = false, activateRoutines = false, onProgress = progress }) {
  const captured = await captureToArchive({ account, bot, out, maxFileMb, onProgress });
  const preview = await previewMigration({ archive: captured.archive, to, profile, skills, via, history, folder, activateRoutines });
  if (!yes) {
    return { exitCode: 0, stage: 'preview', captured, preview,
      next: `gbot migrate import ${JSON.stringify(captured.archive)} --to ${to}${profile ? ' --profile ' + profile : ''}${via && via !== 'auto' ? ' --via ' + via : ''}${history ? ' --history ' + history : ''}${skills ? ' --skills ' + skills : ''}${folder ? ' --folder ' + folder : ''} --yes` };
  }
  const imported = await importMigration({ archive: captured.archive, to, profile, skills, via, history, folder, yes, accept, intoExisting, activateRoutines, onProgress });
  return { exitCode: imported.exitCode, stage: 'imported', captured, preview: { summary: preview.summary }, imported };
}
