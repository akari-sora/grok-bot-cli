// Grok Bot 0.78.x: sends, the roster, rooms, deletes and sidebar state go to aiserver.v1.GrokBotService
// with the account access token. These sessions come from connectGateway with CURSOR_ACCESS_TOKEN;
// saved-login and descriptor sessions are covered in accounts-r2.test.js.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { grokBotGatewayDescriptorPath } from "../src/core/app-session.js";

import { outcomeFromError } from "../src/core/codex/contract.js";
import { formatTranscript, summarize } from "../src/core/format.js";
import { transcriptDelta } from "../src/core/transcript.js";
import {
  addGroupMember,
  addSkill,
  connectGateway,
  createGroup,
  deleteAgent,
  getBotTemplate,
  getBotTemplateVersion,
  getThread,
  getTranscriptTail,
  hasBackend,
  listAgents,
  listGrokApprovals,
  listSkills,
  publishBotTemplate,
  reconcileDelivery,
  removeGroupMember,
  removeSkill,
  resolveRef,
  respondGrokApproval,
  sendPrompt,
  setGroupMembers,
  shareBotTemplate,
  updateAgent,
} from "../src/core/gateway.js";

const ACCESS = "synthetic-backend-access-do-not-leak";
const GATEWAY = "synthetic-box-gateway-do-not-leak";
const BACKEND = "http://127.0.0.1:1350";
const BOX = "http://127.0.0.1:1351";
const STORE = "http://127.0.0.1:1352";
const SERVICE = BACKEND + "/aiserver.v1.GrokBotService/";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const bot = (agentId, name, extra = {}) => ({
  id: String(1000 + Number(agentId.replace(/\D/g, "") || 0)),
  legacyAgentId: agentId,
  agentId,
  name,
  harness: "temporal",
  kind: "GROK_BOT_AGENT_KIND_AGENT",
  createdAtMs: "1",
  updatedAtMs: "2",
  ...extra,
});
const room = (agentId, name, memberAgentIds, extra = {}) => bot(agentId, name, {
  kind: "GROK_BOT_AGENT_KIND_ROOM",
  memberAgentIds,
  ...extra,
});

const SERVER = [
  bot("bot-1", "General", { avatarShape: "pebble", avatarColor: "violet", description: "first" }),
  // ListGrokBotAgents folds a bot's title into its name and leaves title out.
  bot("bot-2", "Scout · Night shift"),
  bot("bot-3", "Box Helper", { harness: "box" }),
  room("room-1", "Launch", ["bot-1", "bot-2"], { title: "Launch room" }),
];

// GetGrokBotRuntimeCapabilities as live on 2026-11-05: the server roster is on.
const CAPS_ON = { capabilities: { durableIdentityEnabled: true, durableIdentityWritesEnabled: true, temporalCreationEnabled: true, serverRoomsEnabled: true } };

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function connectError(code, detail, status) {
  return json({
    code,
    message: "Error",
    details: [{ type: "aiserver.v1.ErrorDetails", debug: { details: { title: "Bad", detail } } }],
  }, status);
}

function envFor(home, extra = {}) {
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    GROK_BOT_TEST: "1",
    CURSOR_API_BASE_URL: BACKEND,
    CURSOR_ACCESS_TOKEN: ACCESS,
    GROK_BOT_GATEWAY_URL: null,
    GROK_BOT_GATEWAY_TOKEN: null,
    GROK_BOT_GATEWAY_HEADERS: null,
    GROK_BOT_ALLOW_ANY_GATEWAY: null,
    GBOT_ACCOUNT: null,
    GBOT_ACCOUNT_SCOPE: null,
    GBOT_CONFIG: null,
    GBOT_AUTO_WAKE: null,
    GBOT_DEBUG: null,
    SAND_CLIENT_VERSION: "9.9.9",
    ...extra,
  };
}

function withEnv(values, fn) {
  const prev = {};
  for (const key of Object.keys(values)) {
    prev[key] = process.env[key];
    if (values[key] == null) delete process.env[key];
    else process.env[key] = values[key];
  }
  const restore = () => {
    for (const key of Object.keys(values)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  };
  return Promise.resolve().then(fn).finally(restore);
}

/**
 * Routes every fetch: EnsureSandBox answers a running box, other GrokBotService RPCs go to `rpcs[name]`,
 * box gateway calls to `box[method]`, presigned store reads to `store[path]` (bytes). A handler returns a
 * value (sent as JSON) or a Response, or throws.
 */
function mockApi(t, { rpcs = {}, box = {}, store = {} } = {}) {
  const calls = [];
  const routes = {
    GetGrokBotRuntimeCapabilities: () => CAPS_ON,
    ListGrokBotAgents: () => ({ agents: SERVER, slackConnections: [] }),
    ListGrokBotAgentStatuses: () => ({ statuses: [] }),
    ...rpcs,
  };
  const boxRoutes = { listAgents: () => ({ agents: [] }), ...box };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    const headers = init?.headers ?? {};
    const rpc = target.startsWith(SERVICE) ? target.slice(SERVICE.length) : null;
    const method = target.startsWith(BOX + "/api/") ? target.slice((BOX + "/api/").length) : null;
    calls.push({ target, rpc, method, body, headers });
    if (rpc === "EnsureSandBox") {
      return json({ runState: "SAND_BOX_RUN_STATE_RUNNING", gatewayUrl: BOX, gatewayToken: GATEWAY });
    }
    if (target.startsWith(STORE + "/")) {
      const bytes = store[target.slice(STORE.length)];
      return bytes ? new Response(bytes) : new Response("missing", { status: 404 });
    }
    const handler = rpc ? routes[rpc] : boxRoutes[method];
    if (!handler) return json({ code: "unimplemented", message: "no mock for " + target }, 501);
    const out = await handler(body, headers);
    return out instanceof Response ? out : json(out);
  });
  return calls;
}

async function backendSession(t, routes, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "gbot-backend-"));
  const calls = mockApi(t, routes);
  const env = envFor(home, extraEnv);
  const run = (fn) => withEnv(env, async () => fn(await connectGateway()));
  return { calls, run };
}

const rpcCalls = (calls, rpc) => calls.filter((call) => call.rpc === rpc);
const boxCalls = (calls, method) => calls.filter((call) => call.method === method);
// A ListGrokBotTranscriptEntries page as the live server answers it (2026-11-08): newest first, each
// row's body the transcript entry JSON in base64, seq and updatedSeq as int64 strings. `entries` are
// box-tail shaped (oldest first); seq moves from the entry to the row, and an entry without one gets
// its position.
const tailPage = (entries) => ({
  entries: entries.map(({ seq: given, ...body }, index) => {
    const seq = String(given ?? index + 1);
    return { seq, entryKind: body.kind ?? "message", entryId: body.id, updatedSeq: seq, body: Buffer.from(JSON.stringify(body)).toString("base64") };
  }).reverse(),
  updatedSeqLocked: true,
});

test("a CURSOR_ACCESS_TOKEN session reaches the backend with the access token and the app headers", async (t) => {
  const { calls, run } = await backendSession(t);
  await run(async (session) => {
    assert.equal(hasBackend(session), true);
    assert.equal(JSON.stringify(session).includes(ACCESS), false, "the access token is not on the session object");
    await resolveRef(session, "General");
  });
  const [listed] = rpcCalls(calls, "ListGrokBotAgents");
  assert.deepEqual(listed.body, {});
  assert.equal(listed.headers.authorization, "Bearer " + ACCESS);
  assert.equal(listed.headers["connect-protocol-version"], "1");
  assert.equal(listed.headers["x-cursor-client-type"], "sand");
  assert.equal(listed.headers["x-cursor-client-version"], "9.9.9");
  assert.equal(rpcCalls(calls, "ListGrokBotAgentStatuses").length, 0, "resolving a ref skips sidebar state");
});

test("the roster maps server agents, client state, titled names, rooms, and drops stale box rows", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      ListGrokBotAgentStatuses: (body) => {
        assert.deepEqual(body, { agentIds: [] });
        return {
          statuses: [
            // proto3 JSON leaves false out: hidden on, notify absent means off once the state was written.
            { agentId: "bot-1", client: { agentId: "bot-1", hiddenFromSidebar: true, notificationsEnabled: true, updatedAtMs: "5" } },
            { agentId: "bot-2", client: { agentId: "bot-2", notifyOnUpdatesEnabled: true, updatedAtMs: "5" } },
            // Never written (no updatedAtMs): like the app, notify shows on.
            { agentId: "bot-3", client: { agentId: "bot-3", unreadCount: 1 } },
            // A status without client state: the app shows notify on, not hidden.
            { agentId: "room-1", isRunning: false },
          ],
        };
      },
    },
    box: {
      listAgents: () => ({
        agents: [
          // Deleted on the backend, still in the box roster (live 2026-11-05): dropped.
          { id: "ghost-1", name: "gbot-probe-ghost", harness: "temporal" },
          // A box-harness bot the server does not list: kept, after the server agents.
          { id: "box-only", name: "Local Box", harness: "box", notifyOnUpdatesEnabled: false },
          // Listed by the server too: the server record wins.
          { id: "bot-3", name: "Stale Box Name", harness: "box" },
        ],
      }),
    },
  });
  const rows = await run((session) => listAgents(session));
  assert.deepEqual(rows.map((r) => r.id), ["bot-1", "bot-2", "bot-3", "room-1", "box-only"]);
  assert.deepEqual(rows[0], {
    id: "bot-1",
    name: "General",
    title: "",
    description: "first",
    avatarShape: "pebble",
    avatarColor: "violet",
    notifyOnAgentUpdates: false,
    hiddenFromSidebar: true,
    isGroup: false,
    memberIds: [],
    serverId: "1001",
    harness: "temporal",
  });
  assert.equal(rows[1].name, "Scout · Night shift");
  assert.equal(rows[1].notifyOnAgentUpdates, true);
  assert.equal(rows[1].hiddenFromSidebar, false);
  assert.equal(rows[2].name, "Box Helper");
  assert.equal(rows[2].notifyOnAgentUpdates, true);
  assert.equal(rows[2].hiddenFromSidebar, false);
  assert.deepEqual(
    { isGroup: rows[3].isGroup, memberIds: rows[3].memberIds, title: rows[3].title, notify: rows[3].notifyOnAgentUpdates, hidden: rows[3].hiddenFromSidebar },
    { isGroup: true, memberIds: ["bot-1", "bot-2"], title: "Launch room", notify: true, hidden: false },
  );
  assert.equal(rows[4].name, "Local Box");
  assert.equal(rows[4].notifyOnAgentUpdates, false);
  // One box roster read, and no EnsureSandBox beyond the connect.
  assert.equal(boxCalls(calls, "listAgents").length, 1);
  assert.equal(calls.filter((call) => call.rpc === "EnsureSandBox").length, 1);
});

test("the server roster stands when the box roster cannot be read", async (t) => {
  const { run } = await backendSession(t, {
    box: { listAgents: () => new Response("", { status: 417, headers: { "x-anyrun-failure-reason": "pod_hibernated" } }) },
  });
  const rows = await run((session) => listAgents(session));
  assert.deepEqual(rows.map((r) => r.id), ["bot-1", "bot-2", "bot-3", "room-1"]);
});

test("a titled bot resolves by its plain name, and a box-only row never hides a server agent", async (t) => {
  const { run } = await backendSession(t, {
    rpcs: { ListGrokBotAgents: () => ({ agents: [...SERVER, bot("bot-4", "Scout · Day shift"), bot("bot-5", "Twin")] }) },
    box: { listAgents: () => ({ agents: [{ id: "box-twin", name: "Twin", harness: "box" }] }) },
  });
  await run(async (session) => {
    assert.equal((await resolveRef(session, "General")).id, "bot-1");
    assert.equal((await resolveRef(session, "Launch room")).id, "room-1");
    assert.equal((await resolveRef(session, "Scout · Night shift")).id, "bot-2");
    await assert.rejects(resolveRef(session, "Scout"), /Ambiguous name "Scout"/);
    assert.equal((await resolveRef(session, "twin")).id, "bot-5");
    assert.equal((await resolveRef(session, "box-twin")).id, "box-twin");
    await assert.rejects(resolveRef(session, "Nobody"), /No bot or group named "Nobody"/);
  });
});

test("a plain name that exactly matches is not ambiguous with a titled bot of the same name", async (t) => {
  const { run } = await backendSession(t, {
    rpcs: { ListGrokBotAgents: () => ({ agents: [bot("bot-1", "Scout"), bot("bot-2", "Scout · Night shift")] }) },
  });
  await run(async (session) => {
    assert.equal((await resolveRef(session, "Scout")).id, "bot-1");
  });
});

