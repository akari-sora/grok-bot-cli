/**
 * Python run inside the installed Hermes runtime (from `hermes --print-runtime-command`), with
 * HERMES_HOME set to the target profile. It uses Hermes' own stores so their format, threat scan
 * and limits apply: MemoryStore for MEMORY.md / USER.md, SessionDB.import_foreign_history for the
 * conversation (idempotent by origin), cron.jobs and tools.skills_tool for read-back.
 * Input: one JSON object on stdin. Output: one JSON object on stdout.
 */
export const HERMES_HELPER = String.raw`
import json, os, sys

def out(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False))
    sys.stdout.flush()

req = json.loads(sys.stdin.read())
op = req.get("op")
home = os.environ.get("HERMES_HOME", "")
if not home or not os.path.isdir(home):
    out({"ok": False, "error": "HERMES_HOME is not a profile directory"}); sys.exit(0)

def memory_store():
    from tools.memory_tool_store import MemoryStore
    store = MemoryStore(int(req.get("memory_char_limit") or 2200), int(req.get("user_char_limit") or 1375))
    store.load_from_disk()
    return store

if op == "memory-add":
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
    result["memory_prompt"] = store.format_for_system_prompt("memory") or ""
    result["user_prompt"] = store.format_for_system_prompt("user") or ""
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
                msgs = db.get_messages(sid) if hasattr(db, "get_messages") else []
                sessions.append({"foreign_id": fid, "session_id": sid, "messages": len(msgs),
                                 "first": (msgs[0].get("content") if msgs else None), "last": (msgs[-1].get("content") if msgs else None)})
            else:
                sessions.append({"foreign_id": fid, "session_id": None, "messages": 0})
        result["sessions"] = sessions
    finally:
        db.close()
    out(result)

else:
    out({"ok": False, "error": "unknown op"})
`;
