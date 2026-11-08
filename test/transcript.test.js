import test from "node:test";
import assert from "node:assert/strict";
import { formatTranscript } from "../src/core/format.js";
import { entryText, normalizeTranscript, sourceEntryId, transcriptDelta, transcriptEntries } from "../src/core/transcript.js";

test("reads actual nested send-message and user entry content", () => {
  assert.equal(entryText({
    kind: "send-message",
    message: { type: "assistant", content: "nested assistant text" },
  }), "nested assistant text");
  assert.equal(entryText({
    kind: "user",
    message: { type: "user", content: "nested user text" },
  }), "nested user text");
});

test("reads nested message text and content parts", () => {
  assert.equal(entryText({ message: { text: "nested text" } }), "nested text");
  assert.equal(entryText({
    message: {
      content: ["first", { text: "second" }, { content: "third" }],
    },
  }), "first\nsecond\nthird");
});

test("preserves existing direct and content formats", () => {
  assert.equal(entryText({ text: "direct" }), "direct");
  assert.equal(entryText({ prompt: "prompt" }), "prompt");
  assert.equal(entryText({ message: "message" }), "message");
  assert.equal(entryText({ preview: "preview" }), "preview");
  assert.equal(entryText({ content: "content" }), "content");
  assert.equal(entryText({ content: ["one", { text: "two" }] }), "one\ntwo");
  assert.equal(entryText({ content: { text: "object text" } }), "object text");
  assert.equal(entryText({ content: { type: "image" } }), '{"type":"image"}');
});

test("normalizes actual nested transcript schema with exact text", () => {
  const normalized = normalizeTranscript({
    target: { id: "bot-1", name: "研究員", isGroup: false },
    transcript: {
      entries: [
        {
          id: "message-1",
          kind: "send-message",
          message: { type: "assistant", content: "第一行\n第二行" },
        },
        {
          messageId: "message-2",
          role: "user",
          message: { content: "請繼續" },
        },
      ],
    },
  });

  assert.deepEqual(normalized, {
    target: { id: "bot-1", name: "研究員", kind: "bot" },
    messages: [
      { id: "message-1", role: "assistant", text: "第一行\n第二行" },
      { id: "message-2", role: "user", text: "請繼續" },
    ],
  });
});

test("normalizer only accepts explicit user and assistant roles", () => {
  const normalized = normalizeTranscript({
    target: { id: "group-1", name: "Launch", isGroup: true },
    thread: {
      messages: [
        { id: "1", kind: "send-message", text: "looks sent by user" },
        { id: "2", type: "assistant", text: "answer" },
        { id: "3", message: { role: "user", text: "question" } },
        { id: "4", role: "system", text: "system text" },
      ],
    },
  });

  assert.deepEqual(normalized, {
    target: { id: "group-1", name: "Launch", kind: "group" },
    messages: [
      { id: "1", role: "unknown", text: "looks sent by user" },
      { id: "2", role: "assistant", text: "answer" },
      { id: "3", role: "user", text: "question" },
      { id: "4", role: "unknown", text: "system text" },
    ],
  });
});

test("normalizer marks conflicting explicit roles unknown", () => {
  const normalized = normalizeTranscript({
    target: { id: "bot-1", name: "Bot", isGroup: false },
    transcript: {
      entries: [{
        id: "1",
        role: "assistant",
        message: { type: "user", content: "conflicting echo" },
      }],
    },
  });

  assert.equal(normalized.messages[0].role, "unknown");
});

test("normalizer rejects conflicting text evidence without changing display formatting", () => {
  const target = { id: "bot-1", name: "Bot", isGroup: false };
  const conflicting = { id: "1", text: "first", preview: "second" };

  assert.equal(entryText(conflicting), "first");
  assert.throws(
    () => normalizeTranscript({ target, transcript: { entries: [conflicting] } }),
    /conflicting transcript text/i,
  );
});

test("normalizer rejects conflicting nested message text and content", () => {
  const target = { id: "bot-1", name: "Bot", isGroup: false };
  assert.throws(
    () => normalizeTranscript({
      target,
      transcript: {
        entries: [{ id: "1", message: { type: "text", text: "first", content: "second" } }],
      },
    }),
    /conflicting transcript text/i,
  );
});

test("matching text carriers normalize once and content arrays remain intact", () => {
  const target = { id: "bot-1", name: "Bot", isGroup: false };
  const normalized = normalizeTranscript({
    target,
    transcript: {
      entries: [
        { id: "1", text: "same", preview: "same" },
        { id: "2", message: { content: ["first", { text: "second" }] } },
      ],
    },
  });
  assert.equal(normalized.messages[0].text, "same");
  assert.equal(normalized.messages[1].text, "first\nsecond");
});

