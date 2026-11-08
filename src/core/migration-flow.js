/**
 * The user-facing migration flow, shared by the CLI routes and the interactive wizard:
 *   bots (pick a bot) → capture (archive v2) → preview (destination diff) → import → verify → accept.
 * Hermes is imported directly; Muse and dot go through trinity-cli (migration-trinity.js).
 * By default nothing in Grok Bot changes. With --move-routines the routines on in Grok Bot (or the
 * ones --routines names) are scheduled at the destination, and after the destination verified they
 * are paused in Grok Bot (one write per routine, never repeated).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { captureBot, DEFAULT_MAX_FILE_BYTES, memoryNotCaptured, routinesOn } from './migration-capture.js';
import { openArchive, writeArchive } from './migration-archive.js';
import { openLiveCapture, openRoutineSwitch } from './migration-source.js';
import { Hermes, acceptHermes, applyHermes, buildHermesPlan, inspectHermes, resumeHermesJob, summarizeHermesPlan, verifyHermes } from './migration-hermes.js';
import { MigrationError } from './migration.js';
import { ROUTINE_TOGGLE, routinesText } from './migration-text.js';

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

/** @param {{archive: string, profile?: string, skills?: string, activateRoutines?: boolean, moveRoutines?: boolean, routines?: string, hermes?: any}} opts */
async function hermesContext({ archive, profile, skills: wanted, activateRoutines = false, moveRoutines = false, routines, hermes }) {
  const skills = hermesSkills(wanted);
  const opened = openArchive(archive);
  const h = hermes ?? new Hermes();
  const name = profile ?? buildHermesPlan(opened, { profileDir: '/', skills }).profile;
  const dest = await inspectHermes(h, { profile: name });
  const plan = buildHermesPlan(opened, { profile: name, profileDir: dest.profileDir, skills, activateRoutines, moveRoutines, routines });
  return { opened, hermes: h, dest, plan };
}

function planFacts(plan) {
  return {
    profile: plan.profile, profileDir: plan.profileDir,
    role: { chars: plan.soul.length }, userFacts: plan.user.length, memoryEntries: plan.memory.length,
    openTasks: plan.open, skills: plan.skills.map((s) => s.slug), cron: plan.cron.map((c) => ({ name: c.name, schedule: c.schedule, timezone: c.timezone, paused: c.paused, switchOver: Boolean(c.switchOver) })),
    unscheduledRoutines: plan.unscheduled, historyMessages: plan.history.reduce((n, s) => n + s.messages.length, 0),
    historySessions: plan.history.length, files: plan.files.length, notMigrated: plan.notMigrated,
  };
}

// --- routines: --activate-routines, --move-routines, --routines ---------------------------------
const DEST = { hermes: 'Hermes', muse: 'Muse', dot: 'Your dot' };

/** True when a routine is turned on at the destination; `--routines` alone is a usage error. */
function routineFlags({ activateRoutines = false, moveRoutines = false, routines }) {
  if (routines !== undefined && !activateRoutines && !moveRoutines) {
    throw new MigrationError('--routines limits --activate-routines or --move-routines to some routines; add one of them. Without either, every routine stays as it is in Grok Bot and none is turned on at the destination.');
  }
  return activateRoutines || moveRoutines;
}

/** Hermes: the jobs that run here for routines on in Grok Bot (active, or switched over by --move-routines), with the job name. */
const hermesScheduled = (plan) => plan.cron.filter((c) => c.sourceEnabled && !c.paused)
  .map((c) => ({ id: c.sourceId, name: c.routine, schedule: c.schedule, timezone: c.timezone ?? null, job: c.name }));

const routineKey = (r) => r.id || `name:${r.name}`;

/**
 * What happens to each routine that is on in Grok Bot: at the destination `on`, `off` (Hermes:
 * created paused; Muse/dot: only in ROUTINES.md) or `not migrated`; in Grok Bot `unchanged` or
 * `paused after the check` (--move-routines: paused there first, then turned on at the destination).
 */
function routineRows({ on, active, migrated = null, move }) {
  const activeKeys = new Set(active.map(routineKey));
  const migratedKeys = migrated && new Set(migrated.map(routineKey));
  return on.map((r) => {
    const atDestination = activeKeys.has(routineKey(r)) ? 'on' : migratedKeys && !migratedKeys.has(routineKey(r)) ? 'not migrated' : 'off';
    return { ...r, atDestination, inGrokBot: move && atDestination === 'on' ? 'paused after the check' : 'unchanged', rolledBack: false };
  });
}