for (const delivery of ["ACCEPTED_BOX", "ACCEPTED_TEMPORAL", "DUPLICATE"]) {
  test(`SendGrokBotUserMessage ${delivery} is accepted`, async (t) => {
    const { calls, run } = await backendSession(t, {
      rpcs: {
        SendGrokBotUserMessage: () => ({
          dispatched: true,
          mode: "GROK_BOT_TEMPORAL_HARNESS_MODE_LIVE",
          workflowId: "wf-1",
          delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_" + delivery,
        }),
      },
    });
    const before = Date.now();
    const out = await run((session) => sendPrompt(session, "General", "hello there", { clientNonce: "nonce-1", replyToId: "entry-9" }));
    assert.equal(out.delivery, "accepted");
    assert.equal(out.clientNonce, "nonce-1");
    assert.equal(out.target.id, "bot-1");
    assert.equal(out.messageId, undefined);
    assert.equal(out.result.workflowId, "wf-1");
    const [sent] = rpcCalls(calls, "SendGrokBotUserMessage");
    const { sentAtMs, ...rest } = sent.body;
    assert.deepEqual(rest, {
      agentId: "bot-1",
      messageId: "nonce-1",
      text: "hello there",
      source: "GROK_BOT_CLIENT_SURFACE_DESKTOP",
      initiator: "GROK_BOT_USER_MESSAGE_INITIATOR_USER",
      sendSource: "GROK_BOT_SEND_SOURCE_CHAT",
      replyToId: "entry-9",
    });
    assert.match(sentAtMs, /^\d+$/);
    assert.ok(Number(sentAtMs) >= before && Number(sentAtMs) <= Date.now());
    assert.equal(sent.headers.authorization, "Bearer " + ACCESS);
    const zone = sent.headers["x-cursor-timezone"];
    assert.ok(zone === undefined || /\w/.test(zone));
    assert.equal(boxCalls(calls, "sendPrompt").length, 0, "never the box gateway");
    assert.equal(rpcCalls(calls, "GetGrokBotSendStatus").length, 0);
  });
}

test("a send without a client nonce gets a fresh uuid as messageId", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: { SendGrokBotUserMessage: () => ({ dispatched: true, delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL" }) },
  });
  const out = await run((session) => sendPrompt(session, "General", "hi"));
  assert.match(out.clientNonce, UUID_V4);
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage")[0].body.messageId, out.clientNonce);
});

test("REFUSED is a definite rejection with the server's failure code and message", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      SendGrokBotUserMessage: () => ({
        dispatched: false,
        delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED",
        refusal: { failureCode: "send/agent-unavailable", message: "This bot is not available." },
      }),
    },
  });
  const error = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-refused" }))
    .then(() => assert.fail("expected a refusal"), (err) => err);
  assert.equal(error.name, "GatewayError");
  assert.equal(error.delivery, "rejected");
  assert.equal(error.failureCode, "send/agent-unavailable");
  assert.equal(error.clientNonce, "nonce-refused");
  assert.equal(error.targetId, "bot-1");
  assert.match(error.message, /refused: This bot is not available\./);
  assert.equal(outcomeFromError(error).delivery, "rejected");
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 1);
  assert.equal(rpcCalls(calls, "GetGrokBotSendStatus").length, 0);
});

test("UNSPECIFIED asks GetGrokBotSendStatus: ACCEPTED is accepted, PENDING stays unknown", async (t) => {
  let status = "GROK_BOT_SEND_STATUS_ACCEPTED";
  const { calls, run } = await backendSession(t, {
    rpcs: {
      SendGrokBotUserMessage: () => ({ dispatched: true, delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_UNSPECIFIED" }),
      GetGrokBotSendStatus: () => ({ status, echoEntryId: "t9u" }),
    },
  });
  const accepted = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-a" }));
  assert.equal(accepted.delivery, "accepted");
  status = "GROK_BOT_SEND_STATUS_PENDING";
  const pending = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-b" }));
  assert.equal(pending.delivery, "unknown");
  assert.equal(pending.clientNonce, "nonce-b");
  assert.deepEqual(rpcCalls(calls, "GetGrokBotSendStatus").map((call) => call.body), [
    { agentId: "bot-1", messageId: "nonce-a" },
    { agentId: "bot-1", messageId: "nonce-b" },
  ]);
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 2, "one send per prompt, no resend");
});

test("a 5xx send is delivery unknown, asks the status once, and is never resent", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      SendGrokBotUserMessage: () => connectError("unavailable", "try again", 503),
      GetGrokBotSendStatus: () => ({ status: "GROK_BOT_SEND_STATUS_NOT_FOUND" }),
    },
  });
  const error = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-503" }))
    .then(() => assert.fail("expected unknown"), (err) => err);
  assert.equal(error.delivery, "unknown");
  assert.equal(error.effect, "unknown");
  assert.equal(error.status, 503);
  assert.equal(error.code, "unavailable");
  assert.equal(error.clientNonce, "nonce-503");
  assert.match(error.message, /SendGrokBotUserMessage failed: 503 unavailable try again/);
  assert.match(error.message, /delivery unknown; check the thread before resending/);
  assert.equal(outcomeFromError(error).delivery, "unknown");
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 1);
  assert.equal(rpcCalls(calls, "GetGrokBotSendStatus").length, 1);
});

test("a send timeout is delivery unknown and never resent", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      SendGrokBotUserMessage: () => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      },
      GetGrokBotSendStatus: () => ({ status: "GROK_BOT_SEND_STATUS_UNKNOWN_DURABILITY" }),
    },
  });
  const error = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-timeout" }))
    .then(() => assert.fail("expected unknown"), (err) => err);
  assert.equal(error.code, "GATEWAY_TIMEOUT");
  assert.equal(error.delivery, "unknown");
  assert.equal(error.effect, "unknown");
  assert.match(error.message, /SendGrokBotUserMessage timed out after 15000ms; delivery is unknown/);
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 1);
});

test("a transport failure settled by GetGrokBotSendStatus is accepted, or rejected without a resend", async (t) => {
  let status = "GROK_BOT_SEND_STATUS_ACCEPTED";
  const { calls, run } = await backendSession(t, {
    rpcs: {
      SendGrokBotUserMessage: () => {
        throw new TypeError("fetch failed " + SERVICE + "SendGrokBotUserMessage");
      },
      GetGrokBotSendStatus: () => ({ status, echoEntryId: "t7u", rejectionCode: "send/too-long" }),
    },
  });
  const accepted = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-lost" }));
  assert.equal(accepted.delivery, "accepted");
  assert.equal(accepted.result.echoEntryId, "t7u");
  status = "GROK_BOT_SEND_STATUS_REJECTED";
  const rejected = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-lost-2" }))
    .then(() => assert.fail("expected rejected"), (err) => err);
  assert.equal(rejected.delivery, "rejected");
  assert.equal(rejected.effect, undefined);
  assert.equal(rejected.failureCode, "send/too-long");
  // A fresh rejected error: not the transport error's text or code.
  assert.equal(rejected.code, "SEND_REFUSED");
  assert.match(rejected.message, /SendGrokBotUserMessage refused: GetGrokBotSendStatus says rejected after GATEWAY_REQUEST_FAILED/);
  assert.doesNotMatch(rejected.message, /127\.0\.0\.1|delivery (is )?unknown/);
  assert.equal(rejected.cause.code, "GATEWAY_REQUEST_FAILED");
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 2);
});

test("a 4xx send is a definite rejection and needs no status read", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: { SendGrokBotUserMessage: () => connectError("invalid_argument", "text must not be empty", 400) },
  });
  const error = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-400" }))
    .then(() => assert.fail("expected rejected"), (err) => err);
  assert.equal(error.delivery, "rejected");
  assert.equal(error.code, "invalid_argument");
  assert.equal(error.kind, "client");
  assert.match(error.message, /400 invalid_argument text must not be empty/);
  assert.equal(rpcCalls(calls, "GetGrokBotSendStatus").length, 0);
});

test("backend errors never carry the access token", async (t) => {
  const { run } = await backendSession(t, {
    rpcs: {
      SendGrokBotUserMessage: (_, headers) => json({ code: "unauthenticated", message: "bad token " + ACCESS + " / " + headers.authorization }, 401),
      DeleteGrokBotAgent: () => connectError("permission_denied", "token " + ACCESS + " cannot delete this bot", 403),
    },
  });
  const sendError = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-401" }))
    .then(() => assert.fail("expected rejected"), (err) => err);
  assert.equal(sendError.delivery, "rejected");
  assert.equal(sendError.kind, "auth");
  const deleteError = await run((session) => deleteAgent(session, "General"))
    .then(() => assert.fail("expected refused"), (err) => err);
  assert.equal(deleteError.code, "permission_denied");
  assert.equal(deleteError.kind, "auth");
  for (const error of [sendError, deleteError]) {
    assert.doesNotMatch(error.message, new RegExp(ACCESS));
    assert.doesNotMatch(JSON.stringify(outcomeFromError(error)), new RegExp(ACCESS));
  }
});

test("deleteAgent calls DeleteGrokBotAgent with the agent uuid; NotFound counts as deleted", async (t) => {
  let answer = () => ({});
  const { calls, run } = await backendSession(t, { rpcs: { DeleteGrokBotAgent: () => answer() } });
  const deleted = await run((session) => deleteAgent(session, "General"));
  assert.equal(deleted.id, "bot-1");
  answer = () => connectError("not_found", "Grok Bot agent not found.", 404);
  const gone = await run((session) => deleteAgent(session, "room-1"));
  assert.equal(gone.id, "room-1");
  assert.deepEqual(rpcCalls(calls, "DeleteGrokBotAgent").map((call) => call.body), [{ id: "bot-1" }, { id: "room-1" }]);
  assert.equal(boxCalls(calls, "deleteAgent").length, 0, "the box gateway accepts deleteAgent and deletes nothing");
});

test("createGroup calls CreateGrokBotRoom, keeps the server's id, and sets title and avatar with UpdateGrokBotAgent", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      // The server answers with its own agentId, not necessarily the nonce.
      CreateGrokBotRoom: (body) => ({ agent: room("room-9", body.name, body.memberAgentIds, { id: "1009", description: body.description }) }),
      UpdateGrokBotAgent: (body) => ({ agent: room("room-9", "Night", ["bot-1", "bot-2"], { id: body.id, title: body.title, avatarShape: body.avatarShape }) }),
      ListGrokBotAgents: () => ({ agents: [...SERVER, room("room-9", "Night", ["bot-1", "bot-2"], { id: "1009", title: "Night room", avatarShape: "pebble" })] }),
    },
  });
  const rec = await run((session) => createGroup(session, {
    name: "Night",
    description: "after hours",
    memberIds: ["General", "Scout", "bot-1"],
    title: "Night room",
    avatarShape: "pebble",
  }));
  const [created] = rpcCalls(calls, "CreateGrokBotRoom");
  assert.match(created.body.agentId, UUID_V4);
  assert.deepEqual({ ...created.body, agentId: "<nonce>" }, {
    agentId: "<nonce>",
    name: "Night",
    description: "after hours",
    memberAgentIds: ["bot-1", "bot-2"],
    humanMemberUserIds: [],
  });
  assert.deepEqual(rpcCalls(calls, "UpdateGrokBotAgent").map((call) => call.body), [
    { id: "1009", title: "Night room", avatarShape: "pebble", partialUpdate: true },
  ]);
  assert.equal(rec.id, "room-9");
  assert.equal(rec.isGroup, true);
  assert.equal(rec.title, "Night room");
  assert.equal(boxCalls(calls, "createGroup").length, 0);
});

test("a CreateGrokBotRoom timeout says the group may exist", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      CreateGrokBotRoom: () => {
        throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      },
    },
  });
  await assert.rejects(
    run((session) => createGroup(session, { name: "Night", memberIds: ["General"] })),
    /CreateGrokBotRoom timed out after 45000ms\. The group may have been created; run gbot groups list/,
  );
  assert.equal(rpcCalls(calls, "CreateGrokBotRoom").length, 1);
});

test("set, add and remove members call SetGrokBotRoomMembers with the room uuid", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: { SetGrokBotRoomMembers: (body) => ({ agent: room(body.agentId, "Launch", body.memberAgentIds, { title: "Launch room" }) }) },
  });
  await run(async (session) => {
    const set = await setGroupMembers(session, "Launch", ["General"]);
    assert.deepEqual(set.memberIds, ["bot-1"]);
    const added = await addGroupMember(session, "Launch room", "Box Helper");
    assert.deepEqual(added.memberIds, ["bot-1", "bot-2", "bot-3"]);
    const removed = await removeGroupMember(session, "room-1", "General");
    assert.deepEqual(removed.memberIds, ["bot-2"]);
  });
  assert.deepEqual(rpcCalls(calls, "SetGrokBotRoomMembers").map((call) => call.body), [
    { agentId: "room-1", memberAgentIds: ["bot-1"] },
    { agentId: "room-1", memberAgentIds: ["bot-1", "bot-2", "bot-3"] },
    { agentId: "room-1", memberAgentIds: ["bot-2"] },
  ]);
  assert.equal(boxCalls(calls, "setGroupMembers").length, 0);
});

test("updateAgent sends only the changed fields to UpdateGrokBotAgent and sidebar state to SetGrokBotAgentClientState", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      UpdateGrokBotAgent: (body) => ({ agent: bot("bot-2", body.name ?? "Scout", { id: body.id }) }),
      SetGrokBotAgentClientState: (body) => ({ state: { agentId: body.agentId, ...body, updatedAtMs: "5" } }),
      ListGrokBotAgentStatuses: () => ({ statuses: [{ agentId: "bot-2", client: { hiddenFromSidebar: true, updatedAtMs: "9" } }] }),
    },
    box: { setAgentNotifyOnUpdates: () => ({}) },
  });
  const rec = await run((session) => updateAgent(session, "Scout", {
    title: "Day shift",
    avatarColor: "green",
    notifyOnAgentUpdates: false,
    hiddenFromSidebar: true,
  }));
  assert.deepEqual(rpcCalls(calls, "UpdateGrokBotAgent").map((call) => call.body), [
    { id: "1002", title: "Day shift", avatarColor: "green", partialUpdate: true },
  ]);
  assert.deepEqual(rpcCalls(calls, "SetGrokBotAgentClientState").map((call) => call.body), [
    { agentId: "bot-2", notifyOnUpdatesEnabled: false },
    { agentId: "bot-2", hiddenFromSidebar: true },
  ]);
  // The app mirrors notify to the box; hidden and the profile go to the backend only.
  assert.deepEqual(boxCalls(calls, "setAgentNotifyOnUpdates").map((call) => call.body), [{ id: "bot-2", isEnabled: false }]);
  assert.equal(boxCalls(calls, "updateAgent").length, 0);
  assert.equal(boxCalls(calls, "setAgentHiddenFromSidebar").length, 0);
  assert.equal(rec.id, "bot-2");
  assert.equal(rec.hiddenFromSidebar, true);
  assert.equal(rec.notifyOnAgentUpdates, false);
});

