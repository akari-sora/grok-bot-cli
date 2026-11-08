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
  String.raw`npm_[A-Za-z0-9]{36}`,
  String.raw`pypi-[A-Za-z0-9_-]{50,}`,
  String.raw`hf_[A-Za-z0-9]{30,}`,
  String.raw`ya29\.[A-Za-z0-9_-]{20,}`,
  String.raw`(?:sk|rk)_live_[A-Za-z0-9]{20,}`,
  String.raw`xapp-[A-Za-z0-9-]{10,}`,
  String.raw`dop_v1_[a-f0-9]{64}`,
  String.raw`shp(?:at|ss|ca)_[a-fA-F0-9]{32}`,
  String.raw`https://hooks\.slack\.com/services/[A-Za-z0-9/]{20,}`,
].map((source) => new RegExp(B + source, 'g'));
PATTERNS.push(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g);
// A key whose END line is missing (cut file, partial paste): everything from BEGIN on.
PATTERNS.push(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g);

// Encoded forms (JSON \u0067hp_…, \x67, URL %67) cannot be replaced in place. They are only
// detected: content that still holds one after redaction is not sent at all.
const decodeEscapes = (text) => text
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

/** True when a token-shaped value is in `text`, plainly or in an escaped/URL-encoded form. */
export function hasSecret(value) {
  const text = String(value ?? '');
  const decoded = decodeEscapes(text);
  return PATTERNS.some((re) => text.search(re) >= 0 || (decoded !== text && decoded.search(re) >= 0));
}

/** @returns {{ text: string, count: number }} */
export function redactSecrets(value) {
  let text = String(value ?? '');
  let count = 0;
  for (const re of PATTERNS) {
    text = text.replace(re, () => { count++; return '[redacted]'; });
  }
  return { text, count };
}

/**
 * Redact, then check what is left. `clean` is false when a value remains that could not be
 * replaced in place (an encoded token); callers must then leave the whole item out.
 * @returns {{ text: string, count: number, clean: boolean }}
 */
export function sanitize(value) {
  const r = redactSecrets(value);
  return { ...r, clean: !hasSecret(r.text) };
}

/**
 * Bytes for a destination. Text is sanitized; binary bytes cannot be redacted without corrupting
 * them, so a binary file with a token-shaped value inside (read as Latin-1) is not clean.
 * @returns {{ bytes: Buffer, count: number, clean: boolean, text: boolean }}
 */
export function sanitizeBytes(bytes) {
  if (isText(bytes)) {
    const r = sanitize(bytes.toString('utf8'));
    return { bytes: Buffer.from(r.text, 'utf8'), count: r.count, clean: r.clean, text: true };
  }
  // Text stored as UTF-16 looks binary (every other byte is 0): read it as UTF-16 too.
  const views = [bytes.toString('latin1'), bytes.toString('utf16le'), Buffer.from(bytes).swap16 && bytes.length % 2 === 0 ? Buffer.from(bytes).swap16().toString('utf16le') : ''];
  const found = views.some((v) => v && hasSecret(v));
  return { bytes, count: found ? 1 : 0, clean: !found, text: false };
}

/**
 * Last gate before anything is written to a destination or sent: redaction already ran, so a
 * match here is a bug and nothing is sent.
 */
export function assertNoSecrets(value, where) {
  if (hasSecret(value)) throw new Error(`Refusing to send ${where}: it still contains a token-shaped value.`);
}

/**
 * Text-like bytes: no NUL anywhere and valid UTF-8. The whole buffer is checked: UTF-16 text whose
 * first part has no NUL (CJK characters) still has one in every ASCII character, tokens included.
 */
export function isText(bytes) {
  if (bytes.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; }
}