/** The rows with the switch-over results: at the destination and in Grok Bot, and whether it was rolled back. */
function routineOutcome(rows, switched) {
  if (!switched) return rows;
  const result = new Map(switched.map((x) => [routineKey(x), x]));
  return rows.map((r) => {
    const x = result.get(routineKey(r));
    return x ? { ...r, atDestination: x.destination, inGrokBot: x.source, rolledBack: x.rolledBack } : r;
  });
}

const stays = (where) => (where === 'Hermes' || !Object.values(DEST).includes(where) ? 'paused' : 'unscheduled');

/** How a moved routine is turned on at the destination by hand, once its Grok Bot copy is off. */
const finishThere = (to, profile) => (r) => (to === 'hermes'
  ? `resume the Hermes job "${r.job}" (hermes -p ${profile} cron list, then hermes -p ${profile} cron resume <job id>)`
  : `ask ${DEST[to]} to create its scheduled task "${r.name}" as ROUTINES.md describes`);

/**
 * --move-routines, step 1 after the import: pause in Grok Bot the routines being moved. Nothing is
 * paused unless the destination passed (`passed`); until then the destination copies are not on, so
 * nothing runs twice. One call per routine, never repeated: a pause that failed or whose effect is
 * unknown leaves the destination copy off and says how to finish by hand.
 * `routineSwitch.setEnabled(agentId, automationId, false)` resolves the routine as the answer lists it.
 * @param {{routines: Array<{id: string, name: string, schedule: string, timezone: string|null, job?: string}>, passed: boolean, agentId: string, routineSwitch: {setEnabled: Function}, finishThere: (r: any) => string, where: string, onProgress?: (t: string) => void}} opts
 */