test("a failed box notify mirror does not fail the update", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: { SetGrokBotAgentClientState: () => ({ state: {} }) },
    box: { setAgentNotifyOnUpdates: () => json({ message: "unknown agent" }, 404) },
  });
  const rec = await run((session) => updateAgent(session, "room-1", { notifyOnAgentUpdates: true }));
  assert.equal(rec.id, "room-1");
  assert.equal(rpcCalls(calls, "UpdateGrokBotAgent").length, 0, "no profile change, no UpdateGrokBotAgent");
  assert.equal(boxCalls(calls, "setAgentNotifyOnUpdates").length, 1);
});

test("reconcile asks GetGrokBotSendStatus first and reads the transcript tail only when it is not accepted", async (t) => {
  let status = () => ({ status: "GROK_BOT_SEND_STATUS_ACCEPTED", echoEntryId: "t106u", acceptedAtMs: "1" });
  const { calls, run } = await backendSession(t, {
    rpcs: {
      GetGrokBotSendStatus: () => status(),
      ListGrokBotTranscriptEntries: () => tailPage([{ kind: "message", id: "t5u", role: "user", clientNonce: "nonce-r", seq: 5 }]),
    },
  });
  const viaStatus = await run((session) => reconcileDelivery(session, "General", "nonce-r"));
  assert.deepEqual({ ...viaStatus, target: viaStatus.target.id }, { target: "bot-1", clientNonce: "nonce-r", status: "delivered", entryId: "t106u", sendStatus: "ACCEPTED" });
  assert.equal(rpcCalls(calls, "ListGrokBotTranscriptEntries").length, 0);
  status = () => ({ status: "GROK_BOT_SEND_STATUS_NOT_FOUND" });
  const viaTail = await run((session) => reconcileDelivery(session, "General", "nonce-r"));
  assert.equal(viaTail.status, "delivered");
  assert.equal(viaTail.entryId, "t5u");
  assert.equal(viaTail.seq, 5);
  status = () => connectError("internal", "boom", 500);
  const afterError = await run((session) => reconcileDelivery(session, "General", "nonce-missing"));
  // A failed status read proves nothing: the message may still land.
  assert.equal(afterError.status, "pending");
  assert.equal(afterError.scanned, 1);
  assert.equal(afterError.sendStatus, "UNAVAILABLE");
  assert.deepEqual(rpcCalls(calls, "GetGrokBotSendStatus").map((call) => call.body.messageId), ["nonce-r", "nonce-r", "nonce-missing"]);
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 0, "reconcile never sends");
});

test("a GROK_BOT_GATEWAY_URL override stays on the box gateway even with CURSOR_ACCESS_TOKEN set", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "gbot-backend-override-"));
  const calls = mockApi(t, {
    box: {
      listAgents: () => ({ agents: [{ id: "bot-1", name: "General", isGroup: false }] }),
      sendPrompt: () => ({ accepted: true }),
    },
  });
  const out = await withEnv(envFor(home, { GROK_BOT_GATEWAY_URL: BOX, GROK_BOT_GATEWAY_TOKEN: GATEWAY }), async () => {
    const session = await connectGateway();
    assert.equal(hasBackend(session), false);
    return sendPrompt(session, "General", "hi", { clientNonce: "nonce-override" });
  });
  assert.equal(out.delivery, "accepted");
  assert.deepEqual(calls.map((call) => call.method ?? call.rpc), ["listAgents", "sendPrompt"]);
  assert.equal(calls[1].body.clientNonce, "nonce-override");
});

// Approval responses: mapped from the 0.78.4 app (ResolveGrokBot* RPCs), not live-tested.
function approvalCards() {
  return [
    { id: "card-review", kind: "send-message", message: { type: "auto-review-approval", approval: { requestId: "ask-review", status: "pending", command: "npm publish" } } },
    { id: "card-local", kind: "send-message", message: { type: "local-tool-permission", ask: { requestId: "ask-local", status: "pending", action: "run-command", target: "rm ./out.txt" } } },
  ];
}

test("approval responses use ResolveGrokBotAutoReviewApproval and ResolveGrokBotLocalToolPermission, once or decline", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      ResolveGrokBotAutoReviewApproval: () => ({ dispatched: true, workflowId: "wf-review" }),
      ResolveGrokBotLocalToolPermission: () => ({ dispatched: true, workflowId: "wf-local" }),
      ListGrokBotTranscriptEntries: () => tailPage(approvalCards()),
    },
  });
  await run(async (session) => {
    const listed = await listGrokApprovals(session, "General");
    assert.deepEqual(listed.target, { id: "bot-1", name: "General" });
    assert.deepEqual(listed.approvals.map((card) => card.requestId), ["ask-review", "ask-local"]);
    for (const [entryId, requestId, decision] of [
      ["card-review", "ask-review", "accept"],
      ["card-review", "ask-review", "decline"],
      ["card-local", "ask-local", "accept"],
      ["card-local", "ask-local", "decline"],
    ]) {
      const out = await respondGrokApproval(session, "General", { entryId, requestId, decision });
      const workflowId = entryId === "card-review" ? "wf-review" : "wf-local";
      assert.deepEqual(out, { target: { id: "bot-1", name: "General" }, entryId, requestId, decision, delivery: "accepted", via: "backend", dispatched: true, workflowId });
    }
  });
  assert.deepEqual(rpcCalls(calls, "ResolveGrokBotAutoReviewApproval").map((call) => call.body), [
    { agentId: "bot-1", requestId: "ask-review", resolution: "GROK_BOT_AUTO_REVIEW_APPROVAL_RESOLUTION_APPROVED", approvalPlatform: "desktop" },
    { agentId: "bot-1", requestId: "ask-review", resolution: "GROK_BOT_AUTO_REVIEW_APPROVAL_RESOLUTION_DENIED", approvalPlatform: "desktop" },
  ]);
  assert.deepEqual(rpcCalls(calls, "ResolveGrokBotLocalToolPermission").map((call) => call.body), [
    { agentId: "bot-1", entryId: "card-local", requestId: "ask-local", resolution: "GROK_BOT_LOCAL_TOOL_PERMISSION_CARD_RESOLUTION_ALLOW_ONCE" },
    { agentId: "bot-1", entryId: "card-local", requestId: "ask-local", resolution: "GROK_BOT_LOCAL_TOOL_PERMISSION_CARD_RESOLUTION_DENY" },
  ]);
  for (const call of [...rpcCalls(calls, "ResolveGrokBotAutoReviewApproval"), ...rpcCalls(calls, "ResolveGrokBotLocalToolPermission")]) {
    assert.equal(call.headers.authorization, "Bearer " + ACCESS);
  }
  assert.deepEqual(calls.filter((call) => /^resolve/.test(call.method ?? "")), [], "never the box gateway");
});

test("approval responses refuse a persistent grant, a stale card, and a truncated accept before any resolve call", async (t) => {
  const cards = approvalCards();
  const { calls, run } = await backendSession(t, { rpcs: { ListGrokBotTranscriptEntries: () => tailPage(cards) } });
  await run(async (session) => {
    await assert.rejects(respondGrokApproval(session, "General", { entryId: "card-local", requestId: "ask-local", decision: "always" }));
    await assert.rejects(respondGrokApproval(session, "General", { entryId: "card-review", requestId: "ask-review", decision: "never" }));
    await assert.rejects(
      respondGrokApproval(session, "General", { entryId: "card-local", requestId: "ask-review", decision: "accept" }),
      /Stale, foreign or unsupported Grok approval/,
    );
    cards[1].message.ask.target = "x".repeat(3000);
    await assert.rejects(
      respondGrokApproval(session, "General", { entryId: "card-local", requestId: "ask-local", decision: "accept" }),
      /truncated/,
    );
  });
  assert.deepEqual(calls.filter((call) => /^ResolveGrokBot/.test(call.rpc ?? "") || /^resolve/.test(call.method ?? "")), []);
});

test("an approval refusal is a definite rejection with the server's failure code", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      ResolveGrokBotLocalToolPermission: () => ({
        dispatched: false,
        refusal: { failureCode: "approval/expired", message: "This request already timed out." },
      }),
      ListGrokBotTranscriptEntries: () => tailPage(approvalCards()),
    },
  });
  const error = await run((session) => respondGrokApproval(session, "General", { entryId: "card-local", requestId: "ask-local", decision: "decline" }))
    .then(() => assert.fail("expected a refusal"), (err) => err);
  assert.equal(error.name, "GatewayError");
  assert.equal(error.code, "APPROVAL_REFUSED");
  assert.equal(error.failureCode, "approval/expired");
  assert.equal(error.delivery, "rejected");
  assert.match(error.message, /ResolveGrokBotLocalToolPermission refused: This request already timed out\./);
  assert.equal(rpcCalls(calls, "ResolveGrokBotLocalToolPermission").length, 1);
});

test("an approval RPC error keeps the Connect code and never carries the access token", async (t) => {
  const { run } = await backendSession(t, {
    rpcs: {
      ResolveGrokBotAutoReviewApproval: () => connectError("permission_denied", "token " + ACCESS + " may not resolve this card", 403),
      ResolveGrokBotLocalToolPermission: () => connectError("failed_precondition", "the machine is offline", 400),
      ListGrokBotTranscriptEntries: () => tailPage(approvalCards()),
    },
  });
  const denied = await run((session) => respondGrokApproval(session, "General", { entryId: "card-review", requestId: "ask-review", decision: "accept" }))
    .then(() => assert.fail("expected an error"), (err) => err);
  assert.equal(denied.code, "permission_denied");
  assert.equal(denied.kind, "auth");
  assert.equal(denied.status, 403);
  assert.match(denied.message, /ResolveGrokBotAutoReviewApproval failed: 403 permission_denied/);
  assert.doesNotMatch(denied.message, new RegExp(ACCESS));
  const offline = await run((session) => respondGrokApproval(session, "General", { entryId: "card-local", requestId: "ask-local", decision: "accept" }))
    .then(() => assert.fail("expected an error"), (err) => err);
  assert.equal(offline.code, "failed_precondition");
  assert.equal(offline.kind, "client");
  assert.match(offline.message, /400 failed_precondition the machine is offline/);
});

test("a session without an access token still resolves approvals on the box gateway", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "gbot-backend-approval-override-"));
  const calls = mockApi(t, {
    box: {
      listAgents: () => ({ agents: [{ id: "bot-1", name: "General", isGroup: false }] }),
      getAgentTranscriptTail: () => ({ entries: approvalCards() }),
      resolveLocalToolPermission: () => ({}),
    },
  });
  await withEnv(envFor(home, { GROK_BOT_GATEWAY_URL: BOX, GROK_BOT_GATEWAY_TOKEN: GATEWAY }), async () => {
    const session = await connectGateway();
    await respondGrokApproval(session, "General", { entryId: "card-local", requestId: "ask-local", decision: "accept" });
  });
  assert.deepEqual(boxCalls(calls, "resolveLocalToolPermission").map((call) => call.body), [
    { agentId: "bot-1", entryId: "card-local", requestId: "ask-local", resolution: "allow-once" },
  ]);
  assert.equal(calls.filter((call) => call.rpc).length, 0);
});

// --- Review fixes (Opus, 2026-11-05) ---------------------------------------------------------------

test("reconcile reports PENDING and UNKNOWN_DURABILITY as pending, never as not found", async (t) => {
  let status = "GROK_BOT_SEND_STATUS_PENDING";
  let entries = [];
  const { calls, run } = await backendSession(t, {
    rpcs: {
      GetGrokBotSendStatus: () => (status ? { status } : {}),
      ListGrokBotTranscriptEntries: () => tailPage(entries),
    },
  });
  for (const [answer, name] of [
    ["GROK_BOT_SEND_STATUS_PENDING", "PENDING"],
    ["GROK_BOT_SEND_STATUS_UNKNOWN_DURABILITY", "UNKNOWN_DURABILITY"],
    // proto3 JSON leaves UNSPECIFIED out; the app reads it as unknown durability.
    ["", "UNSPECIFIED"],
  ]) {
    status = answer;
    const out = await run((session) => reconcileDelivery(session, "General", "nonce-p"));
    assert.equal(out.status, "pending", name);
    assert.equal(out.sendStatus, name);
    assert.equal(out.scanned, 0);
  }
  // The tail still wins when it already shows the message.
  status = "GROK_BOT_SEND_STATUS_PENDING";
  entries = [{ kind: "message", id: "t8u", role: "user", clientNonce: "nonce-p" }];
  const landed = await run((session) => reconcileDelivery(session, "General", "nonce-p"));
  assert.deepEqual({ status: landed.status, entryId: landed.entryId, sendStatus: landed.sendStatus }, { status: "delivered", entryId: "t8u", sendStatus: "PENDING" });
  status = "GROK_BOT_SEND_STATUS_NOT_FOUND";
  entries = [];
  const missing = await run((session) => reconcileDelivery(session, "General", "nonce-p"));
  assert.deepEqual({ status: missing.status, sendStatus: missing.sendStatus }, { status: "not-found-in-tail", sendStatus: "NOT_FOUND" });
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 0);
});

