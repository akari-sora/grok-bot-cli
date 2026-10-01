import * as files from "./store.js";
import * as gw from "./gateway.js";

function chooseBackend(opts) {
  const forceFiles = Boolean(opts.root) || opts.files;
  const forceGw = Boolean(opts.gateway);
  if (forceGw && forceFiles) {
    throw new files.StoreError("Use --dir/--files or --gateway, not both.");
  }
  if (forceGw || (!forceFiles && gw.hasGatewayAuth())) return "gateway";
  return "files";
}

// Without --dir/--files the files backend is only a fallback for running inside a
// Grok Bot computer. Anywhere else, finding nothing means there is no login yet.
function resolveFilesRoot(opts) {
  try {
    return files.resolveAgentsRoot(opts.root);
  } catch (err) {
    if (opts.root || opts.files || !(err instanceof files.StoreError)) throw err;
    throw new files.StoreError(
      "No Grok Bot login found. Sign in once in the Grok Bot app, then run `gbot accounts`.\n" +
        "Run `gbot doctor` to see where gbot looked. Inside a Grok Bot computer, pass --dir or set GROK_BOT_AGENTS_DIR.",
    );
  }
}

export async function openBackend(opts) {
  const kind = chooseBackend(opts);
  if (kind === "gateway") {
    const session = await gw.connectGateway({ account: opts.account });
    return {
      kind,
      session,
      list: () => gw.listAgents(session),
      resolve: (ref) => gw.resolveRef(session, ref),
      createAgent: (input) => gw.createAgent(session, input),
      updateAgent: (ref, patch) => gw.updateAgent(session, ref, patch),
      deleteAgent: (ref) => gw.deleteAgent(session, ref),
      createGroup: (input) => gw.createGroup(session, input),
      setGroupMembers: (group, members) => gw.setGroupMembers(session, group, members),
      addGroupMember: (group, bot) => gw.addGroupMember(session, group, bot),
      removeGroupMember: (group, bot) => gw.removeGroupMember(session, group, bot),
      send: (ref, prompt, extra) => gw.sendPrompt(session, ref, prompt, extra),
      transcript: (ref, limit) => gw.getTranscriptTail(session, ref, limit),
      thread: (ref, rootId) => gw.getThread(session, ref, rootId),
      skills: () => gw.listSkills(session),
      addSkill: (markdown) => gw.addSkill(session, markdown),
      removeSkill: (skillRef) => gw.removeSkill(session, skillRef),
    };
  }
  const root = resolveFilesRoot(opts);
  return {
    kind,
    root,
    list: async () => files.listRecords(root),
    resolve: async (ref) => files.resolveRef(root, ref),
    createAgent: async (input) => files.createAgent(root, input),
    updateAgent: async (ref, patch) => files.updateAgent(root, ref, patch),
    deleteAgent: async (ref) => files.deleteAgent(root, ref),
    createGroup: async (input) => files.createGroup(root, input),
    setGroupMembers: async (group, members) => files.setGroupMembers(root, group, members),
    addGroupMember: async (group, bot) => files.addGroupMember(root, group, bot),
    removeGroupMember: async (group, bot) => files.removeGroupMember(root, group, bot),
    send: async () => { throw new files.StoreError("send requires the live gateway"); },
    transcript: async () => { throw new files.StoreError("thread requires the live gateway"); },
    thread: async () => { throw new files.StoreError("thread requires the live gateway"); },
    skills: async () => { throw new files.StoreError("skills requires the live gateway"); },
    addSkill: async () => { throw new files.StoreError("skills requires the live gateway"); },
    removeSkill: async () => { throw new files.StoreError("skills requires the live gateway"); },
  };
}
