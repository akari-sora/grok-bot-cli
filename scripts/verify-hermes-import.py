"""Hermes contracts for gbot's migration. Usage: verify-hermes-import.py [helper|official] (default: both).

helper    Offline. gbot's own import path: applyHermes/verifyHermes run the real helper ops
          (preflight, memory-add, import-history, readback) through `hermes --print-runtime-command`,
          against a fake Hermes CLI and runtime that expose the store APIs the helper calls
          (MemoryStore, SessionDB, cron.jobs, skills_tool, hermes_time, default_soul). It proves the
          calls, arguments and JSON contract, not the behaviour of the real stores.
official  Downloads the official Hermes grok-bot importer, pinned by commit and Git blob IDs, and runs
          it on the grok-bot-export.json gbot bundles in the profile workspace. gbot itself does not
          use that importer; this only shows the bundled export is accepted by it.

No installed Hermes account or runtime is touched. A failed check exits non-zero; nothing is skipped.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import types
import urllib.request

REVISION = "13b2c1c9c8204bf333df240b2aacf98c3e6250b7"
BLOBS = {
    "importer.py": "0e819b0a69649bc67490718b212a4a82c0f86884",
    "grok_bot.py": "195d0ceca1cdebc79343dcf0f0163bb83f417716",
    "grok_bot_cache.py": "aba1de471399e5cb557f52e39ff66a8b29f28bac",
}
ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "scripts/migration-hermes-fixture.mjs"

# A fake Hermes runtime: the module and function names gbot's helper imports, with the same
# signatures, storing everything as JSON under HERMES_HOME.
FAKE_RUNTIME = {
    "hermes_bootstrap.py": "",
    "hermes_cli/__init__.py": "__version__ = '0.0.0-contract'\n",
    "hermes_cli/default_soul.py": '''
        DEFAULT_SOUL_MD = "You are Hermes Agent (contract runtime). Be direct."
        _LEGACY_TEMPLATE_SOULS = ()
        def _normalize_soul(text):
            return text.replace("\\r\\n", "\\n").replace("\\r", "\\n").lstrip("\\ufeff").strip()
    ''',
    "fake_home.py": '''
        import json, os
        from pathlib import Path
        def home():
            return Path(os.environ["HERMES_HOME"])
        def config():
            f = home() / "config.yaml"
            return json.loads(f.read_text()) if f.exists() else {}
    ''',
    "tools/__init__.py": "",
    "tools/memory_tool_store.py": '''
        from fake_home import home
        ENTRY_DELIMITER = "\\n§\\n"
        class MemoryStore:
            def __init__(self, memory_char_limit=2200, user_char_limit=1375, *, memory_enabled=True, user_profile_enabled=True):
                self.memory_entries, self.user_entries = [], []
                self.memory_char_limit, self.user_char_limit = memory_char_limit, user_char_limit
            def _file(self, target):
                return home() / "memories" / ("USER.md" if target == "user" else "MEMORY.md")
            def _read(self, target):
                f = self._file(target)
                return [e for e in f.read_text(encoding="utf-8").split(ENTRY_DELIMITER) if e] if f.exists() else []
            def load_from_disk(self):
                self.memory_entries, self.user_entries = self._read("memory"), self._read("user")
            def add(self, target, content):
                entries = self.user_entries if target == "user" else self.memory_entries
                limit = self.user_char_limit if target == "user" else self.memory_char_limit
                if len(ENTRY_DELIMITER.join(entries + [content])) > limit:
                    return {"success": False, "error": f"would exceed {limit} chars"}
                entries.append(content)
                self._file(target).parent.mkdir(exist_ok=True)
                self._file(target).write_text(ENTRY_DELIMITER.join(entries), encoding="utf-8")
                return {"success": True}
            def format_for_system_prompt(self, target):
                return ENTRY_DELIMITER.join(self.user_entries if target == "user" else self.memory_entries)
    ''',
    "tools/memory_tool.py": '''
        from fake_home import config
        from tools.memory_tool_store import MemoryStore
        def load_on_disk_store():
            mem = config().get("memory", {})
            store = MemoryStore(int(mem.get("memory_char_limit", 2200)), int(mem.get("user_char_limit", 1375)))
            store.load_from_disk()
            return store
    ''',
    "tools/skills_tool.py": '''
        import json, re
        from fake_home import home
        def skills_list(category=None, task_id=None):
            found = []
            for f in sorted((home() / "skills").rglob("SKILL.md")):
                m = re.search(r"^name:\\s*(.+)$", f.read_text(encoding="utf-8"), re.M)
                found.append({"name": m.group(1).strip() if m else f.parent.name})
            return json.dumps({"success": True, "skills": found})
    ''',
    "hermes_time.py": '''
        from fake_home import config
        def get_timezone_name():
            return str(config().get("timezone", ""))
    ''',
    "cron/__init__.py": "",
    "cron/jobs.py": '''
        import contextlib, json
        from pathlib import Path
        _store = [None]
        @contextlib.contextmanager
        def use_cron_store(home):
            _store[0] = Path(home) / "cron"
            try:
                yield
            finally:
                _store[0] = None
        def load_jobs():
            f = _store[0] / "jobs.json"
            return json.loads(f.read_text()) if f.exists() else []
        def effective_job_state(job):
            return "paused" if not job.get("enabled", True) else (job.get("state") or "scheduled")
    ''',
    "hermes_state.py": '''
        import json, uuid
        from fake_home import home
        class SessionDB:
            _IMPORT_MAX_MESSAGES_PER_SESSION, _IMPORT_MAX_SESSION_BYTES = 10_000, 5 * 1024 * 1024
            def __init__(self):
                self._file = home() / "state.json"
                self._data = json.loads(self._file.read_text()) if self._file.exists() else {"sessions": {}}
            def find_foreign_import(self, origin):
                for sid, s in self._data["sessions"].items():
                    if s["origin"]["foreign_session_id"] == origin.get("foreign_session_id"):
                        return sid
                return None
            def import_foreign_history(self, origin, messages, *, title, cwd, profile):
                existing = self.find_foreign_import(origin)
                if existing:
                    return {"session_id": existing, "already_imported": True}
                sid = uuid.uuid4().hex[:12]
                self._data["sessions"][sid] = {"origin": origin, "title": title, "cwd": cwd, "profile": profile,
                                               "messages": [{"role": m["role"], "content": m["content"]} for m in messages]}
                self._file.write_text(json.dumps(self._data, ensure_ascii=False), encoding="utf-8")
                return {"session_id": sid, "already_imported": False}
            def get_messages(self, session_id):
                return list(self._data["sessions"][session_id]["messages"])
            def close(self):
                pass
    ''',
}

# A fake `hermes` CLI with the subcommands gbot runs. Profiles live under ./home next to it.
FAKE_CLI = '''#!/usr/bin/env python3
import json, sys, uuid
from pathlib import Path
BASE = Path(__file__).resolve().parent
ROOT, RUNTIME = BASE / "home", BASE / "runtime"
sys.path.insert(0, str(RUNTIME))
from hermes_cli.default_soul import DEFAULT_SOUL_MD
args = sys.argv[1:]
def home(name):
    return ROOT if name == "default" else ROOT / "profiles" / name
def load(d):
    f = d / "config.yaml"
    return json.loads(f.read_text()) if f.exists() else {}
if args == ["--version"]:
    print("Hermes Agent v0.0.0-contract")
elif args == ["--print-runtime-command"]:
    boot = ("import os, sys, runpy; sys.path.insert(0, %r); import hermes_bootstrap; "
            "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)") % str(RUNTIME)
    print(json.dumps([sys.executable, "-I", "-c", boot]))
elif args == ["profile", "list"]:
    print("\\n".join(["default", *sorted(p.name for p in (ROOT / "profiles").glob("*"))]))
elif args[:2] == ["profile", "create"]:
    d = home(args[2])
    d.mkdir(parents=True)
    (d / "SOUL.md").write_text(DEFAULT_SOUL_MD, encoding="utf-8")
elif args[:1] == ["-p"] and args[2:4] == ["config", "path"]:
    print(home(args[1]) / "config.yaml")
elif args[:1] == ["-p"] and args[2:4] == ["config", "set"]:
    d = home(args[1])
    config, keys = load(d), args[4].split(".")
    node = config
    for k in keys[:-1]:
        node = node.setdefault(k, {})
    node[keys[-1]] = args[5]
    (d / "config.yaml").write_text(json.dumps(config))
elif args[:1] == ["-p"] and args[2:4] == ["cron", "create"]:
    rest, opts = args[4:], {}
    while rest and rest[0].startswith("--"):
        flag = rest.pop(0)
        opts[flag] = True if flag == "--paused" else rest.pop(0)
    schedule, prompt = rest
    jobs_file = home(args[1]) / "cron" / "jobs.json"
    jobs_file.parent.mkdir(exist_ok=True)
    jobs = json.loads(jobs_file.read_text()) if jobs_file.exists() else []
    paused = bool(opts.get("--paused"))
    jobs.append({"id": uuid.uuid4().hex[:12], "name": opts["--name"], "prompt": prompt, "workdir": opts.get("--workdir"),
                 "schedule": {"kind": "cron", "expr": schedule}, "enabled": not paused, "state": "paused" if paused else "scheduled"})
    jobs_file.write_text(json.dumps(jobs, ensure_ascii=False), encoding="utf-8")
else:
    sys.exit("fake hermes: unsupported " + " ".join(args))
'''


def bytes_under(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def helper_contract() -> None:
    with tempfile.TemporaryDirectory(prefix="gbot-hermes-helper-") as directory:
        temp = Path(directory)
        fake = temp / "hermes"
        for rel, text in FAKE_RUNTIME.items():
            path = fake / "runtime" / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(textwrap.dedent(text).lstrip(), encoding="utf-8")
        (fake / "home").mkdir()
        cli = fake / "hermes"
        cli.write_text(FAKE_CLI, encoding="utf-8")
        cli.chmod(0o755)
        (temp / "fixture").mkdir()
        run = subprocess.run(["node", str(FIXTURE), str(temp / "fixture"), "--hermes", str(cli)],
                             capture_output=True, text=True, encoding="utf-8", timeout=180)
        assert run.returncode == 0, run.stderr[-2000:]
        result = json.loads(run.stdout)
        first, second = result["first"], result["second"]
        steps = lambda r: {s["step"]: s for s in r["steps"]}  # noqa: E731

        failed = [c for c in first["verify"]["checks"] if not c["ok"]]
        assert first["verify"]["ok"], failed
        one = steps(first)
        assert one["profile"]["status"] == "created" and one["soul"]["status"] == "written"
        assert one["memory"]["added"] > 0 and not one["memory"]["refused"]
        assert one["cron"]["created"] == 1
        assert [s["already_imported"] for s in one["history"]["sessions"]] == [False] * first["sessions"] and first["sessions"] == 2
        print("PASS gbot helper path: preflight, profile, SOUL, memory, skills, files, paused cron and two sessions; read back equal")

        two = steps(second)
        assert second["verify"]["ok"], [c for c in second["verify"]["checks"] if not c["ok"]]
        assert two["profile"]["status"] == "exists" and two["soul"]["status"] == "present"
        assert two["memory"]["added"] == 0 and two["cron"]["created"] == 0 and two["files"]["written"] == 0
        assert all(s["already_imported"] for s in two["history"]["sessions"])
        print("PASS gbot helper path: a second import changes nothing")

        profile = Path(first["profileDir"])
        jobs = json.loads((profile / "cron" / "jobs.json").read_text())
        assert len(jobs) == 1 and jobs[0]["state"] == "paused" and jobs[0]["name"].endswith("[grok-bot a1]")
        assert "[redacted]" in (profile / "memories" / "MEMORY.md").read_text(encoding="utf-8")
        leaked = [p for p, b in bytes_under(fake / "home").items() if b"ghp_" in b]
        assert not leaked, f"token reached the profile: {leaked}"
        print("PASS gbot helper path: job tagged with its routine id and paused; the token is redacted everywhere")


def official_contract() -> None:
    with tempfile.TemporaryDirectory(prefix="gbot-hermes-contract-") as directory:
        temp = Path(directory)
        (temp / "fixture").mkdir()
        generated = subprocess.run(["node", str(FIXTURE), str(temp / "fixture")],
                                   check=True, capture_output=True, text=True, encoding="utf-8", timeout=60).stdout
        sources = temp / "official"
        sources.mkdir()
        for name, expected_blob in BLOBS.items():
            url = f"https://raw.githubusercontent.com/NousResearch/hermes-official-plugins/{REVISION}/agent-importers/{name}"
            with urllib.request.urlopen(url, timeout=30) as response:
                data = response.read(512_001)
            assert len(data) <= 512_000, "Upstream file exceeds budget"
            blob = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
            assert blob == expected_blob, f"Pinned upstream blob mismatch: {name}"
            (sources / name).write_bytes(data)
        package = types.ModuleType("gbot_hermes_contract")
        package.__path__ = [str(sources)]
        sys.modules[package.__name__] = package
        for name in BLOBS:
            module_name = package.__name__ + "." + name.removesuffix(".py")
            spec = importlib.util.spec_from_file_location(module_name, sources / name)
            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            spec.loader.exec_module(module)
        importer = sys.modules[package.__name__ + ".grok_bot"]

        # 1. The official parser accepts the bundled export, field for field.
        source = json.loads(generated)["bots"][0]
        parsed = importer.parse_export(generated)
        assert len(parsed) == 1
        bot = parsed[0]
        assert bot["instructions"] == source["instructions"]
        assert bot["memories"] == source["memories"] and bot["user_facts"] == source["user_facts"]
        assert [s["name"] for s in bot["skills"]] == ["ci-fixer", "same-name"]
        assert {r["name"]: r["schedule_cron"] for r in bot["routines"]} == {"Hourly scan": "52 9-21 * * 1-5", "On PR": ""}
        print("PASS official parser on the bundled export: role, memories, user facts, skill folders and routines accepted")

        # 2. The official importer applies it (routines need Hermes' cron module, so they are left out here;
        #    gbot creates them with `hermes cron create --paused`, covered by the helper contract).
        without_routines = json.loads(generated)
        without_routines["bots"][0]["routines"] = []
        export = temp / "grok-bot-export.json"
        export.write_text(json.dumps(without_routines), encoding="utf-8")
        home = temp / "home"
        home.mkdir()
        previous = {key: os.environ.get(key) for key in ("HOME", "USERPROFILE", "HERMES_HOME")}
        target = temp / "target"
        os.environ.update(HOME=str(home), USERPROFILE=str(home), HERMES_HOME=str(target))
        try:
            importer.GrokBotImporter([export], target, execute=False).run()
            assert not target.exists(), "Upstream dry-run wrote target files"
            print("PASS official importer on the bundled export: dry-run writes nothing")
            target.mkdir()  # a Hermes profile directory always exists before an import
            importer.GrokBotImporter([export], target, execute=True).run()
            soul = (target / "SOUL.md").read_text(encoding="utf-8")
            assert source["instructions"] in soul
            memory = (target / "memories" / "MEMORY.md").read_text(encoding="utf-8")
            user = (target / "memories" / "USER.md").read_text(encoding="utf-8")
            assert all(m in memory for m in source["memories"]) and all(u in user for u in source["user_facts"])
            skill = target / "skills" / "grok-bot-imports" / "ci-fixer"
            assert (skill / "SKILL.md").is_file() and (skill / "run.sh").read_text() == "#!/bin/sh\necho fix\n"
            print("PASS official importer on the bundled export: role, memories, user facts and whole skill folders written")
            before = bytes_under(target)
            importer.GrokBotImporter([export], target, execute=True).run()
            assert bytes_under(target) == before, "Repeated import changed files"
            print("PASS official importer on the bundled export: repeated import changes nothing")
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
    print(f"PASS official importer contract (bundled export only): 4 checks; upstream={REVISION}")


if __name__ == "__main__":
    which = sys.argv[1:] or ["helper", "official"]
    unknown = set(which) - {"helper", "official"}
    if unknown:
        sys.exit("usage: verify-hermes-import.py [helper|official]")
    if "helper" in which:
        helper_contract()
    if "official" in which:
        official_contract()