test("reconcile reports REJECTED as rejected, with the rejection code, without reading the tail", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      GetGrokBotSendStatus: () => ({ status: "GROK_BOT_SEND_STATUS_REJECTED", rejectionCode: "send/too-long" }),
      ListGrokBotTranscriptEntries: () => tailPage([]),
    },
  });
  const out = await run((session) => reconcileDelivery(session, "General", "nonce-x"));
  assert.deepEqual({ ...out, target: out.target.id }, {
    target: "bot-1", clientNonce: "nonce-x", status: "rejected", sendStatus: "REJECTED", rejectionCode: "send/too-long",
  });
  assert.equal(rpcCalls(calls, "ListGrokBotTranscriptEntries").length, 0);
});

test("a truncated server roster resolves ids only, so no send, delete, update or member change hits the wrong bot", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      // The exact "Scout" may be past the cut; only "Scout · Night" came back.
      ListGrokBotAgents: () => ({ agents: [bot("bot-2", "Scout · Night"), bot("bot-1", "General")], truncated: true }),
      SendGrokBotUserMessage: () => ({ delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL" }),
    },
  });
  await run(async (session) => {
    const truncated = { code: "ROSTER_TRUNCATED", message: /only part of the bot list \(truncated\), so "Scout" is not matched by name\. Use the bot or group id\./ };
    await assert.rejects(resolveRef(session, "Scout"), truncated);
    const send = await sendPrompt(session, "Scout", "hi", { clientNonce: "nonce-t" }).then(() => assert.fail("expected refusal"), (err) => err);
    assert.equal(send.code, "ROSTER_TRUNCATED");
    assert.equal(send.delivery, "rejected");
    await assert.rejects(deleteAgent(session, "General"), { code: "ROSTER_TRUNCATED" });
    await assert.rejects(updateAgent(session, "Scout · Night", { title: "x" }), { code: "ROSTER_TRUNCATED" });
    await assert.rejects(createGroup(session, { name: "Night", memberIds: ["General"] }), { code: "ROSTER_TRUNCATED" });
    await assert.rejects(resolveRef(session, "bot-404"), { code: "ROSTER_TRUNCATED" });
    // An id still resolves.
    const out = await sendPrompt(session, "bot-2", "hi", { clientNonce: "nonce-id" });
    assert.equal(out.delivery, "accepted");
  });
  for (const rpc of ["DeleteGrokBotAgent", "UpdateGrokBotAgent", "CreateGrokBotRoom"]) assert.equal(rpcCalls(calls, rpc).length, 0, rpc);
  assert.deepEqual(rpcCalls(calls, "SendGrokBotUserMessage").map((call) => call.body.agentId), ["bot-2"]);
});

test("an empty or whitespace-only ref is refused, never matched to an untitled bot", async (t) => {
  const { calls, run } = await backendSession(t, { rpcs: { ListGrokBotAgents: () => ({ agents: [bot("bot-1", "General")] }) } });
  await run(async (session) => {
    for (const ref of ["", "   ", "\t"]) {
      await assert.rejects(resolveRef(session, ref), /A bot or group name or id is required\./);
      await assert.rejects(deleteAgent(session, ref), /A bot or group name or id is required\./);
    }
  });
  assert.equal(rpcCalls(calls, "DeleteGrokBotAgent").length, 0);
});

for (const [label, caps] of [
  ["durableIdentityEnabled false", () => ({ capabilities: { temporalCreationEnabled: true } })],
  ["no capabilities", () => ({})],
  ["failed_precondition from GetGrokBotRuntimeCapabilities", () => connectError("failed_precondition", "not enabled", 400)],
]) {
  test(`server roster off (${label}): the box roster and the box gateway, said on stderr and in the records`, async (t) => {
    const errors = [];
    t.mock.method(console, "error", (...args) => { errors.push(args.join(" ")); });
    const { calls, run } = await backendSession(t, {
      rpcs: { GetGrokBotRuntimeCapabilities: caps },
      box: {
        listAgents: () => ({ agents: [{ id: "bot-1", name: "General", harness: "temporal" }, { id: "bot-2", name: "Scout" }] }),
        sendPrompt: () => ({ accepted: true }),
        createGroup: (body) => ({ id: "grp-1", name: body.name, isGroup: true, memberIds: body.memberAgentIds }),
      },
    });
    await run(async (session) => {
      const rows = await listAgents(session);
      assert.deepEqual(rows.map((r) => [r.id, r.roster]), [["bot-1", "box"], ["bot-2", "box"]]);
      const sent = await sendPrompt(session, "General", "hi", { clientNonce: "nonce-box" });
      assert.equal(sent.delivery, "accepted");
      assert.equal(sent.target.roster, "box");
      const group = await createGroup(session, { name: "Box group", memberIds: ["General", "Scout"] });
      assert.equal(group.id, "grp-1");
    });
    assert.deepEqual(boxCalls(calls, "sendPrompt").map((call) => call.body.clientNonce), ["nonce-box"]);
    assert.deepEqual(boxCalls(calls, "createGroup").map((call) => call.body.memberAgentIds), [["bot-1", "bot-2"]]);
    for (const rpc of ["SendGrokBotUserMessage", "CreateGrokBotRoom"]) assert.equal(rpcCalls(calls, rpc).length, 0, rpc);
    // One capability call for the session, and one stderr notice.
    assert.equal(rpcCalls(calls, "GetGrokBotRuntimeCapabilities").length, 1);
    assert.equal(errors.filter((line) => /server roster is off for this login/.test(line)).length, 1);
  });
}

test("the capability answer is asked once per session while the server roster is on", async (t) => {
  const { calls, run } = await backendSession(t);
  await run(async (session) => {
    await listAgents(session);
    await resolveRef(session, "General");
    await resolveRef(session, "Launch");
  });
  assert.equal(rpcCalls(calls, "GetGrokBotRuntimeCapabilities").length, 1);
  assert.equal(rpcCalls(calls, "ListGrokBotAgents").length, 3);
});

for (const [label, rpcs] of [
  ["ListGrokBotAgents failed_precondition with the server roster on", { ListGrokBotAgents: () => connectError("failed_precondition", "nope", 400) }],
  ["ListGrokBotAgents unimplemented", { ListGrokBotAgents: () => connectError("unimplemented", "nope", 404) }],
  ["GetGrokBotRuntimeCapabilities 503", { GetGrokBotRuntimeCapabilities: () => connectError("unavailable", "down", 503) }],
  ["GetGrokBotRuntimeCapabilities permission_denied", { GetGrokBotRuntimeCapabilities: () => connectError("permission_denied", "no", 403) }],
]) {
  test(`${label} fails closed: no box roster, nothing sent`, async (t) => {
    const { calls, run } = await backendSession(t, {
      rpcs,
      box: { listAgents: () => ({ agents: [{ id: "bot-1", name: "General" }] }), sendPrompt: () => ({ accepted: true }) },
    });
    const error = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-closed" }))
      .then(() => assert.fail("expected a failure"), (err) => err);
    assert.equal(error.delivery, "rejected");
    assert.equal(boxCalls(calls, "sendPrompt").length, 0);
    assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 0);
  });
}

for (const [label, answer] of [
  ["permission_denied", () => connectError("permission_denied", "not yours", 403)],
  ["a 503", () => connectError("unavailable", "down", 503)],
  ["a transport failure", () => { throw new TypeError("fetch failed"); }],
]) {
  test(`a server roster failure of ${label} does not fall back to the box roster`, async (t) => {
    const { calls, run } = await backendSession(t, {
      rpcs: { ListGrokBotAgents: answer },
      box: { listAgents: () => ({ agents: [{ id: "bot-1", name: "General" }] }), sendPrompt: () => ({ accepted: true }) },
    });
    const error = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-no" }))
      .then(() => assert.fail("expected a failure"), (err) => err);
    assert.equal(error.delivery, "rejected", "nothing was sent");
    assert.equal(boxCalls(calls, "sendPrompt").length, 0);
    assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 0);
  });
}

test("a failed ListGrokBotAgentStatuses leaves notify and hidden out instead of failing the list", async (t) => {
  const { run } = await backendSession(t, { rpcs: { ListGrokBotAgentStatuses: () => connectError("internal", "boom", 500) } });
  const rows = await run((session) => listAgents(session));
  assert.deepEqual(rows.map((r) => r.id), ["bot-1", "bot-2", "bot-3", "room-1"]);
  for (const row of rows) {
    assert.equal("notifyOnAgentUpdates" in row, false);
    assert.equal("hiddenFromSidebar" in row, false);
  }
});

test("the box merge dedups on legacyAgentId and skips server rows without an agentId", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      ListGrokBotAgents: () => ({
        agents: [
          bot("uuid-new", "Legacy Bot", { legacyAgentId: "box-old" }),
          // No agentId: the app drops it, and so does gbot (DeleteGrokBotAgent would get the wrong id).
          { id: "77", legacyAgentId: "legacy-only", name: "No Agent Id", harness: "temporal", kind: "GROK_BOT_AGENT_KIND_AGENT" },
        ],
      }),
    },
    box: { listAgents: () => ({ agents: [{ id: "box-old", name: "Legacy Bot", harness: "box" }, { id: "legacy-only", name: "No Agent Id", harness: "box" }] }) },
  });
  const rows = await run((session) => listAgents(session));
  // "legacy-only" is not on the server as an addressable bot, so its box row stays a box-only row.
  assert.deepEqual(rows.map((r) => [r.id, r.name]), [["uuid-new", "Legacy Bot"], ["legacy-only", "No Agent Id"]]);
  await run(async (session) => {
    assert.equal((await resolveRef(session, "Legacy Bot")).id, "uuid-new");
  });
  assert.equal(boxCalls(calls, "listAgents").length, 2);
});

test("SetGrokBotRoomMembers must answer with the room that was asked for", async (t) => {
  let answer = (body) => ({ agent: room("room-other", "Other", body.memberAgentIds) });
  const { calls, run } = await backendSession(t, { rpcs: { SetGrokBotRoomMembers: (body) => answer(body) } });
  await run(async (session) => {
    await assert.rejects(setGroupMembers(session, "Launch", ["General"]), {
      code: "ROOM_MISMATCH",
      message: /answered for a different room; the members may have changed\. Check gbot groups get room-1\./,
    });
    answer = () => ({});
    await assert.rejects(setGroupMembers(session, "Launch", ["General"]), { code: "ROOM_MISMATCH", message: /without the room/ });
    answer = (body) => ({ agent: bot("room-1", "Launch", { memberAgentIds: body.memberAgentIds }) });
    await assert.rejects(setGroupMembers(session, "Launch", ["General"]), { code: "ROOM_MISMATCH" });
  });
  assert.equal(rpcCalls(calls, "SetGrokBotRoomMembers").length, 3);
});

test("a backend 408 on send is delivery unknown and asks the status once", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      SendGrokBotUserMessage: () => connectError("deadline_exceeded", "slow", 408),
      GetGrokBotSendStatus: () => ({ status: "GROK_BOT_SEND_STATUS_PENDING" }),
    },
  });
  const error = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-408" }))
    .then(() => assert.fail("expected unknown"), (err) => err);
  assert.equal(error.status, 408);
  assert.equal(error.delivery, "unknown");
  assert.equal(error.effect, "unknown");
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 1);
  assert.equal(rpcCalls(calls, "GetGrokBotSendStatus").length, 1);
});

test("UNSPECIFIED followed by a REJECTED status is a definite rejection", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      SendGrokBotUserMessage: () => ({ dispatched: false }),
      GetGrokBotSendStatus: () => ({ status: "GROK_BOT_SEND_STATUS_REJECTED", rejectionCode: "send/blocked" }),
    },
  });
  const error = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-u" }))
    .then(() => assert.fail("expected rejected"), (err) => err);
  assert.equal(error.delivery, "rejected");
  assert.equal(error.failureCode, "send/blocked");
  assert.equal(error.code, "SEND_REFUSED");
  assert.equal(error.clientNonce, "nonce-u");
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 1);
});

test("an abort after the send was transmitted keeps the send's own answer and skips the status read", async (t) => {
  const controller = new AbortController();
  let answer = () => connectError("unavailable", "down", 503);
  const { calls, run } = await backendSession(t, {
    rpcs: {
      SendGrokBotUserMessage: () => {
        controller.abort();
        return answer();
      },
      GetGrokBotSendStatus: () => ({ status: "GROK_BOT_SEND_STATUS_ACCEPTED" }),
    },
  });
  const error = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-abort", signal: controller.signal }))
    .then(() => assert.fail("expected unknown"), (err) => err);
  assert.equal(error.delivery, "unknown");
  assert.equal(error.effect, "unknown");
  assert.equal(rpcCalls(calls, "GetGrokBotSendStatus").length, 0);
  const second = new AbortController();
  answer = () => {
    second.abort();
    return json({ dispatched: true, delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL" });
  };
  const accepted = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-abort-2", signal: second.signal }));
  assert.equal(accepted.delivery, "accepted");
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 2);
});

// --- Review fixes (agy, 2026-11-05) ----------------------------------------------------------------

test("a box-only row never shadows a titled server bot: an exact box match next to a folded server match is ambiguous", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      ListGrokBotAgents: () => ({ agents: [bot("bot-2", "Scout · Night"), bot("bot-1", "General"), bot("bot-3", "Ranger · Day")] }),
      SendGrokBotUserMessage: () => ({ delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL" }),
      DeleteGrokBotAgent: () => ({}),
    },
    box: {
      listAgents: () => ({
        agents: [
          // A box-harness row the server does not list, named like the server bot's plain name.
          { id: "box-scout", name: "Scout", title: "Night", harness: "box" },
          { id: "box-only", name: "Local Only", harness: "box" },
        ],
      }),
    },
  });
  await run(async (session) => {
    // The server bot matches only by its folded name, the box row exactly: two bots or one, so refuse.
    for (const ref of ["Scout", "Night"]) {
      await assert.rejects(resolveRef(session, ref), new RegExp(`Ambiguous name "${ref}" \\(a server bot and a box-only bot match\\)\\. Use the id\\.`));
      await assert.rejects(deleteAgent(session, ref), /Ambiguous name/);
    }
    // The folded rule matches both halves of a server bot's "name · title".
    assert.equal((await resolveRef(session, "Ranger")).id, "bot-3");
    assert.equal((await resolveRef(session, "Day")).id, "bot-3");
    assert.equal((await resolveRef(session, "Local Only")).id, "box-only");
    const sent = await sendPrompt(session, "bot-2", "hi", { clientNonce: "nonce-shadow" });
    assert.equal(sent.target.id, "bot-2");
    await deleteAgent(session, "Ranger");
  });
  assert.deepEqual(rpcCalls(calls, "SendGrokBotUserMessage").map((call) => call.body.agentId), ["bot-2"]);
  assert.deepEqual(rpcCalls(calls, "DeleteGrokBotAgent").map((call) => call.body), [{ id: "bot-3" }]);
  assert.equal(boxCalls(calls, "sendPrompt").length + boxCalls(calls, "deleteAgent").length, 0);
});

