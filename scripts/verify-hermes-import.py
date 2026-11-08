"""Run the pinned official Hermes importer against the grok-bot-export.json gbot writes.

Only the test downloads code. Product migration remains offline. Pins are checked as
Git blob IDs before importing. No installed Hermes account/runtime is touched.
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
import types
import urllib.request

REVISION = "13b2c1c9c8204bf333df240b2aacf98c3e6250b7"
BLOBS = {
    "importer.py": "0e819b0a69649bc67490718b212a4a82c0f86884",
    "grok_bot.py": "195d0ceca1cdebc79343dcf0f0163bb83f417716",
    "grok_bot_cache.py": "aba1de471399e5cb557f52e39ff66a8b29f28bac",
}
ROOT = Path(__file__).resolve().parent.parent


def bytes_under(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="gbot-hermes-contract-") as directory:
        temp = Path(directory)
        (temp / "fixture").mkdir()
        generated = subprocess.run(["node", str(ROOT / "scripts/migration-hermes-fixture.mjs"), str(temp / "fixture")],
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

        # 1. The official parser accepts the export gbot writes, field for field.
        source = json.loads(generated)["bots"][0]
        parsed = importer.parse_export(generated)
        assert len(parsed) == 1
        bot = parsed[0]
        assert bot["instructions"] == source["instructions"]
        assert bot["memories"] == source["memories"] and bot["user_facts"] == source["user_facts"]
        assert [s["name"] for s in bot["skills"]] == ["ci-fixer", "same-name"]
        assert {r["name"]: r["schedule_cron"] for r in bot["routines"]} == {"Hourly scan": "52 9-21 * * 1-5", "On PR": ""}
        print("PASS official parser: role, memories, user facts, skill folders and routines accepted")

        # 2. The official importer applies it (routines need Hermes' cron module, so they are left out here;
        #    gbot creates them with `hermes cron create --paused` instead).
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
            print("PASS official importer: dry-run writes nothing")
            target.mkdir()  # a Hermes profile directory always exists before an import
            importer.GrokBotImporter([export], target, execute=True).run()
            soul = (target / "SOUL.md").read_text(encoding="utf-8")
            assert source["instructions"] in soul
            memory = (target / "memories" / "MEMORY.md").read_text(encoding="utf-8")
            user = (target / "memories" / "USER.md").read_text(encoding="utf-8")
            assert all(m in memory for m in source["memories"]) and all(u in user for u in source["user_facts"])
            skill = target / "skills" / "grok-bot-imports" / "ci-fixer"
            assert (skill / "SKILL.md").is_file() and (skill / "run.sh").read_text() == "#!/bin/sh\necho fix\n"
            print("PASS official importer: role, memories, user facts and whole skill folders written")
            before = bytes_under(target)
            importer.GrokBotImporter([export], target, execute=True).run()
            assert bytes_under(target) == before, "Repeated import changed files"
            print("PASS official importer: repeated import changes nothing")
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
    print(f"PASS Hermes importer contract: 4 checks; upstream={REVISION}; no live account/runtime")


if __name__ == "__main__":
    main()
