import { randomUUID } from 'node:crypto';
import { normalizeTranscript, transcriptDelta } from './transcript.js';

export const MAILBOX_HEADER = '[gbot-mailbox/v1]\n';
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKET_KEYS = ['id', 'from', 'to', 'topic', 'replyTo', 'body'];
const MAX_BODY = 48 * 1024;

function label(value, name, optional = false) {
  if (optional && value === null) return;
  if (typeof value !== 'string' || !LABEL.test(value)) throw new Error(`Invalid mailbox ${name}.`);
}

/** @param {{from: string, to?: string|null, topic?: string|null, replyTo?: string|null, body: string, id?: string}} fields */
export function makePacket({ from, to = null, topic = null, replyTo = null, body, id = randomUUID() }) {
  label(from, 'sender'); label(to, 'recipient', true); label(topic, 'topic', true);
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid mailbox id.');
  if (replyTo !== null && (typeof replyTo !== 'string' || !ID.test(replyTo))) throw new Error('Invalid mailbox reply id.');
  if (typeof body !== 'string' || body.length === 0 || body.includes('\0') || Buffer.byteLength(body, 'utf8') > MAX_BODY) throw new Error('Invalid mailbox body.');
  return { id, from, to, topic, replyTo, body };
}

export function encodePacket(packet) {
  const value = makePacket(packet);
  const text = MAILBOX_HEADER + JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('Encoded mailbox packet exceeds 64 KiB.');
  return text;
}

// Parse this flat string-or-null object without losing duplicate property evidence.
function parseFields(json) {
  let at = 0;
  const string = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(json[at] ?? '') && at < json.length) at++; };
  const token = (expected) => { whitespace(); if (json[at++] !== expected) throw new Error('Invalid packet'); };
  const readString = () => { whitespace(); string.lastIndex = at; const match = string.exec(json); if (!match) throw new Error('Invalid string'); at = string.lastIndex; return JSON.parse(match[0]); };
  const result = Object.create(null);
  token('{');
  for (;;) {
    whitespace(); if (json[at] === '}') { at++; break; }
    const key = readString();
    if (Object.hasOwn(result, key) || !PACKET_KEYS.includes(key)) throw new Error('Invalid field');
    token(':'); whitespace();
    if (json.startsWith('null', at)) { result[key] = null; at += 4; }
    else result[key] = readString();
    whitespace();
    if (json[at] === '}') { at++; break; }
    token(',');
    whitespace(); if (json[at] === '}') throw new Error('Trailing comma');
  }
  whitespace();
  if (at !== json.length || Object.keys(result).length !== PACKET_KEYS.length) throw new Error('Invalid packet');
  return result;
}

export function decodePacket(text) {
  if (typeof text !== 'string' || !text.startsWith(MAILBOX_HEADER) || Buffer.byteLength(text, 'utf8') > 64 * 1024) return null;
  try { return makePacket(parseFields(text.slice(MAILBOX_HEADER.length))); } catch { return null; }
}

export async function sendMailbox(backend, target, packet) {
  const out = await backend.send(target, encodePacket(packet));
  return { delivery: out.delivery === 'accepted' ? 'accepted' : 'unknown', clientNonce: out.clientNonce ?? null, messageId: out.messageId ?? null, packetId: packet.id, replyReceived: false };
}

/** @param {any} backend @param {string} target @param {{recipient: string, topic?: string|null, after?: string, limit?: number, waitSeconds?: number, includeUnattributed?: boolean, pollMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void>}} options */
export async function readMailbox(backend, target, { recipient, topic = null, after, limit = 200, waitSeconds = 0, includeUnattributed = false, pollMs = 1000, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  label(recipient, 'recipient'); label(topic, 'topic', true);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 60) throw new Error('Invalid mailbox read bounds.');
  if (after !== undefined && (typeof after !== 'string' || !after || after.length > 1024)) throw new Error('Invalid mailbox cursor.');
  const resolved = await backend.resolve(target);
  if (!resolved || typeof resolved.id !== 'string' || !resolved.id) throw new Error('Invalid resolved target.');
  const deadline = now() + waitSeconds * 1000;
  let cursor = after;
  for (;;) {
    const out = await backend.transcript(target, limit);
    if (!out?.target || out.target.id !== resolved.id) throw new Error('Mailbox transcript target mismatch.');
    if (!out.transcript || !Array.isArray(out.transcript.entries)) throw new Error('Invalid mailbox transcript.');
    const delta = transcriptDelta(out.transcript, { after: cursor, limit });
    const normalized = normalizeTranscript({ target: out.target, transcript: { entries: delta.entries } });
    const messages = normalized.messages.flatMap((entry, index) => {
      if (!entry.id) return [];
      const raw = delta.entries[index];
      const nested = raw?.message && typeof raw.message === 'object' ? raw.message : null;
      const hasUserRole = [raw?.role, raw?.kind, raw?.type, nested?.role, nested?.type].includes('user');
      const unattributed = entry.role === 'unknown' && includeUnattributed && !hasUserRole;
      if (entry.role !== 'assistant' && !unattributed) return [];
      const packet = decodePacket(entry.text);
      if (!packet || packet.from === recipient || (unattributed ? packet.to !== recipient : packet.to !== null && packet.to !== recipient) || (topic !== null && packet.topic !== topic)) return [];
      return [{ entryId: entry.id, provenance: unattributed ? 'unattributed' : 'assistant', ...packet }];
    });
    cursor = delta.cursor || cursor;
    if (messages.length || delta.gapReset || now() >= deadline) return { messages, cursor: cursor ?? null, gapReset: delta.gapReset, timedOut: !messages.length && !delta.gapReset && waitSeconds > 0, targetId: resolved.id };
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}