test("a box row listed under the server bot's legacyAgentId is not merged, so it cannot shadow the server bot", async (t) => {
  const { run } = await backendSession(t, {
    rpcs: { ListGrokBotAgents: () => ({ agents: [bot("uuid-new", "Bot · Title", { legacyAgentId: "box-old" })] }) },
    box: { listAgents: () => ({ agents: [{ id: "box-old", name: "Bot", title: "Title", harness: "box" }] }) },
  });
  await run(async (session) => {
    const rows = await listAgents(session);
    assert.deepEqual(rows.map((r) => r.id), ["uuid-new"]);
    assert.equal((await resolveRef(session, "Bot")).id, "uuid-new");
    assert.equal((await resolveRef(session, "Title")).id, "uuid-new");
  });
});

test("skills pick a bot the server lists (agentId or legacyAgentId), never a box-only row", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: { ListGrokBotAgents: () => ({ agents: [bot("uuid-new", "Server Bot", { legacyAgentId: "box-old" })] }) },
    box: {
      listAgents: () => ({
        agents: [
          { id: "box-only", name: "Local Only", harness: "box" },
          { id: "ghost", name: "Deleted", harness: "temporal" },
          { id: "box-old", name: "Server Bot", harness: "box" },
        ],
      }),
      getAgentWorkflows: () => ({ workflows: [{ id: "w1", name: "Skill" }] }),
    },
  });
  const skills = await run((session) => listSkills(session));
  assert.deepEqual(skills.map((skill) => skill.id), ["w1"]);
  assert.deepEqual(boxCalls(calls, "getAgentWorkflows").map((call) => call.body), [{ id: "box-old" }]);
});

for (const [label, answer] of [
  ["Connect canceled (HTTP 499)", () => connectError("canceled", "client went away", 499)],
  ["deadline_exceeded on a 4xx", () => connectError("deadline_exceeded", "slow", 400)],
  ["unavailable on a 4xx", () => connectError("unavailable", "busy", 429)],
  ["unknown", () => connectError("unknown", "?", 400)],
  ["internal", () => connectError("internal", "boom", 400)],
]) {
  test(`a send answered with ${label} may have landed: unknown, after one status read`, async (t) => {
    const { calls, run } = await backendSession(t, {
      rpcs: { SendGrokBotUserMessage: answer, GetGrokBotSendStatus: () => ({ status: "GROK_BOT_SEND_STATUS_NOT_FOUND" }) },
    });
    const error = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-maybe" }))
      .then(() => assert.fail("expected unknown"), (err) => err);
    assert.equal(error.delivery, "unknown");
    assert.equal(error.effect, "unknown");
    assert.equal(rpcCalls(calls, "GetGrokBotSendStatus").length, 1);
    assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 1);
  });
}

test("a timed-out send settled as REJECTED is a fresh rejection, and an unknown one says so once", async (t) => {
  let status = "GROK_BOT_SEND_STATUS_REJECTED";
  const { run } = await backendSession(t, {
    rpcs: {
      SendGrokBotUserMessage: () => {
        throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      },
      GetGrokBotSendStatus: () => ({ status, rejectionCode: "send/expired" }),
    },
  });
  const rejected = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-tr" }))
    .then(() => assert.fail("expected rejected"), (err) => err);
  assert.equal(rejected.delivery, "rejected");
  assert.equal(rejected.code, "SEND_REFUSED");
  assert.equal(rejected.status, undefined);
  assert.equal(rejected.effect, undefined);
  assert.equal(rejected.failureCode, "send/expired");
  assert.equal(rejected.clientNonce, "nonce-tr");
  assert.match(rejected.message, /rejected after GATEWAY_TIMEOUT/);
  assert.doesNotMatch(rejected.message, /delivery (is )?unknown/);
  assert.equal(outcomeFromError(rejected).delivery, "rejected");
  status = "GROK_BOT_SEND_STATUS_PENDING";
  const unknown = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-tu" }))
    .then(() => assert.fail("expected unknown"), (err) => err);
  assert.equal(unknown.delivery, "unknown");
  assert.equal(unknown.code, "GATEWAY_TIMEOUT");
  assert.equal(unknown.message.match(/delivery (is )?unknown/g).length, 1, unknown.message);
});

test("server text is redacted before it is cut, in errors and in refusals", async (t) => {
  const pad = "x".repeat(290);
  const { run } = await backendSession(t, {
    rpcs: {
      // The token straddles character 300 of the detail.
      DeleteGrokBotAgent: () => connectError("permission_denied", pad + ACCESS, 403),
      SendGrokBotUserMessage: () => ({
        delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED",
        refusal: { failureCode: "send/blocked", message: "blocked for " + ACCESS + " " + "y".repeat(600) },
      }),
    },
  });
  const deleted = await run((session) => deleteAgent(session, "General")).then(() => assert.fail("expected an error"), (err) => err);
  const refused = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-red" })).then(() => assert.fail("expected refusal"), (err) => err);
  for (const error of [deleted, refused]) {
    assert.doesNotMatch(error.message, /synthetic-backend|access-do-not|ACCESS/);
    assert.match(error.message, /<redacted>/);
  }
  assert.ok(deleted.message.length < 400, "bounded");
  assert.ok(refused.message.length < 400, "bounded");
});

test("createGroup checks the avatar before creating, reuses the server id, and names the room when the follow-up fails", async (t) => {
  let update = (body) => ({ agent: room("room-9", "Night", ["bot-1"], { id: body.id, title: body.title }) });
  const { calls, run } = await backendSession(t, {
    rpcs: {
      CreateGrokBotRoom: (body) => ({ agent: room("room-9", body.name, body.memberAgentIds, { id: "1009" }) }),
      UpdateGrokBotAgent: (body) => update(body),
    },
  });
  await run(async (session) => {
    await assert.rejects(createGroup(session, { name: "Night", memberIds: ["General"], avatarShape: "triangle" }), /Unknown avatar shape "triangle"/);
    await assert.rejects(createGroup(session, { name: "Night", memberIds: ["General"], avatarColor: "plaid" }), /Unknown avatar color "plaid"/);
    assert.equal(rpcCalls(calls, "CreateGrokBotRoom").length, 0, "nothing created for a bad avatar");
    const listsBefore = rpcCalls(calls, "ListGrokBotAgents").length;
    const rec = await createGroup(session, { name: "Night", memberIds: ["General"], title: "Night room" });
    assert.equal(rec.id, "room-9");
    assert.equal(rec.title, "Night room");
    assert.deepEqual(rpcCalls(calls, "UpdateGrokBotAgent").map((call) => call.body), [{ id: "1009", title: "Night room", partialUpdate: true }]);
    assert.equal(rpcCalls(calls, "ListGrokBotAgents").length - listsBefore, 1, "one roster read for the members, none after");
    update = () => connectError("unavailable", "down", 503);
    await assert.rejects(
      createGroup(session, { name: "Night", memberIds: ["General"], avatarColor: "red" }),
      /UpdateGrokBotAgent failed: 503 unavailable down The group was created \(id room-9\) without its title or avatar; set them with gbot groups update room-9\./,
    );
  });
});

test("updateAgent sets notify and hidden on a server bot without a numeric id, and refuses only a profile edit", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      ListGrokBotAgents: () => ({ agents: [{ ...bot("bot-1", "General"), id: "" }] }),
      SetGrokBotAgentClientState: () => ({ state: {} }),
    },
    box: { setAgentNotifyOnUpdates: () => ({}) },
  });
  await run(async (session) => {
    await updateAgent(session, "General", { hiddenFromSidebar: true });
    await assert.rejects(updateAgent(session, "General", { title: "x" }), /no numeric id for "General"/);
  });
  assert.deepEqual(rpcCalls(calls, "SetGrokBotAgentClientState").map((call) => call.body), [{ agentId: "bot-1", hiddenFromSidebar: true }]);
  assert.equal(boxCalls(calls, "setAgentHiddenFromSidebar").length, 0);
  assert.equal(boxCalls(calls, "updateAgent").length, 0);
  assert.equal(rpcCalls(calls, "UpdateGrokBotAgent").length, 0);
});

test("add and remove member read the roster once", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: { SetGrokBotRoomMembers: (body) => ({ agent: room(body.agentId, "Launch", body.memberAgentIds) }) },
  });
  await run(async (session) => {
    const before = rpcCalls(calls, "ListGrokBotAgents").length;
    await addGroupMember(session, "Launch", "Box Helper");
    await removeGroupMember(session, "Launch", "General");
    assert.equal(rpcCalls(calls, "ListGrokBotAgents").length - before, 2);
  });
});

// Test mode allows any loopback backend and returns before the ALLOW_ANY branch, so this runs with test
// mode off, fetch fully mocked, and plaintext saved tokens (no OS secret store).
test("outside test mode an app login token never reaches a non-Cursor backend, even with GROK_BOT_ALLOW_ANY_GATEWAY", {
  skip: process.platform === "win32" ? "POSIX app data paths" : false,
}, async (t) => {
  const sub = "user_synthetic_allow_any_backend";
  const scope = crypto.createHash("sha256").update(sub).digest("hex");
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const appToken = `${part({ alg: "none" })}.${part({ sub, exp: Math.floor(Date.now() / 1000) + 3600, iss: "https://authentication.cursor.sh" })}.sig`;
  const home = mkdtempSync(join(tmpdir(), "gbot-backend-allowany-"));
  const env = envFor(home, {
    GROK_BOT_TEST: null,
    NODE_ENV: null,
    CURSOR_ACCESS_TOKEN: null,
    CURSOR_API_BASE_URL: "https://api2.cursor.sh",
    GROK_BOT_ALLOW_ANY_GATEWAY: "1",
    GBOT_CONFIG: join(home, "gbot-config.json"),
  });
  const secrets = join(dirname(grokBotGatewayDescriptorPath(home, process.platform, env)), "sand-secrets.json");
  mkdirSync(dirname(secrets), { recursive: true });
  writeFileSync(secrets, JSON.stringify({
    version: 1,
    "cursor-accounts": JSON.stringify({ active: scope, accounts: { [scope]: { "cursor-access-token": `plaintext:v1:${appToken}` } } }),
  }));
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const target = String(url);
    urls.push(target);
    if (target.endsWith("/EnsureSandBox")) {
      return json({ runState: "SAND_BOX_RUN_STATE_RUNNING", gatewayUrl: "https://box-test.cursorvm.com", gatewayToken: GATEWAY });
    }
    if (target.endsWith("/GetGrokBotRuntimeCapabilities")) return json(CAPS_ON);
    if (target.endsWith("/ListGrokBotAgents")) return json({ agents: SERVER });
    if (target.endsWith("/api/listAgents")) return json({ agents: [] });
    return new Response("unexpected", { status: 599 });
  });
  await withEnv(env, async () => {
    const session = await connectGateway();
    assert.equal(hasBackend(session), true);
    assert.equal((await resolveRef(session, "General")).id, "bot-1");
    assert.ok(urls.includes("https://api2.cursor.sh/aiserver.v1.GrokBotService/ListGrokBotAgents"));
    process.env.CURSOR_API_BASE_URL = "https://evil.example";
    const error = await sendPrompt(session, "General", "hi", { clientNonce: "nonce-evil" })
      .then(() => assert.fail("expected a refusal"), (err) => err);
    assert.match(error.message, /Rejected backend URL host "evil\.example"\. Expected \*\.cursor\.sh \/ \*\.cursor\.com\. An app login token is only sent to https Cursor API hosts\./);
    assert.equal(error.delivery, "rejected");
  });
  assert.equal(urls.some((url) => url.includes("evil.example")), false);

  // A user-supplied CURSOR_ACCESS_TOKEN still follows GROK_BOT_ALLOW_ANY_GATEWAY.
  urls.length = 0;
  const bare = mkdtempSync(join(tmpdir(), "gbot-backend-allowany-env-"));
  await withEnv(envFor(bare, {
    GROK_BOT_TEST: null,
    NODE_ENV: null,
    CURSOR_ACCESS_TOKEN: ACCESS,
    CURSOR_API_BASE_URL: "https://evil.example",
    GROK_BOT_ALLOW_ANY_GATEWAY: "1",
    GBOT_CONFIG: join(bare, "gbot-config.json"),
  }), async () => {
    const session = await connectGateway();
    assert.equal((await resolveRef(session, "General")).id, "bot-1");
  });
  assert.ok(urls.includes("https://evil.example/aiserver.v1.GrokBotService/ListGrokBotAgents"));
});

