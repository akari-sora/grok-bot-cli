/**
 * Python run inside the installed Hermes runtime (from `hermes --print-runtime-command`), with
 * HERMES_HOME set to the target profile. It uses Hermes' own stores so their format, threat scan
 * and limits apply: MemoryStore for MEMORY.md / USER.md, SessionDB.import_foreign_history for the
 * conversations (idempotent by foreign session id), cron.jobs and tools.skills_tool for read-back.
 * `preflight` imports every one of them and reports versions before anything is changed.
 * Input: one JSON object on stdin. Output: one JSON object on stdout; exit code 0.
 */
export const HERMES_HELPER = String.raw`
import hashlib, importlib, json, os, sys

def out(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False))
    sys.stdout.flush()

req = json.loads(sys.stdin.read())
op = req.get("op")
home = os.environ.get("HERMES_HOME", "")
if not home or not os.path.isdir(home):
    out({"ok": False, "error": "HERMES_HOME is not a profile directory"}); sys.exit(0)

NEEDED = (
    ("tools.memory_tool_store", ("MemoryStore",)),
    ("tools.memory_tool", ("load_on_disk_store",)),
    ("hermes_state", ("SessionDB",)),
    ("cron.jobs", ("use_cron_store", "load_jobs", "effective_job_state")),
    ("tools.skills_tool", ("skills_list",)),
    ("hermes_time", ("get_timezone_name",)),
    ("hermes_cli.default_soul", ("DEFAULT_SOUL_MD", "_normalize_soul")),
)

def memory_store():
    # The profile's configured limits and flags, as the agent loads them; the request may raise the limits.
    from tools.memory_tool import load_on_disk_store
    store = load_on_disk_store()
    if req.get("memory_char_limit"): store.memory_char_limit = int(req["memory_char_limit"])
    if req.get("user_char_limit"): store.user_char_limit = int(req["user_char_limit"])
    return store

def history_digest(messages):
    # Same as historyDigest() in migration-hermes.js: role, UTF-8 byte length and text of each message.
    h = hashlib.sha256()
    for m in messages:
        content = m.get("content")
        content = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        data = content.encode("utf-8", "replace")
        h.update(f"{m.get('role')}\n{len(data)}\n".encode("utf-8") + data + b"\n")
    return h.hexdigest()

if op == "preflight":
    missing = []
    for module, names in NEEDED:
        try:
            mod = importlib.import_module(module)
        except Exception as e:
            missing.append(f"{module} ({type(e).__name__})"); continue
        missing += [f"{module}.{n}" for n in names if not hasattr(mod, n)]
    if not missing:
        from hermes_state import SessionDB
        missing += [f"hermes_state.SessionDB.{n}" for n in ("import_foreign_history", "find_foreign_import", "get_messages", "close") if not hasattr(SessionDB, n)]
    if missing:
        out({"ok": False, "error": "this Hermes lacks " + ", ".join(missing) + "; update Hermes or gbot"}); sys.exit(0)
    import hermes_cli
    from hermes_cli import default_soul
    from hermes_state import SessionDB
    souls = (default_soul.DEFAULT_SOUL_MD, *getattr(default_soul, "_LEGACY_TEMPLATE_SOULS", ()))
    out({"ok": True, "versions": {"hermes": str(getattr(hermes_cli, "__version__", "")), "python": sys.version.split()[0]},
         "default_souls": [default_soul._normalize_soul(s) for s in souls],
         "import_limits": {"session_messages": getattr(SessionDB, "_IMPORT_MAX_MESSAGES_PER_SESSION", None),
                           "session_bytes": getattr(SessionDB, "_IMPORT_MAX_SESSION_BYTES", None)}})

elif op == "memory-add":
    store = memory_store()
    results = []
    for item in req["entries"]:
        target, content = item["target"], item["content"]
        current = store.user_entries if target == "user" else store.memory_entries
        if content in current:
            results.append({"target": target, "content": content, "status": "present"}); continue
        r = store.add(target, content)
        results.append({"target": target, "content": content, "status": "added" if r.get("success") else "refused",
                        "error": None if r.get("success") else str(r.get("error"))[:300]})
    out({"ok": True, "results": results})

elif op == "import-history":
    from hermes_state import SessionDB
    db = SessionDB()
    try:
        results = []
        for s in req["sessions"]:
            origin = {"tool": "grok-bot", "path": s["path"], "foreign_session_id": s["foreign_id"]}
            r = db.import_foreign_history(origin, s["messages"], title=s["title"], cwd=s.get("cwd"), profile=req.get("profile"))
            results.append({"foreign_id": s["foreign_id"], **r})
        out({"ok": True, "results": results})
    finally:
        db.close()

elif op == "readback":
    result = {"ok": True}
    store = memory_store()
    result["memory"] = list(store.memory_entries)
    result["user"] = list(store.user_entries)
    result["limits"] = {"memory": store.memory_char_limit, "user": store.user_char_limit}
    result["memory_prompt"] = store.format_for_system_prompt("memory") or ""
    result["user_prompt"] = store.format_for_system_prompt("user") or ""
    from hermes_time import get_timezone_name
    result["timezone"] = get_timezone_name()
    from cron import jobs as cron_jobs
    with cron_jobs.use_cron_store(home):
        result["cron"] = [{"id": j.get("id"), "name": j.get("name"), "schedule": j.get("schedule"),
                           "enabled": j.get("enabled", True), "state": cron_jobs.effective_job_state(j),
                           "prompt": j.get("prompt"), "workdir": j.get("workdir")} for j in cron_jobs.load_jobs()]
    from tools.skills_tool import skills_list
    listed = json.loads(skills_list())
    result["skills"] = [s.get("name") for s in (listed.get("skills") or [])]
    from hermes_state import SessionDB
    db = SessionDB()
    try:
        sessions = []
        for fid in req.get("foreign_ids", []):
            sid = db.find_foreign_import({"tool": "grok-bot", "path": req.get("history_path", ""), "foreign_session_id": fid})
            if sid:
                msgs = db.get_messages(sid)
                sessions.append({"foreign_id": fid, "session_id": sid, "messages": len(msgs), "digest": history_digest(msgs)})
            else:
                sessions.append({"foreign_id": fid, "session_id": None, "messages": 0})
        result["sessions"] = sessions
        if req.get("grok_sessions"):
            # Every session imported from Grok Bot (any bot), by foreign id, for the preview. This is the
            # query SessionDB's own foreign-import lookup runs; without it the preview says "not checked".
            rows = db._read_rows("SELECT id, origin_json FROM sessions WHERE source = ? AND origin_json IS NOT NULL", ("grok-bot",)) if hasattr(db, "_read_rows") else None
            found = None if rows is None else []
            for row in rows or []:
                fid = ((json.loads(row["origin_json"] or "{}") or {}).get("imported_from") or {}).get("foreign_session_id")
                if fid:
                    msgs = db.get_messages(row["id"])
                    found.append({"foreign_id": fid, "messages": len(msgs), "digest": history_digest(msgs)})
            result["grok_sessions"] = found
    finally:
        db.close()
    out(result)

else:
    out({"ok": False, "error": "unknown op"})
`;