test("send-message with nested type text stays unknown", () => {
  const normalized = normalizeTranscript({
    target: { id: "bot-1", name: "Bot", isGroup: false },
    transcript: {
      entries: [{ id: "1", kind: "send-message", message: { type: "text", content: "hello" } }],
    },
  });
  assert.equal(normalized.messages[0].role, "unknown");
});

test("normalized evidence never synthesizes JSON from non-text content", () => {
  const normalized = normalizeTranscript({
    target: { id: "bot-1", name: "Bot", isGroup: false },
    transcript: { entries: [{ id: "new", role: "user", content: { type: "image" } }] },
  });
  assert.equal(normalized.messages[0].text, "");
  assert.equal(entryText({ content: { type: "image" } }), '{"type":"image"}');
});

test("normalizer supports items and direct array containers", () => {
  const target = { id: "bot-1", name: "Bot", isGroup: false };
  assert.equal(normalizeTranscript({ target, transcript: { items: [] } }).messages.length, 0);
  assert.equal(normalizeTranscript({ target, transcript: [] }).messages.length, 0);
});

test("normalizer fails closed on malformed containers and entries", () => {
  const target = { id: "bot-1", name: "Bot", isGroup: false };
  assert.throws(
    () => normalizeTranscript({ target, transcript: { entries: "not-an-array" } }),
    /invalid transcript container/i,
  );
  assert.throws(
    () => normalizeTranscript({ target, transcript: { entries: [null] } }),
    /invalid transcript entry/i,
  );
});

test("normalizer fails closed on malformed target and message identities", () => {
  const transcript = { entries: [] };
  for (const target of [
    { id: "", name: "Bot", isGroup: false },
    { id: "bot-1", name: "   ", isGroup: false },
    { id: 7, name: "Bot", isGroup: false },
    { id: "bot-1", name: {}, isGroup: false },
    { id: "bot-1", name: "Bot", isGroup: "false" },
  ]) {
    assert.throws(() => normalizeTranscript({ target, transcript }), /invalid transcript target/i);
  }

  const target = { id: "bot-1", name: "Bot", isGroup: false };
  for (const id of ["", "   ", 42, {}]) {
    assert.throws(
      () => normalizeTranscript({ target, transcript: { entries: [{ id, text: "message" }] } }),
      /invalid transcript message id/i,
    );
  }
  assert.deepEqual(
    normalizeTranscript({ target, transcript: { entries: [{ text: "no id" }] } }).messages[0],
    { id: null, role: "unknown", text: "no id" },
  );
});

test("normalizer rejects conflicting or malformed ID carriers", () => {
  const target = { id: "bot-1", name: "Bot", isGroup: false };
  for (const entry of [
    { id: "first", messageId: "second", text: "message" },
    { id: "first", messageId: {}, text: "message" },
    { id: {}, messageId: "second", text: "message" },
  ]) {
    assert.throws(
      () => normalizeTranscript({ target, transcript: { entries: [entry] } }),
      /invalid transcript message id/i,
    );
  }

  const messages = normalizeTranscript({
    target,
    transcript: {
      entries: [
        { id: "same", messageId: "same", text: "one" },
        { id: null, messageId: "fallback", text: "two" },
      ],
    },
  }).messages;
  assert.equal(messages[0].id, "same");
  assert.equal(messages[1].id, "fallback");
});

test("user messages read content, bot replies read message.content", () => {
  assert.equal(entryText({ kind: "message", role: "user", content: "hello" }), "hello");
  assert.equal(entryText({ kind: "send-message", message: { type: "text", content: "reply" } }), "reply");
  assert.equal(entryText({ kind: "tool-call" }), "");
});

test("direct string keys win over content, then content parts join", () => {
  assert.equal(entryText({ text: "direct", content: "ignored" }), "direct");
  assert.equal(entryText({ message: "plain", content: "ignored" }), "plain");
  assert.equal(entryText({ content: ["a", { text: "b" }, { content: "c" }, 4] }), "a\nb\nc");
  assert.equal(entryText({ content: { text: "obj" } }), "obj");
  assert.equal(entryText({ content: { other: 1 } }), '{"other":1}');
  assert.equal(entryText({ preview: "short…", content: [{ type: "text", text: "full body" }] }), "full body");
  assert.equal(entryText({ preview: "preview only" }), "preview only");
});

test("transcript containers expose their canonical entries list", () => {
  assert.deepEqual(transcriptEntries({ entries: [1], nextBeforeSeq: 2 }), [1]);
  assert.deepEqual(transcriptEntries({ nextBeforeSeq: 2 }), []);
  assert.deepEqual(transcriptEntries(null), []);
});