// --- Round 2 review fixes (Opus, 2026-11-05) ---------------------------------------------------------

test("auto-review cards of a non-temporal bot go to the box gateway; local-tool cards try the backend first", async (t) => {
  let local = () => ({ dispatched: true });
  const { calls, run } = await backendSession(t, {
    rpcs: {
      ListGrokBotAgents: () => ({ agents: [bot("bot-1", "General"), bot("bot-9", "Old Box", { harness: "box" })] }),
      ResolveGrokBotAutoReviewApproval: () => ({ dispatched: true }),
      ResolveGrokBotLocalToolPermission: () => local(),
      // A box-harness bot the server lists: its transcript is on the backend too.
      ListGrokBotTranscriptEntries: () => tailPage(approvalCards()),
    },
    box: {
      resolveAutoReviewApproval: () => ({}),
      resolveLocalToolPermission: () => ({}),
    },
  });
  await run(async (session) => {
    const review = await respondGrokApproval(session, "Old Box", { entryId: "card-review", requestId: "ask-review", decision: "accept" });
    assert.deepEqual({ delivery: review.delivery, via: review.via }, { delivery: "accepted", via: "box" });
    const viaBackend = await respondGrokApproval(session, "Old Box", { entryId: "card-local", requestId: "ask-local", decision: "accept" });
    assert.deepEqual({ delivery: viaBackend.delivery, via: viaBackend.via }, { delivery: "accepted", via: "backend" });
    // The app's next step for a non-temporal bot when the backend does not handle the card.
    local = () => connectError("unimplemented", "not for box bots", 404);
    const onBox = await respondGrokApproval(session, "Old Box", { entryId: "card-local", requestId: "ask-local", decision: "decline" });
    assert.equal(onBox.via, "box");
    // A temporal bot never moves on to the box.
    await assert.rejects(
      respondGrokApproval(session, "General", { entryId: "card-local", requestId: "ask-local", decision: "decline" }),
      { code: "unimplemented" },
    );
  });
  assert.deepEqual(rpcCalls(calls, "ResolveGrokBotAutoReviewApproval").length, 0, "the non-temporal auto-review card never reaches the backend");
  assert.deepEqual(boxCalls(calls, "resolveAutoReviewApproval").map((call) => call.body), [
    { agentId: "bot-9", entryId: "card-review", requestId: "ask-review", resolution: "approved" },
  ]);
  assert.deepEqual(boxCalls(calls, "resolveLocalToolPermission").map((call) => call.body.resolution), ["deny"]);
  assert.equal(rpcCalls(calls, "ResolveGrokBotLocalToolPermission").length, 3);
});

test("an approval answer with dispatched false is reported as unknown, not accepted", async (t) => {
  const { run } = await backendSession(t, {
    rpcs: {
      ResolveGrokBotAutoReviewApproval: () => ({ dispatched: false }),
      ResolveGrokBotLocalToolPermission: () => ({}),
      ListGrokBotTranscriptEntries: () => tailPage(approvalCards()),
    },
  });
  await run(async (session) => {
    for (const [entryId, requestId] of [["card-review", "ask-review"], ["card-local", "ask-local"]]) {
      const out = await respondGrokApproval(session, "General", { entryId, requestId, decision: "accept" });
      assert.equal(out.delivery, "unknown");
      assert.equal(out.dispatched, false);
      assert.match(out.note, /dispatched: false/);
    }
  });
});

test("a truncated roster leaves box-only rows out, so an id past the cut is refused, not sent to the box", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: { ListGrokBotAgents: () => ({ agents: [bot("bot-1", "General")], truncated: true }) },
    box: { listAgents: () => ({ agents: [{ id: "bot-9", name: "Past The Cut", harness: "box" }] }), deleteAgent: () => ({}) },
  });
  await run(async (session) => {
    assert.deepEqual((await listAgents(session)).map((r) => r.id), ["bot-1"]);
    await assert.rejects(deleteAgent(session, "bot-9"), { code: "ROSTER_TRUNCATED" });
  });
  assert.equal(boxCalls(calls, "deleteAgent").length, 0);
  assert.equal(rpcCalls(calls, "DeleteGrokBotAgent").length, 0);
});

test("reconcile reads a send status newer than this build as pending", async (t) => {
  const { run } = await backendSession(t, {
    rpcs: {
      GetGrokBotSendStatus: () => ({ status: "GROK_BOT_SEND_STATUS_QUEUED_FOR_REVIEW" }),
      ListGrokBotTranscriptEntries: () => tailPage([]),
    },
  });
  const out = await run((session) => reconcileDelivery(session, "General", "nonce-new"));
  assert.deepEqual({ status: out.status, sendStatus: out.sendStatus }, { status: "pending", sendStatus: "QUEUED_FOR_REVIEW" });
});

test("reconcile keeps a known send status when the transcript tail cannot be read", async (t) => {
  let status = "GROK_BOT_SEND_STATUS_PENDING";
  const { calls, run } = await backendSession(t, {
    rpcs: {
      GetGrokBotSendStatus: () => (status === null ? connectError("unavailable", "down", 503) : { status }),
      ListGrokBotTranscriptEntries: () => connectError("unavailable", "transcript store down", 503),
    },
  });
  for (const [answer, name] of [
    ["GROK_BOT_SEND_STATUS_PENDING", "PENDING"],
    ["GROK_BOT_SEND_STATUS_UNKNOWN_DURABILITY", "UNKNOWN_DURABILITY"],
    ["", "UNSPECIFIED"],
  ]) {
    status = answer;
    const out = await run((session) => reconcileDelivery(session, "General", "nonce-t"));
    assert.equal(out.status, "pending", name);
    assert.equal(out.sendStatus, name);
    assert.equal(typeof out.tailError, "string");
    assert.ok(out.tailError.length > 0);
    assert.equal("scanned" in out, false, "nothing was scanned");
  }
  // With NOT_FOUND, or no status at all, nothing is known, so the tail error stands.
  status = "GROK_BOT_SEND_STATUS_NOT_FOUND";
  await assert.rejects(run((session) => reconcileDelivery(session, "General", "nonce-t")));
  status = null;
  await assert.rejects(run((session) => reconcileDelivery(session, "General", "nonce-t")));
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 0, "reconcile never sends");
});

test("createGroup refuses a room answer without an agentId, and a room without a numeric id names the created room", async (t) => {
  let created = (body) => ({ agent: room("room-9", body.name, body.memberAgentIds, { agentId: "" }) });
  const { calls, run } = await backendSession(t, {
    rpcs: {
      CreateGrokBotRoom: (body) => created(body),
      UpdateGrokBotAgent: () => ({}),
    },
  });
  await run(async (session) => {
    await assert.rejects(
      createGroup(session, { name: "Night", memberIds: ["General"], title: "Night room" }),
      /CreateGrokBotRoom returned a room without an id\. The group may have been created; run gbot groups list/,
    );
    created = (body) => ({ agent: room("room-9", body.name, body.memberAgentIds, { id: "" }) });
    await assert.rejects(
      createGroup(session, { name: "Night", memberIds: ["General"], title: "Night room" }),
      /no numeric id for the new room.*The group was created \(id room-9\) without its title or avatar; set them with gbot groups update room-9\./,
    );
    // Without a title or avatar there is nothing to update, so the missing numeric id does not matter.
    const rec = await createGroup(session, { name: "Night", memberIds: ["General"] });
    assert.equal(rec.id, "room-9");
  });
  assert.equal(rpcCalls(calls, "CreateGrokBotRoom").length, 3);
  assert.equal(rpcCalls(calls, "UpdateGrokBotAgent").length, 0);
});

test("summarize marks a record from the box roster, and only then", () => {
  const base = { id: "bot-1", name: "General", title: "", description: "", avatarShape: "", avatarColor: "", isGroup: false, memberIds: [] };
  assert.equal(summarize({ ...base, roster: "box" }).roster, "box");
  assert.equal("roster" in summarize(base), false);
  assert.equal("harness" in summarize({ ...base, harness: "temporal", serverId: "1" }), false);
});

test("bots create on 0.78 goes to the backend like the app: a client id, the temporal harness, no introduction", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: { CreateGrokBotTemporalAgent: (body) => ({ agent: { ...bot(body.agentId, body.name), harness: "temporal" } }) },
  });
  const { createAgent } = await import("../src/core/gateway.js");
  const rec = await run((session) => createAgent(session, { name: "Demo", description: "Plans trips.", avatarShape: "cloud", avatarColor: "blue" }));
  const [sent] = rpcCalls(calls, "CreateGrokBotTemporalAgent");
  assert.match(sent.body.agentId, UUID_V4);
  assert.equal(sent.body.harness, "GROK_BOT_AGENT_HARNESS_KIND_TEMPORAL");
  assert.equal(sent.body.introductionSuppressed, true);
  assert.equal(sent.body.kickstartRequested, false);
  assert.equal(rec.id, sent.body.agentId);
  assert.equal(boxCalls(calls, "createAgent").length, 0, "the removed box gateway is not called");
});

// --- Transcript tail on the backend (0.78.x: a server-hosted bot has no box gateway) -----------------

// Shaped like the live rows of a demo bot (2026-11-08), with synthetic ids and text.
const tailUser = { kind: "message", id: "t3u", role: "user", content: "Plan a trip.", isStreaming: false, timestampMs: 1794120039993, clientNonce: "nonce-live", requestId: "req-1", seq: 11 };
const tailReply = { kind: "send-message", id: "t3s0", message: { type: "text", content: "Here is the plan." }, timestampMs: 1794120043786, requestId: "req-1", seq: 12 };
const tailEvent = { kind: "event", id: "event-1", event: { type: "automation", action: "created" }, timestampMs: 1794120051474, seq: 13 };

test("a server bot's thread tail comes from ListGrokBotTranscriptEntries, oldest first, never the box", async (t) => {
  const older = { kind: "message", id: "t2u", role: "user", content: "Earlier.", clientNonce: "nonce-old", requestId: "req-0", seq: 10 };
  const { calls, run } = await backendSession(t, {
    rpcs: { ListGrokBotTranscriptEntries: () => tailPage([older, tailUser, tailReply, tailEvent]) },
  });
  const out = await run((session) => getTranscriptTail(session, "General", 3));
  assert.equal(out.target.id, "bot-1");
  // The row body is the entry the box tail returned; seq comes from the row, as a number.
  assert.deepEqual(out.transcript, { entries: [tailUser, tailReply, tailEvent] });
  const listed = rpcCalls(calls, "ListGrokBotTranscriptEntries");
  // Like the app: the main session, limit + 1.
  assert.deepEqual(listed.map((call) => call.body), [{ agentId: "bot-1", limit: 4 }]);
  assert.equal(listed[0].headers.authorization, "Bearer " + ACCESS);
  assert.equal(listed[0].headers["x-cursor-client-type"], "sand");
  assert.equal(boxCalls(calls, "getAgentTranscriptTail").length, 0);
  // What gbot thread prints and what --after, the relay and the MCP tool page through.
  assert.match(formatTranscript(out), /\[user t3u\] Plan a trip\.\n\[send-message t3s0\] Here is the plan\.\n\[event event-1\] /);
  assert.deepEqual(transcriptDelta(out.transcript, { after: "t3u" }).entries.map((entry) => entry.id), ["t3s0", "event-1"]);
});

test("a tail body kept in the store is read from blobs/<sha256>; one that cannot be read is marked unreadable", async (t) => {
  const stored = { kind: "send-message", id: "t4s0", message: { type: "text", content: "A long reply." }, requestId: "req-2" };
  const bytes = Buffer.from(JSON.stringify(stored));
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const tampered = "0".repeat(64);
  const { calls, run } = await backendSession(t, {
    rpcs: {
      ListGrokBotTranscriptEntries: () => ({
        entries: [
          { seq: "7", entryKind: "send-message", entryId: "t4s2", updatedSeq: "7", bodyOmitted: true },
          { seq: "6", entryKind: "send-message", entryId: "t4s1", updatedSeq: "6", blobHash: tampered },
          { seq: "5", entryKind: "send-message", entryId: "t4s0", updatedSeq: "5", blobHash: hash },
        ],
      }),
      PresignSandBoxStoreReads: (body) => ({ instructions: body.relPaths.map((relPath) => ({ relPath, url: STORE + "/" + relPath })) }),
    },
    store: { ["/blobs/" + hash]: bytes, ["/blobs/" + tampered]: Buffer.from("other bytes") },
  });
  const out = await run((session) => getTranscriptTail(session, "General", 40));
  assert.deepEqual(out.transcript, {
    entries: [
      { ...stored, seq: 5 },
      // The bytes do not match the hash, and an omitted body without a hash has nothing to read.
      { id: "t4s1", kind: "send-message", seq: 6, unreadable: true },
      { id: "t4s2", kind: "send-message", seq: 7, unreadable: true },
    ],
    unreadable: 2,
  });
  assert.deepEqual(rpcCalls(calls, "PresignSandBoxStoreReads").map((call) => call.body), [{ relPaths: ["blobs/" + hash, "blobs/" + tampered] }]);
  const storeReads = calls.filter((call) => call.target.startsWith(STORE + "/"));
  assert.equal(storeReads.length, 2);
  assert.equal(JSON.stringify(storeReads.map((call) => call.headers)).includes(ACCESS), false, "the access token never goes to the store");
});

