/**
 * The user-facing migration flow, shared by the CLI routes and the interactive wizard:
 *   bots (pick a bot) → capture (archive v2) → preview (destination diff) → import → verify → accept.
 * Hermes is imported directly; Muse and dot go through trinity-cli (migration-trinity.js).
 * With --move-routines the routines on in Grok Bot are scheduled at the destination, and after the
 * destination verified they are paused in Grok Bot (one write per routine, never repeated).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { captureBot, DEFAULT_MAX_FILE_BYTES, routinesOn } from './migration-capture.js';
import { openArchive, writeArchive } from './migration-archive.js';
import { openLiveCapture, openRoutineSwitch } from './migration-source.js';
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
  return { archive: root, files: manifest.files.length, bot: { id: cap.bot.id, name: cap.bot.name }, coverage: cap.coverage, routinesOn: routinesOn(cap.automations) };
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
// GBOT_DRIVE_REMOTE names the rclone remote for --via drive when --drive-remote is not given.
const trinityOpts = ({ via, history, skills, folder, driveRemote, driveFolder }) => ({ via, history, skills, folder, driveRemote: driveRemote ?? (process.env.GBOT_DRIVE_REMOTE || undefined), driveFolder });

/** @param {{archive: string, profile?: string, skills?: string, activateRoutines?: boolean, moveRoutines?: boolean, hermes?: any}} opts */
async function hermesContext({ archive, profile, skills: wanted, activateRoutines = false, moveRoutines = false, hermes }) {
  const skills = hermesSkills(wanted);
  const opened = openArchive(archive);
  const h = hermes ?? new Hermes();
  const name = profile ?? buildHermesPlan(opened, { profileDir: '/', skills }).profile;
  const dest = await inspectHermes(h, { profile: name });
  const plan = buildHermesPlan(opened, { profile: name, profileDir: dest.profileDir, skills, activateRoutines, moveRoutines });
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

// --- routines: --move-routines ------------------------------------------------------------------
const ROUTINE_TOGGLE = 'in the Grok Bot app: Routines → toggle';
const DEST = { hermes: 'Hermes', muse: 'Muse', dot: 'Your dot' };
const routineLabel = (r) => `"${r.name}" (${r.schedule}${r.timezone ? ' ' + r.timezone : ''})`;

/** Hermes: the jobs created active for routines on in Grok Bot, with the job name to pause one by hand. */
const hermesScheduled = (plan) => plan.cron.filter((c) => c.sourceEnabled && !c.paused)
  .map((c) => ({ id: c.sourceId, name: c.routine, schedule: c.schedule, timezone: c.timezone ?? null, job: c.name }));

/** Where a routine is paused by hand at the destination when its Grok Bot copy is still on. */
const pauseThere = (to, profile) => (r) => (to === 'hermes'
  ? `pause the Hermes job "${r.job}" (hermes -p ${profile} cron list, then hermes -p ${profile} cron pause <job id>)`
  : `ask ${DEST[to]} to pause its scheduled task "${r.name}"`);

/** The preview line about the routines that are on in Grok Bot. */
function routinesPreview({ to, on, moved, activate, move }) {
  if (!on.length) return null;
  const where = DEST[to];
  if (move) {
    return `Grok Bot routines → ${moved.length} of the ${on.length} on there run in ${where} from the import (created active), and once the import check passes they are paused in Grok Bot: ` +
      `${moved.map(routineLabel).join(', ') || 'none'}. Turn one back on ${ROUTINE_TOGGLE}.`;
  }
  if (activate) return `Grok Bot routines → ${on.length} on there stay on, and their copies in ${where} are created active: both run until one is turned off (--move-routines pauses the Grok Bot copies after the check).`;
  return `Grok Bot routines → ${on.length} on there stay on; in ${where} they are ${to === 'hermes' ? 'created paused' : 'only written to ROUTINES.md'} (--move-routines turns them on in ${where} and pauses them in Grok Bot once the import check passes).`;
}

/**
 * --move-routines after the import: pause in Grok Bot the routines the destination now runs.
 * Nothing is paused unless the destination passed (`passed`). One call per routine, never repeated:
 * a pause that failed or whose effect is unknown is reported with how to do it by hand.
 * `routineSwitch.setEnabled(agentId, automationId, false)` resolves the routine as the answer lists it.
 * @param {{routines: Array<{id: string, name: string, schedule: string, timezone: string|null, job?: string}>, passed: boolean, agentId: string, routineSwitch: {setEnabled: Function}, pauseHere: (r: any) => string, onProgress?: (t: string) => void}} opts
 */
export async function pauseSourceRoutines({ routines, passed, agentId, routineSwitch, pauseHere, onProgress = () => {} }) {
  if (!routines.length) return { status: 'none', routines: [] };
  if (!passed) {
    return { status: 'left-on', reason: 'source routines left on: verification did not pass', routines: routines.map((r) => ({ ...r, result: 'left-on' })),
      note: 'Their copies at the destination were created active, so both copies run until one is turned off: pause the destination copy, or fix what did not verify and run the same import again.' };
  }
  const out = [];
  for (const r of routines) {
    const byHand = `turn "${r.name}" off ${ROUTINE_TOGGLE}, or ${pauseHere(r)}`;
    if (!r.id) { out.push({ ...r, result: 'failed', error: 'the capture has no id for this routine', byHand }); continue; }
    onProgress(`pausing routine "${r.name}" in Grok Bot`);
    try {
      const now = await routineSwitch.setEnabled(agentId, r.id, false);
      if (now?.enabled === false) out.push({ ...r, result: 'paused' });
      else out.push({ ...r, result: now ? 'failed' : 'unknown', error: now ? 'the answer still shows it on' : 'the answer does not list this routine', byHand });
    } catch (error) {
      // A timeout, a lost connection or a server error may have landed: unknown, not failed.
      const unknown = error?.effect === 'unknown' || error?.code === 'GATEWAY_REQUEST_FAILED' || Number(error?.status) >= 500;
      out.push({ ...r, result: unknown ? 'unknown' : 'failed', error: String(error?.message ?? error).slice(0, 300), byHand });
    }
  }
  const paused = out.filter((r) => r.result === 'paused').length;
  return { status: paused === out.length ? 'paused' : paused ? 'partial' : 'not-paused', routines: out, turnBackOn: `Turn one back on ${ROUTINE_TOGGLE}.` };
}

const routinesDone = (s) => !s || s.status === 'paused' || s.status === 'none';

/** @param {{archive: string, to: string, profile?: string, skills?: string, via?: string, history?: string, folder?: string, driveRemote?: string, driveFolder?: string, keepDrive?: boolean, activateRoutines?: boolean, moveRoutines?: boolean, hermes?: any}} opts */
export async function previewMigration({ archive, to, profile, skills, via, history, folder, driveRemote, driveFolder, activateRoutines = false, moveRoutines = false, hermes }) {
  const activate = activateRoutines || moveRoutines;
  if (to !== 'hermes') {
    const { previewTrinity } = await import('./migration-trinity.js');
    const p = await previewTrinity({ archive, to, activateRoutines: activate, ...trinityOpts({ via, history, skills, folder, driveRemote, driveFolder }) });
    const line = routinesPreview({ to, on: p.routinesOn, moved: p.plan.scheduled, activate, move: moveRoutines });
    return line ? { ...p, summary: p.summary + '\n' + line } : p;
  }
  const { opened, dest, plan } = await hermesContext({ archive, profile, skills, activateRoutines: activate, moveRoutines, hermes });
  const line = routinesPreview({ to, on: routinesOn(opened.capture.automations), moved: hermesScheduled(plan), activate, move: moveRoutines });
  return { exitCode: 0, to, destination: dest, summary: summarizeHermesPlan(plan, dest) + (line ? '\n' + line : ''), plan: planFacts(plan) };
}

/** @param {{archive: string, to: string, account?: string, profile?: string, skills?: string, via?: string, history?: string, folder?: string, driveRemote?: string, driveFolder?: string, keepDrive?: boolean, yes?: boolean, accept?: boolean, intoExisting?: boolean, activateRoutines?: boolean, moveRoutines?: boolean, hermes?: any, exec?: any, routineSwitch?: any, onProgress?: (t: string) => void}} opts */
export async function importMigration({ archive, to, account, profile, skills, via, history, folder, driveRemote, driveFolder, keepDrive = false, yes = false, accept = true, intoExisting = false, activateRoutines = false, moveRoutines = false, hermes, exec, routineSwitch, onProgress = progress }) {
  if (!yes) throw new MigrationError('Review gbot migrate preview first, then pass --yes to import.');
  // Opened before anything changes: a login that cannot make the pause stops the import here.
  const control = moveRoutines ? (routineSwitch ?? openRoutineSwitch({ account })) : null;
  const activate = activateRoutines || moveRoutines;
  if (to !== 'hermes') {
    const { importTrinity } = await import('./migration-trinity.js');
    const r = await importTrinity({ archive, to, accept, activateRoutines: activate, onProgress, keepDrive, ...(exec ? { exec } : {}), ...trinityOpts({ via, history, skills, folder, driveRemote, driveFolder }) });
    if (!control) return r;
    // Muse/dot: delivered, read back (their schedules too), and the acceptance questions passed.
    const passed = r.exitCode === 0 && r.acceptance?.ok === true && r.verify.checks.some((c) => c.area === 'schedules read-back' && c.ok && !c.informational);
    const sourceRoutines = await pauseSourceRoutines({ routines: r.scheduled ?? [], passed, agentId: r.botId, routineSwitch: control, pauseHere: pauseThere(to), onProgress });
    const { report: path, ...rest } = r;
    const report = { ...rest, exitCode: r.exitCode === 0 && routinesDone(sourceRoutines) ? 0 : 3, sourceRoutines };
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return { ...report, report: path };
  }
  const { opened, hermes: h, dest, plan } = await hermesContext({ archive, profile, skills, activateRoutines: activate, moveRoutines, hermes });
  const applied = await applyHermes(h, opened, plan, { onProgress, allowExisting: intoExisting });
  onProgress('reading the destination back');
  const verified = await verifyHermes(h, opened, plan);
  let acceptance = null;
  if (accept) acceptance = await acceptHermes(h, opened, plan, { onProgress, usageDir: usageDir(opened.root, to, plan.profile) });
  const ok = verified.ok && (!acceptance || acceptance.ok);
  const sourceRoutines = control ? await pauseSourceRoutines({ routines: hermesScheduled(plan), passed: ok, agentId: opened.capture.bot.id,
    routineSwitch: control, pauseHere: pauseThere(to, plan.profile), onProgress }) : undefined;
  const report = { exitCode: ok && routinesDone(sourceRoutines) ? 0 : 3, to, profile: plan.profile, destination: dest.hermesVersion, archive: opened.root,
    bot: opened.capture.bot.name, steps: applied.steps, verify: verified, acceptance, ...(sourceRoutines ? { sourceRoutines } : {}), plan: planFacts(plan), finishedAt: new Date().toISOString() };
  const path = reportPath(opened.root, to, plan.profile);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return { ...report, report: path };
}

/**
 * Read the destination back (and with accept, ask again). Never delivers: for Muse/dot it runs
 * trinity-cli migrate --check-only, so a step that was not delivered is reported, not sent.
 * Never pauses a Grok Bot routine. Use the same --via/--history/--skills/--folder and routine
 * options as the import (--move-routines and --activate-routines plan the same destination).
 * @param {{archive: string, to: string, profile?: string, skills?: string, via?: string, history?: string, folder?: string, driveRemote?: string, driveFolder?: string, keepDrive?: boolean, accept?: boolean, activateRoutines?: boolean, moveRoutines?: boolean, onProgress?: (t: string) => void}} opts
 */
export async function checkMigration({ archive, to, profile, skills, via, history, folder, driveRemote, driveFolder, accept = false, activateRoutines = false, moveRoutines = false, onProgress = progress }) {
  const activate = activateRoutines || moveRoutines;
  if (to !== 'hermes') {
    const { checkTrinity } = await import('./migration-trinity.js');
    return checkTrinity({ archive, to, accept, activateRoutines: activate, onProgress, ...trinityOpts({ via, history, skills, folder, driveRemote, driveFolder }) });
  }
  const { opened, hermes, plan } = await hermesContext({ archive, profile, skills, activateRoutines: activate, moveRoutines });
  const verified = await verifyHermes(hermes, opened, plan);
  const acceptance = accept ? await acceptHermes(hermes, opened, plan, { onProgress, usageDir: usageDir(opened.root, to, plan.profile) }) : null;
  const ok = verified.ok && (!acceptance || acceptance.ok);
  const report = { exitCode: ok ? 0 : 3, to, profile: plan.profile, verify: verified, acceptance, checkedAt: new Date().toISOString() };
  const path = join(dirname(opened.root), `${basename(opened.root)}.${to}-${plan.profile}.check-${report.checkedAt.replace(/[-:.]/g, '').slice(0, 15)}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return { ...report, report: path };
}

/** Capture, preview and (with --yes) import, verify and accept, in one command. */
/** @param {{account?: string, bot: string, to: string, profile?: string, out?: string, maxFileMb?: number, skills?: string, via?: string, history?: string, folder?: string, driveRemote?: string, driveFolder?: string, keepDrive?: boolean, yes?: boolean, accept?: boolean, intoExisting?: boolean, activateRoutines?: boolean, moveRoutines?: boolean, onProgress?: (t: string) => void}} opts */
export async function runMigration({ account, bot, to, profile, out, maxFileMb, skills, via, history, folder, driveRemote, driveFolder, keepDrive = false, yes = false, accept = true, intoExisting = false, activateRoutines = false, moveRoutines = false, onProgress = progress }) {
  const captured = await captureToArchive({ account, bot, out, maxFileMb, onProgress });
  const preview = await previewMigration({ archive: captured.archive, to, profile, skills, via, history, folder, driveRemote, driveFolder, activateRoutines, moveRoutines });
  if (!yes) {
    return { exitCode: 0, stage: 'preview', captured, preview,
      next: `gbot migrate import ${JSON.stringify(captured.archive)} --to ${to}${profile ? ' --profile ' + profile : ''}${via && via !== 'auto' ? ' --via ' + via : ''}${history ? ' --history ' + history : ''}${skills ? ' --skills ' + skills : ''}${folder ? ' --folder ' + folder : ''}${driveRemote ? ' --drive-remote ' + driveRemote : ''}${driveFolder ? ' --drive-folder ' + driveFolder : ''}${moveRoutines ? `${account ? ' --account ' + account : ''} --move-routines` : activateRoutines ? ' --activate-routines' : ''} --yes` };
  }
  const imported = await importMigration({ archive: captured.archive, to, account, profile, skills, via, history, folder, driveRemote, driveFolder, keepDrive, yes, accept, intoExisting, activateRoutines, moveRoutines, onProgress });
  return { exitCode: imported.exitCode, stage: 'imported', captured, preview: { summary: preview.summary }, imported };
}