test("human transcript output truncates by default and --full preserves text", () => {
  const text = "x".repeat(450);
  const out = {
    target: { id: "bot-1", isGroup: false, name: "Researcher" },
    transcript: { entries: [{ id: "m1", role: "assistant", text }] },
  };
  assert.match(formatTranscript(out), /… \[\+50 chars; --full or --json for complete text\]$/);
  assert.match(formatTranscript(out, { full: true }), new RegExp(`${text}$`));
});

test("entryText never throws and normalizes malformed content to safe strings", () => {
  assert.equal(entryText({ content: { text: 5 } }), "5");
  assert.equal(entryText({ content: { flag: true } }), '{"flag":true}');
  assert.equal(entryText({ content: { v: 1n } }), "[unserializable]");
  assert.equal(entryText({ text: "a\ud800b" }), "a\ufffdb");
  assert.equal(entryText(null), "");
});

test("transcript delta uses opaque source ids and the true bounded tail", () => {
  const longId = "i".repeat(300);
  const entries = [
    { id: "old", text: "old" },
    { id: longId, kind: 7, text: "middle" },
    { id: "latest", text: "latest" },
  ];
  assert.equal(sourceEntryId(entries[1]), longId);
  assert.deepEqual(transcriptDelta({ entries }, { limit: 2 }), {
    cursor: "latest",
    entries: entries.slice(1),
    entryCount: 2,
    gapReset: false,
  });
});

test("transcript delta filters exclusively after a known cursor and keeps no-op cursor", () => {
  const entries = Array.from({ length: 45 }, (_, index) => ({ id: `m${index + 1}`, text: `message ${index + 1}` }));
  assert.deepEqual(transcriptDelta({ entries }, { after: "m43", limit: 45 }), {
    cursor: "m45",
    entries: entries.slice(43),
    entryCount: 2,
    gapReset: false,
  });
  assert.deepEqual(transcriptDelta({ entries }, { after: "m45", limit: 45 }), {
    cursor: "m45",
    entries: [],
    entryCount: 0,
    gapReset: false,
  });
});

test("transcript delta resets when trailing idless entries cannot advance the cursor", () => {
  const entries = [{ id: "seen", text: "seen" }, { text: "new but idless" }];
  assert.deepEqual(transcriptDelta({ entries }, { after: "seen", limit: 40 }), {
    cursor: "seen",
    entries,
    entryCount: 2,
    gapReset: true,
  });
});

test("transcript delta resets an unknown cursor with one bounded snapshot", () => {
  const entries = Array.from({ length: 45 }, (_, index) => ({ id: `m${index + 1}`, text: `message ${index + 1}` }));
  const delta = transcriptDelta({ entries }, { after: "bogus", limit: 40 });
  assert.equal(delta.gapReset, true);
  assert.equal(delta.entryCount, 40);
  assert.deepEqual(delta.entries, entries.slice(-40));
  assert.equal(delta.cursor, "m45");
});

test("an unreadable row holds the incremental cursor, so it is read again once its body is back", () => {
  const rows = (a1) => ({ entries: [{ id: "u0", kind: "message", role: "user" }, { id: "u1", kind: "send-message", text: "one" }, a1, { id: "a2", kind: "send-message", text: "two" }] });
  const first = transcriptDelta(rows({ id: "a1", kind: "send-message", seq: 3, unreadable: true }), { after: "u0" });
  assert.deepEqual(first.entries.map((e) => e.id), ["u1"]);
  assert.equal(first.cursor, "u1");
  const later = transcriptDelta(rows({ id: "a1", kind: "send-message", text: "back" }), { after: first.cursor });
  assert.deepEqual(later.entries.map((e) => e.id), ["a1", "a2"]);
  assert.equal(later.cursor, "a2");
  const stillDown = transcriptDelta(rows({ id: "a1", kind: "send-message", unreadable: true }), { after: "u1" });
  assert.deepEqual(stillDown.entries, []);
  assert.equal(stillDown.cursor, "u1", "the cursor does not move past it");
});

test("the first read and a gap reset also stop before an unreadable row (round 7)", () => {
  const page = (a1) => ({ entries: [{ id: "u1", kind: "send-message", text: "one" }, a1, { id: "a2", kind: "send-message", text: "two" }] });
  const down = { id: "a1", kind: "send-message", unreadable: true };
  const first = transcriptDelta(page(down));
  assert.deepEqual(first.entries.map((e) => e.id), ["u1"]);
  assert.equal(first.cursor, "u1");
  const gap = transcriptDelta(page(down), { after: "gone" });
  assert.equal(gap.gapReset, true);
  assert.equal(gap.cursor, "u1");
  const back = transcriptDelta(page({ id: "a1", kind: "send-message", text: "back" }), { after: first.cursor });
  assert.deepEqual(back.entries.map((e) => e.id), ["a1", "a2"], "read once, nothing skipped or repeated");
});