test("reconcile finds a send whose delivery was unknown in the backend tail by its clientNonce, the send's messageId", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      SendGrokBotUserMessage: () => connectError("unavailable", "upstream reset", 503),
      // Not indexed yet: only the transcript shows the message landed.
      GetGrokBotSendStatus: () => ({ status: "GROK_BOT_SEND_STATUS_NOT_FOUND" }),
      ListGrokBotTranscriptEntries: () => tailPage([
        tailUser,
        tailReply,
        { kind: "message", id: "t4u", role: "user", content: "Another.", clientNonce: "nonce-other", requestId: "req-3", seq: 14 },
      ]),
    },
  });
  const unknown = await run((session) => sendPrompt(session, "General", "Plan a trip.", { clientNonce: "nonce-live" }))
    .then(() => assert.fail("expected an unknown delivery"), (err) => err);
  assert.equal(unknown.delivery, "unknown");
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage")[0].body.messageId, "nonce-live");
  const out = await run((session) => reconcileDelivery(session, "General", "nonce-live"));
  assert.deepEqual({ ...out, target: out.target.id }, {
    target: "bot-1", clientNonce: "nonce-live", status: "delivered", entryId: "t3u", seq: 11, sendStatus: "NOT_FOUND",
  });
  assert.deepEqual(rpcCalls(calls, "ListGrokBotTranscriptEntries").map((call) => call.body), [{ agentId: "bot-1", limit: 201 }]);
  assert.equal(boxCalls(calls, "getAgentTranscriptTail").length, 0);
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 1, "reconcile never sends");
});

test("without an access token, or for a box-only bot, the tail stays on the box gateway", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "gbot-backend-tail-box-"));
  const entries = [{ id: "b1", role: "user", clientNonce: "nonce-box", seq: 1 }];
  const calls = mockApi(t, {
    box: {
      listAgents: () => ({ agents: [{ id: "bot-1", name: "General", isGroup: false }, { id: "box-only", name: "Local Box", harness: "box" }] }),
      getAgentTranscriptTail: () => ({ entries }),
    },
  });
  const viaOverride = await withEnv(envFor(home, { GROK_BOT_GATEWAY_URL: BOX, GROK_BOT_GATEWAY_TOKEN: GATEWAY }), async () => {
    const session = await connectGateway();
    assert.equal(hasBackend(session), false);
    return getTranscriptTail(session, "General", 5);
  });
  assert.deepEqual(viaOverride.transcript, { entries });
  assert.equal(calls.filter((call) => call.rpc).length, 0, "no backend call without an access token");
  // With the backend, a bot only the box lists still reads the box.
  const boxOnly = await withEnv(envFor(home), async () => getTranscriptTail(await connectGateway(), "box-only", 5));
  assert.deepEqual(boxOnly.transcript, { entries });
  assert.deepEqual(boxCalls(calls, "getAgentTranscriptTail").map((call) => call.body), [{ id: "bot-1", limit: 5 }, { id: "box-only", limit: 5 }]);
  assert.equal(rpcCalls(calls, "ListGrokBotTranscriptEntries").length, 0);
});

// A GrokBotTemplate as Connect JSON: int64 fields are strings and proto3 leaves false out.
const template = (updatedAtMs, extra = {}) => ({
  shareId: "share-1",
  name: "General",
  avatarShape: "pebble",
  avatarColor: "violet",
  sourceAgentId: "bot-1",
  createdAtMs: "100",
  updatedAtMs: String(updatedAtMs),
  blobObjectKey: "templates/share-1.json",
  published: true,
  activeVersion: 2,
  description: "first",
  visibility: "GROK_BOT_TEMPLATE_VISIBILITY_PUBLIC",
  ownerType: "GROK_BOT_TEMPLATE_OWNER_TYPE_USER",
  ...extra,
});
const ACCEPTED_SEND = () => ({ dispatched: true, delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL" });
const FAST = { waitSeconds: 5, pollSeconds: 0.01 };

test("bots template without a template sends the app's create text with the TEMPLATE_SHARE initiator and waits for it", async (t) => {
  const answers = [{ exportPolicy: "all", hasTeam: true }, {}, connectError("unavailable", "busy", 503), { template: template(500) }];
  const { calls, run } = await backendSession(t, {
    rpcs: {
      GetGrokBotTemplateForSourceAgent: () => answers.shift() ?? assert.fail("read after the template appeared"),
      SendGrokBotUserMessage: ACCEPTED_SEND,
    },
  });
  const out = await run((session) => shareBotTemplate(session, "General", { ...FAST, clientNonce: "nonce-tpl" }));
  assert.equal(out.delivery, "accepted");
  assert.equal(out.action, "created");
  assert.equal(out.clientNonce, "nonce-tpl");
  assert.equal(out.target.id, "bot-1");
  assert.deepEqual(out.template, {
    shareId: "share-1",
    link: "https://x.ai/bot/share-1",
    name: "General",
    published: true,
    visibility: "GROK_BOT_TEMPLATE_VISIBILITY_PUBLIC",
    activeVersion: 2,
    updatedAtMs: 500,
  });
  const sends = rpcCalls(calls, "SendGrokBotUserMessage");
  assert.equal(sends.length, 1);
  const { sentAtMs, ...rest } = sends[0].body;
  assert.deepEqual(rest, {
    agentId: "bot-1",
    messageId: "nonce-tpl",
    text: "Create a public template of yourself that I can share with somebody else",
    source: "GROK_BOT_CLIENT_SURFACE_DESKTOP",
    initiator: "GROK_BOT_USER_MESSAGE_INITIATOR_TEMPLATE_SHARE",
    sendSource: "GROK_BOT_SEND_SOURCE_CHAT",
  });
  assert.match(sentAtMs, /^\d+$/);
  // The read before the send, then polls until it appears; a failed poll read is not fatal.
  assert.deepEqual(rpcCalls(calls, "GetGrokBotTemplateForSourceAgent").map((call) => call.body), Array(4).fill({ sourceAgentId: "bot-1" }));
  assert.equal(rpcCalls(calls, "GetGrokBotSendStatus").length, 0);
  assert.equal(boxCalls(calls, "sendPrompt").length, 0);
});

test("bots template with a template sends the update text and waits for a newer updatedAtMs", async (t) => {
  const answers = [{ template: template(100) }, { template: template(100) }, { template: template(200, { activeVersion: "3", published: undefined }) }];
  const { calls, run } = await backendSession(t, {
    rpcs: {
      GetGrokBotTemplateForSourceAgent: () => answers.shift() ?? assert.fail("read after the update appeared"),
      SendGrokBotUserMessage: ACCEPTED_SEND,
    },
  });
  const out = await run((session) => shareBotTemplate(session, "bot-1", FAST));
  assert.equal(out.action, "updated");
  assert.equal(out.delivery, "accepted");
  assert.match(out.clientNonce, UUID_V4);
  assert.equal(out.template.updatedAtMs, 200);
  assert.equal(out.template.activeVersion, 3);
  assert.equal(out.template.published, false);
  const [sent] = rpcCalls(calls, "SendGrokBotUserMessage");
  assert.equal(sent.body.text, "Update the shared template of yourself.");
  assert.equal(sent.body.initiator, "GROK_BOT_USER_MESSAGE_INITIATOR_TEMPLATE_SHARE");
  assert.equal(sent.body.messageId, out.clientNonce);
  assert.equal(rpcCalls(calls, "GetGrokBotTemplateForSourceAgent").length, 3);
});

test("getBotTemplate reads the template and its link, and sends nothing", async (t) => {
  let answer = { template: template(100), exportPolicy: "all", hasTeam: true };
  const { calls, run } = await backendSession(t, { rpcs: { GetGrokBotTemplateForSourceAgent: () => answer } });
  const found = await run((session) => getBotTemplate(session, "General"));
  assert.equal(found.target.id, "bot-1");
  assert.equal(found.template.link, "https://x.ai/bot/share-1");
  assert.equal(found.template.updatedAtMs, 100);
  assert.equal(found.exportPolicy, "all");
  assert.equal(found.hasTeam, true);
  answer = {};
  const none = await run((session) => getBotTemplate(session, "General"));
  assert.equal(none.template, null);
  assert.equal(none.hasTeam, false);
  assert.equal("exportPolicy" in none, false);
  assert.deepEqual(rpcCalls(calls, "GetGrokBotTemplateForSourceAgent").map((call) => call.body), [{ sourceAgentId: "bot-1" }, { sourceAgentId: "bot-1" }]);
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 0);
  assert.equal(calls.filter((call) => call.method && call.method !== "listAgents").length, 0, "no box call but the roster");
});

test("bots template refuses a box-only bot, a group, and a session without the backend, before any template call", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "gbot-backend-template-box-"));
  const calls = mockApi(t, {
    rpcs: { GetGrokBotTemplateForSourceAgent: () => assert.fail("no template read"), SendGrokBotUserMessage: () => assert.fail("no send") },
    box: { listAgents: () => ({ agents: [{ id: "box-only", name: "Local Box", harness: "box" }]}), sendPrompt: () => assert.fail("no box send") },
  });
  await withEnv(envFor(home), async () => {
    const session = await connectGateway();
    for (const share of [
      (ref) => shareBotTemplate(session, ref, FAST),
      (ref) => getBotTemplate(session, ref),
      (ref) => getBotTemplateVersion(session, ref, { version: 1 }),
      (ref) => publishBotTemplate(session, ref, { version: 1 }),
    ]) {
      await assert.rejects(share("Local Box"), (err) => err.code === "TEMPLATE_NOT_SERVER_BOT" && /box roster only/.test(err.message));
      await assert.rejects(share("Launch"), (err) => err.code === "TEMPLATE_NOT_BOT");
    }
  });
  await withEnv(envFor(home, { GROK_BOT_GATEWAY_URL: BOX, GROK_BOT_GATEWAY_TOKEN: GATEWAY }), async () => {
    const session = await connectGateway();
    assert.equal(hasBackend(session), false);
    await assert.rejects(shareBotTemplate(session, "General", FAST), (err) => err.code === "NO_ACCESS_TOKEN" && /backend/.test(err.message));
    await assert.rejects(getBotTemplate(session, "General"), (err) => err.code === "NO_ACCESS_TOKEN");
    await assert.rejects(getBotTemplateVersion(session, "General"), (err) => err.code === "NO_ACCESS_TOKEN");
    await assert.rejects(publishBotTemplate(session, "General"), (err) => err.code === "NO_ACCESS_TOKEN");
  });
  // A login whose server roster is off has only box records: refused the same way.
  await withEnv(envFor(home), async () => {
    t.mock.restoreAll();
    const offCalls = mockApi(t, {
      rpcs: { GetGrokBotRuntimeCapabilities: () => ({ capabilities: {} }), GetGrokBotTemplateForSourceAgent: () => assert.fail("no template read") },
      box: { listAgents: () => ({ agents: [{ id: "bot-1", name: "General" }] }) },
    });
    const session = await connectGateway();
    await assert.rejects(shareBotTemplate(session, "General", FAST), (err) => err.code === "TEMPLATE_NOT_SERVER_BOT");
    assert.equal(rpcCalls(offCalls, "SendGrokBotUserMessage").length, 0);
  });
  assert.equal(rpcCalls(calls, "GetGrokBotTemplateForSourceAgent").length, 0);
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 0);
});

test("a rejected template message is an error with its nonce, and nothing polls", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      GetGrokBotTemplateForSourceAgent: () => ({}),
      SendGrokBotUserMessage: () => ({
        dispatched: false,
        delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED",
        refusal: { failureCode: "send/agent-unavailable", message: "This bot is not available." },
      }),
    },
  });
  const error = await run((session) => shareBotTemplate(session, "General", { ...FAST, clientNonce: "nonce-no" }))
    .then(() => assert.fail("expected a refusal"), (err) => err);
  assert.equal(error.delivery, "rejected");
  assert.equal(error.code, "SEND_REFUSED");
  assert.equal(error.failureCode, "send/agent-unavailable");
  assert.equal(error.clientNonce, "nonce-no");
  assert.equal(error.targetId, "bot-1");
  assert.equal(outcomeFromError(error).exitCode, 1);
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 1);
  assert.equal(rpcCalls(calls, "GetGrokBotTemplateForSourceAgent").length, 1, "only the read before the send");
});

test("an unknown template message polls for the template and is never sent again", async (t) => {
  const answers = [{}, {}, { template: template(300) }];
  const { calls, run } = await backendSession(t, {
    rpcs: {
      GetGrokBotTemplateForSourceAgent: () => answers.shift() ?? assert.fail("read after the template appeared"),
      SendGrokBotUserMessage: () => connectError("unavailable", "try again", 503),
      GetGrokBotSendStatus: () => ({ status: "GROK_BOT_SEND_STATUS_PENDING" }),
    },
  });
  const out = await run((session) => shareBotTemplate(session, "General", { ...FAST, clientNonce: "nonce-maybe" }));
  assert.equal(out.delivery, "unknown");
  assert.equal(out.clientNonce, "nonce-maybe");
  assert.equal(out.template.shareId, "share-1");
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 1);
  assert.deepEqual(rpcCalls(calls, "GetGrokBotSendStatus").map((call) => call.body), [{ agentId: "bot-1", messageId: "nonce-maybe" }]);
  assert.equal(rpcCalls(calls, "GetGrokBotTemplateForSourceAgent").length, 3);
});