export async function pauseSourceRoutines({ routines, passed, agentId, routineSwitch, finishThere: finish, where, onProgress = () => {} }) {
  if (!routines.length) return { status: 'none', routines: [] };
  if (!passed) {
    return { status: 'left-on', reason: 'source routines left on: verification did not pass', routines: routines.map((r) => ({ ...r, result: 'left-on' })),
      note: `Their copies in ${where} stay ${stays(where)}, so nothing runs twice: fix what did not verify and run the same import again.` };
  }
  const out = [];
  for (const r of routines) {
    const byHand = `the copy in ${where} stays ${stays(where)}; to finish the move: turn "${r.name}" off ${ROUTINE_TOGGLE}, then ${finish(r)}`;
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

const SOURCE = { 'left-on': 'left on', failed: 'not paused', unknown: 'unknown' };
const message = (e) => String(e?.message ?? e).slice(0, 300);

/**
 * --move-routines, the whole switch-over: a short gap, never an overlap. 1) pause the routine in
 * Grok Bot and confirm it off (pauseSourceRoutines); 2) only for the ones confirmed off, turn the
 * destination copy on and read it back (`turnOn(r)` → { state: 'on' | 'off' | 'unknown', error });
 * 3) when it is not on there, turn the Grok Bot routine back on and confirm it (rolled back). Each
 * step is one request per routine, never retried; a destination whose state is unknown is not
 * rolled back (it may be running there) but reported with how to check it.
 */
export async function switchOverRoutines({ routines, passed, agentId, routineSwitch, turnOn, finishThere: finish, where, onProgress = () => {} }) {
  const sourceRoutines = await pauseSourceRoutines({ routines, passed, agentId, routineSwitch, finishThere: finish, where, onProgress });
  const switched = [];
  for (const p of sourceRoutines.routines) {
    const { result, error, byHand, ...r } = p;
    if (result !== 'paused') { switched.push({ ...r, destination: 'off', source: SOURCE[result] ?? 'unknown', rolledBack: false, ...(error ? { error } : {}), ...(byHand ? { byHand } : {}) }); continue; }
    onProgress(`turning "${r.name}" on in ${where}`);
    let on;
    try { on = await turnOn(p); } catch (e) { on = { state: 'unknown', error: message(e) }; }
    const plan = on.plan ? { plan: on.plan } : {};
    if (on.state === 'on') { switched.push({ ...r, ...plan, destination: 'on', source: 'paused', rolledBack: false }); continue; }
    if (on.state !== 'off') {
      switched.push({ ...r, ...plan, destination: 'unknown', source: 'paused', rolledBack: false, error: on.error,
        byHand: `check whether "${r.name}" runs in ${where}: if it does not, ${finish(p)}, or turn it back on ${ROUTINE_TOGGLE}` });
      continue;
    }
    // Not running at the destination: turn the Grok Bot copy back on, once.
    onProgress(`turning "${r.name}" back on in Grok Bot (it could not be turned on in ${where})`);
    let rollback, rollbackError = null;
    try {
      const now = await routineSwitch.setEnabled(agentId, r.id, true);
      rollback = now?.enabled === true ? 'done' : now ? 'failed' : 'unknown';
      if (rollback !== 'done') rollbackError = now ? 'the answer still shows it off' : 'the answer does not list this routine';
    } catch (e) {
      rollback = e?.effect === 'unknown' || e?.code === 'GATEWAY_REQUEST_FAILED' || Number(e?.status) >= 500 ? 'unknown' : 'failed';
      rollbackError = message(e);
    }
    if (rollback === 'done') switched.push({ ...r, ...plan, destination: 'off', source: 'on again', rolledBack: true, error: on.error });
    else switched.push({ ...r, ...plan, destination: 'off', source: 'paused', rolledBack: false, rollback, error: on.error, rollbackError,
      byHand: `turn "${r.name}" back on ${ROUTINE_TOGGLE}, or ${finish(p)}` });
  }
  return { sourceRoutines, switchOver: switched };
}

/** The Hermes plan as the import first applies it: a job being moved is created paused (switched over later). */
const stagedPlan = (plan) => ({ ...plan, cron: plan.cron.map((c) => (c.switchOver ? { ...c, paused: true } : c)) });

/** Every moved routine is paused in Grok Bot and on at the destination. */
const switchedOver = (switched) => !switched || switched.every((x) => x.destination === 'on' && x.source === 'paused');

/** @param {{archive: string, to: string, profile?: string, skills?: string, via?: string, history?: string, folder?: string, driveRemote?: string, driveFolder?: string, keepDrive?: boolean, activateRoutines?: boolean, moveRoutines?: boolean, routines?: string, hermes?: any}} opts */
export async function previewMigration({ archive, to, profile, skills, via, history, folder, driveRemote, driveFolder, activateRoutines = false, moveRoutines = false, routines, hermes }) {
  const activate = routineFlags({ activateRoutines, moveRoutines, routines });
  const withRoutines = (p, rows) => (rows.length ? { ...p, summary: p.summary + '\n' + routinesText(to, rows, { activate, move: moveRoutines }), routines: rows } : p);
  if (to !== 'hermes') {
    const { previewTrinity } = await import('./migration-trinity.js');
    const p = await previewTrinity({ archive, to, activateRoutines: activate, routines, switchOver: moveRoutines, ...trinityOpts({ via, history, skills, folder, driveRemote, driveFolder }) });
    return withRoutines(p, routineRows({ on: p.routinesOn, active: p.plan.scheduled, move: moveRoutines }));
  }
  const { opened, dest, plan } = await hermesContext({ archive, profile, skills, activateRoutines: activate, moveRoutines, routines, hermes });
  const rows = routineRows({ on: routinesOn(opened.capture.automations), active: hermesScheduled(plan), migrated: plan.cron.map((c) => ({ id: c.sourceId, name: c.routine })), move: moveRoutines });
  return withRoutines({ exitCode: 0, to, destination: dest, summary: summarizeHermesPlan(stagedPlan(plan), dest), plan: planFacts(plan) }, rows);
}

/** @param {{archive: string, to: string, account?: string, profile?: string, skills?: string, via?: string, history?: string, folder?: string, driveRemote?: string, driveFolder?: string, keepDrive?: boolean, yes?: boolean, accept?: boolean, intoExisting?: boolean, activateRoutines?: boolean, moveRoutines?: boolean, routines?: string, hermes?: any, exec?: any, routineSwitch?: any, onProgress?: (t: string) => void}} opts */
export async function importMigration({ archive, to, account, profile, skills, via, history, folder, driveRemote, driveFolder, keepDrive = false, yes = false, accept = true, intoExisting = false, activateRoutines = false, moveRoutines = false, routines, hermes, exec, routineSwitch, onProgress = progress }) {
  if (!yes) throw new MigrationError('Review gbot migrate preview first, then pass --yes to import.');
  const activate = routineFlags({ activateRoutines, moveRoutines, routines });
  // Opened before anything changes: a login that cannot make the pause stops the import here.
  // Without --move-routines there is no switch at all: nothing in Grok Bot can change.
  const control = moveRoutines ? (routineSwitch ?? openRoutineSwitch({ account })) : null;
  if (to !== 'hermes') {
    const { importTrinity, runSwitchPlan } = await import('./migration-trinity.js');
    const r = await importTrinity({ archive, to, accept, activateRoutines: activate, routines, switchOver: moveRoutines, onProgress, keepDrive, ...(exec ? { exec } : {}), ...trinityOpts({ via, history, skills, folder, driveRemote, driveFolder }) });
    const { report: path, switchPlans = [], ...rest } = r;
    // Muse/dot: the folder delivered and read back, and the acceptance questions passed. Then, per
    // routine, the Grok Bot copy is paused and only after that the schedule is created and read back.
    const passed = r.exitCode === 0 && r.acceptance?.ok === true;
    const plans = new Map(switchPlans.map((e) => [routineKey(e.routine), e]));
    const moved = control ? await switchOverRoutines({ routines: r.scheduled ?? [], passed, agentId: r.botId, routineSwitch: control, where: DEST[to], finishThere: finishThere(to), onProgress,
      turnOn: (x) => runSwitchPlan({ archive: r.archive, to, entry: plans.get(routineKey(x)), ...(exec ? { exec } : {}) }) }) : null;
    const rows = routineOutcome(routineRows({ on: r.routinesOn ?? [], active: r.scheduled ?? [], move: moveRoutines }), moved?.switchOver);
    const report = { ...rest, exitCode: r.exitCode === 0 && switchedOver(moved?.switchOver) ? 0 : 3, ...(rows.length ? { routines: rows } : {}), ...(moved ?? {}) };
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return { ...report, report: path };
  }
  const { opened, hermes: h, dest, plan } = await hermesContext({ archive, profile, skills, activateRoutines: activate, moveRoutines, routines, hermes });
  // A routine being moved is created paused here; it is resumed only once its Grok Bot copy is off.
  const staged = stagedPlan(plan);
  const applied = await applyHermes(h, opened, staged, { onProgress, allowExisting: intoExisting });
  onProgress('reading the destination back');
  const verified = await verifyHermes(h, opened, staged);
  let acceptance = null;
  if (accept) acceptance = await acceptHermes(h, opened, staged, { onProgress, usageDir: usageDir(opened.root, to, plan.profile) });
  const ok = verified.ok && (!acceptance || acceptance.ok);
  const jobs = new Map(plan.cron.map((c) => [routineKey({ id: c.sourceId, name: c.routine }), c]));
  const moved = control ? await switchOverRoutines({ routines: hermesScheduled(plan), passed: ok, agentId: opened.capture.bot.id, routineSwitch: control,
    where: 'Hermes', finishThere: finishThere(to, plan.profile), onProgress, turnOn: (x) => resumeHermesJob(h, plan, jobs.get(routineKey(x))) }) : null;
  const rows = routineOutcome(routineRows({ on: routinesOn(opened.capture.automations), active: hermesScheduled(plan),
    migrated: plan.cron.map((c) => ({ id: c.sourceId, name: c.routine })), move: moveRoutines }), moved?.switchOver);
  const report = { exitCode: ok && switchedOver(moved?.switchOver) ? 0 : 3, to, profile: plan.profile, destination: dest.hermesVersion, archive: opened.root,
    bot: opened.capture.bot.name, steps: applied.steps, verify: verified, acceptance, ...(rows.length ? { routines: rows } : {}), ...(moved ?? {}), ...memoryNotCaptured(opened.capture), plan: planFacts(plan), finishedAt: new Date().toISOString() };
  const path = reportPath(opened.root, to, plan.profile);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return { ...report, report: path };
}

/**
 * Read the destination back (and with accept, ask again). Never delivers: for Muse/dot it runs
 * trinity-cli migrate --check-only, so a step that was not delivered is reported, not sent.
 * Never pauses a Grok Bot routine. Use the same --via/--history/--skills/--folder and routine
 * options as the import (--move-routines and --activate-routines plan the same destination, and
 * --routines must name the same routines).
 * @param {{archive: string, to: string, profile?: string, skills?: string, via?: string, history?: string, folder?: string, driveRemote?: string, driveFolder?: string, keepDrive?: boolean, accept?: boolean, activateRoutines?: boolean, moveRoutines?: boolean, routines?: string, hermes?: any, exec?: any, onProgress?: (t: string) => void}} opts
 */
export async function checkMigration({ archive, to, profile, skills, via, history, folder, driveRemote, driveFolder, accept = false, activateRoutines = false, moveRoutines = false, routines, hermes: injected, exec, onProgress = progress }) {
  const activate = routineFlags({ activateRoutines, moveRoutines, routines });
  if (to !== 'hermes') {
    const { checkTrinity, runSwitchPlan } = await import('./migration-trinity.js');
    const { switchPlans = [], ...r } = await checkTrinity({ archive, to, accept, activateRoutines: activate, routines, switchOver: moveRoutines, onProgress, ...(exec ? { exec } : {}), ...trinityOpts({ via, history, skills, folder, driveRemote, driveFolder }) });
    if (!switchPlans.length) return r;
    // --move-routines: each moved routine's schedule, read back from its own switch plan (never sent).
    for (const entry of switchPlans) {
      const s = await runSwitchPlan({ archive: r.archive, to, entry, checkOnly: true, ...(exec ? { exec } : {}) });
      r.verify.checks.push({ area: `schedule "${entry.routine.name}" read-back`, ok: s.state === 'on', informational: false, ...(s.error ? { issues: [s.error] } : {}) });
    }
    r.verify.ok = r.verify.checks.every((c) => c.ok !== false);
    const { report: path, ...rest } = r;
    const report = { ...rest, exitCode: r.exitCode === 0 && r.verify.ok ? 0 : 3 };
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return { ...report, report: path };
  }
  const { opened, hermes, plan } = await hermesContext({ archive, profile, skills, activateRoutines: activate, moveRoutines, routines, hermes: injected });
  const verified = await verifyHermes(hermes, opened, plan);
  const acceptance = accept ? await acceptHermes(hermes, opened, plan, { onProgress, usageDir: usageDir(opened.root, to, plan.profile) }) : null;
  const ok = verified.ok && (!acceptance || acceptance.ok);
  const report = { exitCode: ok ? 0 : 3, to, profile: plan.profile, verify: verified, acceptance, ...memoryNotCaptured(opened.capture), checkedAt: new Date().toISOString() };
  const path = join(dirname(opened.root), `${basename(opened.root)}.${to}-${plan.profile}.check-${report.checkedAt.replace(/[-:.]/g, '').slice(0, 15)}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return { ...report, report: path };
}

/** Capture, preview and (with --yes) import, verify and accept, in one command. */
/** @param {{account?: string, bot: string, to: string, profile?: string, out?: string, maxFileMb?: number, skills?: string, via?: string, history?: string, folder?: string, driveRemote?: string, driveFolder?: string, keepDrive?: boolean, yes?: boolean, accept?: boolean, intoExisting?: boolean, activateRoutines?: boolean, moveRoutines?: boolean, routines?: string, onProgress?: (t: string) => void}} opts */
export async function runMigration({ account, bot, to, profile, out, maxFileMb, skills, via, history, folder, driveRemote, driveFolder, keepDrive = false, yes = false, accept = true, intoExisting = false, activateRoutines = false, moveRoutines = false, routines, onProgress = progress }) {
  routineFlags({ activateRoutines, moveRoutines, routines });
  const captured = await captureToArchive({ account, bot, out, maxFileMb, onProgress });
  const preview = await previewMigration({ archive: captured.archive, to, profile, skills, via, history, folder, driveRemote, driveFolder, activateRoutines, moveRoutines, routines });
  if (!yes) {
    return { exitCode: 0, stage: 'preview', captured, preview,
      next: `gbot migrate import ${JSON.stringify(captured.archive)} --to ${to}${profile ? ' --profile ' + profile : ''}${via && via !== 'auto' ? ' --via ' + via : ''}${history ? ' --history ' + history : ''}${skills ? ' --skills ' + skills : ''}${folder ? ' --folder ' + folder : ''}${driveRemote ? ' --drive-remote ' + driveRemote : ''}${driveFolder ? ' --drive-folder ' + driveFolder : ''}${moveRoutines ? `${account ? ' --account ' + account : ''} --move-routines` : activateRoutines ? ' --activate-routines' : ''}${routines ? ' --routines ' + JSON.stringify(routines) : ''} --yes` };
  }
  const imported = await importMigration({ archive: captured.archive, to, account, profile, skills, via, history, folder, driveRemote, driveFolder, keepDrive, yes, accept, intoExisting, activateRoutines, moveRoutines, routines, onProgress });
  return { exitCode: imported.exitCode, stage: 'imported', captured, preview: { summary: preview.summary }, imported };
}
