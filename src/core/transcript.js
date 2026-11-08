/** Coerce anything to a string without throwing (numbers, BigInt, unserializable objects). */
function toSafeText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    const out = JSON.stringify(value);
    return typeof out === "string" ? out : "";
  } catch {
    return "[unserializable]";
  }
}

/** Coerce to string and replace lone surrogates so downstream slicing/JSON never breaks. */
function normalizeText(value) {
  return toSafeText(value).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

export function entryText(e) {
  return normalizeText(entryTextRaw(e));
}

function entryTextRaw(e) {
  if (!e || typeof e !== "object") return "";
  // Prefer full body fields over `preview` (often truncated for list UIs).
  const direct = e.text || e.prompt || e.message;
  if (typeof direct === "string" && direct) return direct;
  const content = e.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return joinContentParts(content);
  if (content && typeof content === "object") return content.text || toSafeText(content);
  // Bot replies arrive as `{ kind: "send-message", message: { type, content } }`.
  if (e.message && typeof e.message === "object") {
    if (typeof e.message.text === "string" && e.message.text) return e.message.text;
    if (typeof e.message.content === "string" && e.message.content) return e.message.content;
    if (Array.isArray(e.message.content)) return joinContentParts(e.message.content);
  }
  return typeof e.preview === "string" ? e.preview : "";
}

function joinContentParts(content) {
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object") return part.text || part.content || "";
    return "";
  }).filter(Boolean).join("\n");
}

export function transcriptEntries(payload) {
  if (!payload || typeof payload !== "object") return [];
  return Array.isArray(payload.entries) ? payload.entries : [];
}

export function sourceEntryId(entry) {
  if (!entry || typeof entry !== "object") return "";
  return typeof entry.id === "string" ? entry.id : "";
}

function lastSourceId(entries, fallback = "") {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const id = sourceEntryId(entries[index]);
    if (id) return id;
  }
  return fallback;
}

// Entries up to the first row whose body could not be read yet (its store blob was unavailable):
// a cursor never passes such a row, so the next poll reads it again instead of skipping it, and
// nothing after it is returned twice.
function untilUnreadable(entries) {
  const held = entries.findIndex((entry) => entry && typeof entry === "object" && entry.unreadable === true);
  return held === -1 ? entries : entries.slice(0, held);
}

export function transcriptDelta(payload, { after, limit = 40 } = /** @type {{ after?: string, limit?: number }} */ ({})) {
  const bounded = Math.min(Math.max(Math.trunc(limit) || 40, 1), 200);
  const page = untilUnreadable(transcriptEntries(payload).slice(-bounded));
  if (after === undefined) {
    const gapReset = page.length > 0 && !sourceEntryId(page[page.length - 1]);
    return { cursor: lastSourceId(page), entries: page, entryCount: page.length, gapReset };
  }
  const afterIndex = page.findIndex((entry) => sourceEntryId(entry) === after);
  if (afterIndex === -1) {
    return { cursor: lastSourceId(page), entries: page, entryCount: page.length, gapReset: true };
  }
  const entries = page.slice(afterIndex + 1);
  if (entries.length > 0 && !sourceEntryId(entries[entries.length - 1])) {
    return { cursor: lastSourceId(page), entries: page, entryCount: page.length, gapReset: true };
  }
  return { cursor: lastSourceId(entries, after), entries, entryCount: entries.length, gapReset: false };
}

function evidenceText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => evidenceText(part)).filter(Boolean).join("\n");
  }
  if (!value || typeof value !== "object") return "";
  const candidates = ["text", "prompt", "message", "preview", "content"]
    .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
    .map((key) => evidenceText(value[key]))
    .filter(Boolean);
  if (new Set(candidates).size > 1) {
    throw new Error("Conflicting transcript text evidence.");
  }
  return candidates[0] ?? "";
}

function explicitRole(entry) {
  const nested = entry.message && typeof entry.message === "object" && !Array.isArray(entry.message)
    ? entry.message
    : null;
  const candidates = [nested?.type, nested?.role, entry.role, entry.kind, entry.type];
  const roles = new Set();
  for (const candidate of candidates) {
    if (candidate === "user" || candidate === "assistant") roles.add(candidate);
  }
  return roles.size === 1 ? roles.values().next().value : "unknown";
}

function isNonblankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function strictTranscriptEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid transcript container.");
  }
  for (const key of ["entries", "messages", "items"]) {
    if (!(key in payload)) continue;
    if (!Array.isArray(payload[key])) throw new Error("Invalid transcript container.");
    return payload[key];
  }
  throw new Error("Invalid transcript container.");
}

function normalizedMessageId(entry) {
  const candidates = [];
  for (const key of ["id", "messageId"]) {
    if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
    const value = entry[key];
    if (value !== null && !isNonblankString(value)) {
      throw new Error("Invalid transcript message id.");
    }
    if (value !== null) candidates.push(value);
  }
  if (new Set(candidates).size > 1) {
    throw new Error("Invalid transcript message id.");
  }
  return candidates[0] ?? null;
}

/** Stable adapter shape. Display `entryText` may stringify non-text content; this does not. */
export function normalizeTranscript(out) {
  if (!out || typeof out !== "object" || Array.isArray(out)) {
    throw new Error("Invalid transcript response.");
  }
  const target = out.target;
  if (
    !target
    || typeof target !== "object"
    || Array.isArray(target)
    || !isNonblankString(target.id)
    || !isNonblankString(target.name)
    || typeof target.isGroup !== "boolean"
  ) {
    throw new Error("Invalid transcript target.");
  }
  const hasTranscript = Object.prototype.hasOwnProperty.call(out, "transcript");
  const hasThread = Object.prototype.hasOwnProperty.call(out, "thread");
  const payload = hasTranscript ? out.transcript : hasThread ? out.thread : undefined;
  const entries = strictTranscriptEntries(payload);
  const messages = entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Invalid transcript entry.");
    }
    return {
      id: normalizedMessageId(entry),
      role: explicitRole(entry),
      text: evidenceText(entry),
    };
  });
  return {
    target: {
      id: target.id,
      name: target.name,
      kind: target.isGroup ? "group" : "bot",
    },
    messages,
  };
}