test("a template that does not appear within the wait returns template null after one send; wait 0 does not poll", async (t) => {
  const { calls, run } = await backendSession(t, {
    rpcs: {
      GetGrokBotTemplateForSourceAgent: () => ({ template: template(100) }),
      SendGrokBotUserMessage: ACCEPTED_SEND,
    },
  });
  const started = Date.now();
  const late = await run((session) => shareBotTemplate(session, "General", { waitSeconds: 0.1, pollSeconds: 0.02 }));
  assert.ok(Date.now() - started >= 100);
  assert.equal(late.template, null);
  assert.equal(late.action, "updated");
  assert.equal(late.delivery, "accepted");
  assert.ok(rpcCalls(calls, "GetGrokBotTemplateForSourceAgent").length >= 3, "polled more than once");
  const reads = rpcCalls(calls, "GetGrokBotTemplateForSourceAgent").length;
  const now = await run((session) => shareBotTemplate(session, "General", { waitSeconds: 0 }));
  assert.equal(now.template, null);
  assert.equal(rpcCalls(calls, "GetGrokBotTemplateForSourceAgent").length, reads + 1, "only the read before the send");
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 2, "one send per run");
});

test("a send initiator other than user or template_share is refused before anything is sent", async (t) => {
  const { calls, run } = await backendSession(t, { rpcs: { SendGrokBotUserMessage: ACCEPTED_SEND } });
  for (const initiator of ["template_import", "GROK_BOT_USER_MESSAGE_INITIATOR_TEMPLATE_SHARE", ""]) {
    const error = await run((session) => sendPrompt(session, "General", "hi", { clientNonce: "nonce-bad", initiator }))
      .then(() => assert.fail("expected a refusal"), (err) => err);
    assert.equal(error.code, "INVALID_INITIATOR");
    assert.equal(error.delivery, "rejected");
    assert.equal(error.clientNonce, "nonce-bad");
  }
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage").length, 0);
  const ok = await run((session) => sendPrompt(session, "General", "hi", { initiator: "user" }));
  assert.equal(ok.delivery, "accepted");
  assert.equal(rpcCalls(calls, "SendGrokBotUserMessage")[0].body.initiator, "GROK_BOT_USER_MESSAGE_INITIATOR_USER");
});

// A recipe as the template store keeps it (live shape, 2026-11-08), plus keys the app's parser drops.
const RECIPE = {
  profile: { name: "General", description: "Helps with everything.", avatarColor: "violet", avatarShape: "arch", extra: "dropped" },
  memory: [{ kind: "profile", content: "Job: help.", createdAt: null }, { kind: null, content: "Step 1." }],
  skills: [{ name: "triage", description: "Sort the inbox", content: "# Triage" }],
  routines: [{ name: "Daily", slug: "daily", description: "Every day", content: "Run triage" }],
  plugins: [{ name: "GitLab", pluginId: "gitlab" }],
  gettingStarted: { skill: "triage" },
  unknownTopLevel: true,
};
// A bot-template-share card as the bot posts it in its chat.
const card = (version, shareId = "share-1", seq) => ({
  id: "card-" + shareId + "-" + version,
  kind: "send-message",
  ...(seq ? { seq } : {}),
  message: { type: "bot-template-share", shareId, name: "General", shareUrl: "https://x.ai/bot/" + shareId, version, published: false, visibility: "public", body: "Review it" },
});

function templateVersionRoutes({ active = 0, entries = [], recipe = Buffer.from(JSON.stringify(RECIPE)), blobGetUrl = STORE + "/recipes/share-1" } = {}) {
  return {
    rpcs: {
      GetGrokBotTemplateForSourceAgent: () => ({ template: template(100, { published: active > 0 ? true : undefined, activeVersion: active }) }),
      ListGrokBotTranscriptEntries: () => tailPage(entries),
      GetGrokBotTemplateVersion: (body) => ({ version: body.version, active: body.version === active, createdAtMs: "1794137204348", blobObjectKey: "k", blobGetUrl, visibility: "GROK_BOT_TEMPLATE_VISIBILITY_PUBLIC" }),
      ActivateGrokBotTemplateVersion: (body) => ({ template: template(900, { activeVersion: body.version, published: true }) }),
      SendGrokBotUserMessage: () => assert.fail("no send"),
    },
    store: { "/recipes/share-1": recipe },
  };
}

test("--show reads the newest template card's version and parses the recipe as the app does", async (t) => {
  const entries = [card(9, "other-share"), card(1), { id: "m1", kind: "message", role: "user", content: "hi" }, card(2), { id: "m2", kind: "send-message", message: { type: "text", content: "done" } }];
  const { calls, run } = await backendSession(t, templateVersionRoutes({ entries }));
  const out = await run((session) => getBotTemplateVersion(session, "General"));
  assert.equal(out.version, 2);
  assert.equal(out.versionFrom, "card");
  assert.equal(out.active, false);
  assert.equal(out.createdAtMs, 1794137204348);
  assert.equal(out.visibility, "GROK_BOT_TEMPLATE_VISIBILITY_PUBLIC");
  assert.equal(out.template.link, "https://x.ai/bot/share-1");
  assert.deepEqual(JSON.parse(JSON.stringify(out.recipe)), {
    profile: { name: "General", description: "Helps with everything.", avatarColor: "violet", avatarShape: "arch" },
    memory: [{ kind: "profile", content: "Job: help." }, { content: "Step 1." }],
    skills: RECIPE.skills,
    routines: RECIPE.routines,
    plugins: RECIPE.plugins,
    gettingStarted: { skill: "triage" },
  });
  assert.deepEqual(rpcCalls(calls, "GetGrokBotTemplateVersion").map((call) => call.body), [{ shareId: "share-1", version: 2 }]);
  const [blob] = calls.filter((call) => call.target.startsWith(STORE + "/"));
  assert.equal(blob.headers.authorization, undefined, "no credentials to the store");
  assert.equal(rpcCalls(calls, "ActivateGrokBotTemplateVersion").length, 0);
});

test("--show uses the active version without a card, the given version without reading the chat, and refuses neither", async (t) => {
  const active = await backendSession(t, templateVersionRoutes({ active: 3 }));
  const fromActive = await active.run((session) => getBotTemplateVersion(session, "General"));
  assert.equal(fromActive.version, 3);
  assert.equal(fromActive.versionFrom, "active");
  assert.equal(fromActive.active, true);
  t.mock.restoreAll();
  const given = await backendSession(t, templateVersionRoutes({ entries: [card(2)] }));
  const fromOption = await given.run((session) => getBotTemplateVersion(session, "General", { version: 1 }));
  assert.equal(fromOption.version, 1);
  assert.equal(fromOption.versionFrom, "option");
  assert.equal(rpcCalls(given.calls, "ListGrokBotTranscriptEntries").length, 0);
  t.mock.restoreAll();
  const neither = await backendSession(t, templateVersionRoutes({ entries: [card(4, "other-share")] }));
  await assert.rejects(neither.run((session) => getBotTemplateVersion(session, "General")), (err) => err.code === "TEMPLATE_NO_VERSION" && /--template-version/.test(err.message));
  await assert.rejects(neither.run((session) => publishBotTemplate(session, "General")), (err) => err.code === "TEMPLATE_NO_VERSION");
  assert.equal(rpcCalls(neither.calls, "GetGrokBotTemplateVersion").length, 0);
  assert.equal(rpcCalls(neither.calls, "ActivateGrokBotTemplateVersion").length, 0);
});

test("--show refuses a missing recipe url, a recipe the app's parser refuses, and a bot without a template", async (t) => {
  for (const [label, routes, pattern] of [
    ["no url", { blobGetUrl: "  " }, /returned no recipe url/],
    ["not JSON", { recipe: Buffer.from("not json") }, /recipe is invalid: not JSON/],
    ["empty", { recipe: Buffer.alloc(0) }, /recipe refused: size 0/],
    ["unknown getting-started skill", { recipe: Buffer.from(JSON.stringify({ ...RECIPE, gettingStarted: { skill: "nope" } })) }, /gettingStarted\.skill must name one of this recipe's skills/],
    ["unknown avatar shape", { recipe: Buffer.from(JSON.stringify({ ...RECIPE, profile: { ...RECIPE.profile, avatarShape: "pumpkin" } })) }, /profile\.avatarShape/],
    ["empty description", { recipe: Buffer.from(JSON.stringify({ ...RECIPE, profile: { name: "General", description: "" } })) }, /profile\.description/],
  ]) {
    t.mock.restoreAll();
    const { run } = await backendSession(t, templateVersionRoutes({ entries: [card(1)], ...routes }));
    await assert.rejects(run((session) => getBotTemplateVersion(session, "General")), pattern, label);
  }
  t.mock.restoreAll();
  const { calls, run } = await backendSession(t, { rpcs: { GetGrokBotTemplateForSourceAgent: () => ({ hasTeam: true }) } });
  for (const read of [(session) => getBotTemplateVersion(session, "General"), (session) => publishBotTemplate(session, "General", { version: 1 })]) {
    await assert.rejects(run(read), (err) => err.code === "TEMPLATE_MISSING" && /no template yet/.test(err.message));
  }
  assert.equal(rpcCalls(calls, "GetGrokBotTemplateVersion").length, 0);
  assert.equal(rpcCalls(calls, "ActivateGrokBotTemplateVersion").length, 0);
});

test("--publish calls ActivateGrokBotTemplateVersion with the share id and the card's version", async (t) => {
  const { calls, run } = await backendSession(t, templateVersionRoutes({ entries: [card(1)] }));
  const out = await run((session) => publishBotTemplate(session, "General"));
  assert.equal(out.version, 1);
  assert.equal(out.versionFrom, "card");
  assert.equal(out.template.published, true);
  assert.equal(out.template.activeVersion, 1);
  assert.equal(out.template.link, "https://x.ai/bot/share-1");
  const [activate] = rpcCalls(calls, "ActivateGrokBotTemplateVersion");
  assert.deepEqual(activate.body, { shareId: "share-1", version: 1 });
  assert.equal(activate.headers.authorization, "Bearer " + ACCESS);
  assert.equal(rpcCalls(calls, "ActivateGrokBotTemplateVersion").length, 1);
  assert.equal(rpcCalls(calls, "GetGrokBotTemplateVersion").length, 0, "publishing does not read the recipe");
  t.mock.restoreAll();
  const empty = await backendSession(t, { ...templateVersionRoutes(), rpcs: { ...templateVersionRoutes().rpcs, ActivateGrokBotTemplateVersion: () => ({}) } });
  await assert.rejects(empty.run((session) => publishBotTemplate(session, "General", { version: 2 })), /ActivateGrokBotTemplateVersion returned no template/);
  assert.deepEqual(rpcCalls(empty.calls, "ActivateGrokBotTemplateVersion").map((call) => call.body), [{ shareId: "share-1", version: 2 }]);
});


test("0.78: skills list reads the library from the box store when the box gateway answers 404; edits and --root say why", async (t) => {
  const skill = Buffer.from("---\nname: Ship it\ndescription: >-\n  Release\n  steps.\n---\nBody\n");
  const sha = crypto.createHash("sha256").update(skill).digest("hex");
  const manifest = Buffer.from(JSON.stringify({ version: 1, updatedAtMs: 1, entries: {
    "home/box/sand-data/workflows/ship-it/SKILL.md": { sha, size: skill.length },
    "home/box/sand-data/workflows/ship-it/run.sh": { sha: "1".repeat(64), size: 4 },
    "home/box/sand-data/agents/bot-1/memory/a.md": { sha: "2".repeat(64), size: 3 },
  } }));
  const gone = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  const { calls, run } = await backendSession(t, {
    rpcs: { PresignSandBoxStoreReads: (body) => ({ instructions: body.relPaths.map((relPath) => ({ relPath, url: STORE + "/" + relPath })) }) },
    box: { listAgents: gone, getAgentWorkflows: gone, getAgentThread: gone, importAgentWorkflowText: gone },
    store: { "/manifest.json": manifest, ["/blobs/" + sha]: skill },
  });
  await run(async (session) => {
    assert.deepEqual(await listSkills(session), [{ id: "ship-it", name: "Ship it", description: "Release steps.", source: "workflow" }]);
    const presigned = rpcCalls(calls, "PresignSandBoxStoreReads").flatMap((call) => call.body.relPaths);
    assert.deepEqual(presigned, ["manifest.json", "blobs/" + sha], "only the manifest and the SKILL.md blob");
    assert.ok(calls.filter((call) => call.target.startsWith(STORE + "/")).every((call) => !JSON.stringify(call.headers).includes(ACCESS)), "no token to the store");
    await assert.rejects(addSkill(session, "---\nname: x\n---\nbody"), (error) => error.code === "LIBRARY_EDIT_UNAVAILABLE" && /Grok Bot app/.test(error.message));
    await assert.rejects(removeSkill(session, "ship-it"), (error) => error.code === "LIBRARY_EDIT_UNAVAILABLE");
    await assert.rejects(getThread(session, "General", "t3u"), (error) => error.code === "THREAD_ROOT_UNAVAILABLE" && /gbot thread "General"/.test(error.message));
  });
});

test("skills list keeps the box gateway answer when there is one, and a non-404 failure is not hidden", async (t) => {
  const { calls, run } = await backendSession(t, {
    box: {
      listAgents: () => ({ agents: [{ id: "bot-1", name: "General" }] }),
      getAgentWorkflows: () => ({ workflows: [{ id: "w1", name: "One", description: "d", source: "workflow" }] }),
    },
  });
  await run(async (session) => {
    assert.deepEqual((await listSkills(session)).map((s) => s.id), ["w1"]);
    assert.equal(rpcCalls(calls, "PresignSandBoxStoreReads").length, 0);
  });
  const broken = await backendSession(t, { box: { listAgents: () => new Response("boom", { status: 500 }) } });
  await broken.run(async (session) => {
    await assert.rejects(listSkills(session), (error) => error.status === 500);
  });
});
