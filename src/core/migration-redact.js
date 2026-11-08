/**
 * Token-shaped secrets are kept only in the private local archive. Everything written into a
 * destination (Hermes memory, sessions, workspace files) or sent to a cloud agent (Muse, dot)
 * goes through redactSecrets first. The patterns cover the provider token formats found in real
 * Grok Bot transcripts plus the importer patterns Hermes uses.
 */
// A token can follow a JSON escape such as "\n" (the letter n), so "start of token" means: not
// preceded by a letter/digit/underscore, or preceded by a backslash escape.
const B = String.raw`(?:(?<=\\[nrtbf"'/])|(?<![A-Za-z0-9_]))`;
const PATTERNS = [
  String.raw`gh[pousr]_[A-Za-z0-9]{20,}`,
  String.raw`github_pat_[A-Za-z0-9_]{20,}`,
  String.raw`glpat-[A-Za-z0-9_-]{16,}`,
  String.raw`gl(?:rt|cbt|dt|ptt|ft|imt|agent|oas|soat)-[A-Za-z0-9_-]{16,}`,
  String.raw`sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}`,
  String.raw`xox[abprs]-[A-Za-z0-9-]{10,}`,
  String.raw`AKIA[0-9A-Z]{16}`,
  String.raw`AIza[0-9A-Za-z_-]{35}`,
  String.raw`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
  String.raw`[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*`,
  String.raw`\d{9,10}:[A-Za-z0-9_-]{35}`, // Telegram bot token
].map((source) => new RegExp(B + source, 'g'));
PATTERNS.push(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g);

/** @returns {{ text: string, count: number }} */
export function redactSecrets(value) {
  let text = String(value ?? '');
  let count = 0;
  for (const re of PATTERNS) {
    text = text.replace(re, () => { count++; return '[redacted]'; });
  }
  return { text, count };
}

/** Redact text and add the count to a running tally object. */
export function redactor() {
  const tally = { count: 0 };
  const fn = (value) => {
    const r = redactSecrets(value);
    tally.count += r.count;
    return r.text;
  };
  fn.tally = tally;
  return fn;
}

/** Text-like bytes (no NUL in the first 8 KiB and valid UTF-8). */
export function isText(bytes) {
  if (bytes.subarray(0, 8192).includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; }
}
