/** Plain-text rendering of capture coverage and import results for the terminal. */

const MARK = { complete: '✓', done: '✓', partial: '~', 'not-applicable': '-', unavailable: '·', empty: '·', failed: '✗' };

export function coverageText(coverage) {
  const lines = ['Captured from Grok Bot:'];
  for (const [area, c] of Object.entries(coverage ?? {})) {
    const bits = [];
    for (const k of ['rows', 'messages', 'count', 'open', 'captured', 'skipped', 'credentialReferences']) if (c[k] !== undefined) bits.push(`${k} ${c[k]}`);
    if (c.firstSeq !== undefined && c.lastSeq !== undefined) bits.push(`seq ${c.firstSeq}–${c.lastSeq}`);
    if (c.seqGaps) bits.push(`${c.seqGaps} deleted rows`);
    if (c.status !== 'complete' && c.reason) bits.push(c.reason.replace(/^\w+ failed: /, ''));
    if (c.note) bits.push(c.note);
    lines.push(`  ${MARK[c.status] ?? '?'} ${area.padEnd(15)} ${c.status}${bits.length ? ' — ' + bits.join('; ') : ''}`);
  }
  return lines.join('\n');
}

export function importText(r) {
  const lines = [];
  if (r.steps) {
    lines.push('Imported:');
    for (const s of r.steps) lines.push(`  ${MARK[s.status] ?? '•'} ${s.step}: ${s.status}`);
  }
  if (r.verify) {
    lines.push('', 'Read back from the destination:');
    for (const c of r.verify.checks) {
      const extra = c.missing?.length ? ` missing ${c.missing.length}` : c.issues?.length ? ` ${c.issues.join('; ')}` : '';
      const count = c.expected !== undefined ? ` (${c.expected})` : c.messages !== undefined ? ` (${c.messages} messages)` : '';
      if (c.informational) lines.push(`  – ${c.area}: ${c.found ? 'present' : 'not there (Muse keeps Memory.md short; the questions below decide)'}`);
      else lines.push(`  ${c.ok ? '✓' : '✗'} ${c.area}${count}${extra}`);
    }
  }
  if (r.acceptance) {
    lines.push('', `Acceptance (questions answered by the migrated agent${r.acceptance.freshChat ? ', in a new chat that cannot see the migration messages' : ''}):`);
    for (const a of r.acceptance.results) lines.push(`  ${a.ok ? '✓' : '✗'} ${a.area}: ${a.ok ? `answered from migrated data${a.attempts > 1 ? ' (on the second try)' : ''}` : (a.error ?? `expected ${JSON.stringify(a.expect)}`)}${a.note ? ` (${a.note})` : ''}`);
  }
  if (r.chatNote) lines.push('', 'Note: ' + r.chatNote);
  if (r.repaired?.length) lines.push('', `Re-sent once because the destination did not have them: ${r.repaired.join(', ')}`);
  if (r.deliveries) {
    lines.push('', 'Delivered:');
    for (const d of r.deliveries) lines.push(`  ${d.ok ? '✓' : '✗'} ${d.step}: ${d.state}${d.note ? ' — ' + d.note : ''}`);
  }
  const sr = r.sourceRoutines;
  const at = (x) => `${x.id || '(no id)'} "${x.name}" (${x.schedule}${x.timezone ? ' ' + x.timezone : ''})`;
  if (sr?.status === 'none') lines.push('', 'Grok Bot routines (--move-routines): none were on; nothing to pause.');
  else if (sr?.status === 'left-on') {
    lines.push('', 'Grok Bot routines (--move-routines):', `  ✗ ${sr.reason}`);
    for (const x of sr.routines) lines.push(`    - ${at(x)} is still on in Grok Bot`);
    lines.push(`  ${sr.note}`);
  } else if (sr) {
    lines.push('', 'Grok Bot routines (--move-routines):');
    for (const x of sr.routines) {
      lines.push(x.result === 'paused' ? `  ✓ paused ${at(x)}` : `  ✗ ${at(x)}: ${x.result === 'unknown' ? 'not known whether it was paused' : 'not paused'} (${x.error}); ${x.byHand}`);
    }
    if (sr.routines.some((x) => x.result === 'paused')) lines.push(`  ${sr.turnBackOn}`);
  }
  const verified = r.verify?.ok !== false && (!r.acceptance || r.acceptance.ok);
  lines.push('', r.exitCode === 0 ? 'Result: migrated and verified.'
    : verified && sr && sr.status !== 'left-on' ? 'Result: migrated and verified, but not every Grok Bot routine was paused — see the items marked ✗.'
      : 'Result: NOT fully verified — see the items marked ✗.');
  if (r.report) lines.push(`Report: ${r.report}`);
  return lines.join('\n');
}
