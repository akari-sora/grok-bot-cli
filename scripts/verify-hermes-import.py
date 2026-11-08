"""Run the actual pinned official Hermes importer against generated synthetic data.

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
    generated = subprocess.run(["node", str(ROOT / "scripts/migration-hermes-fixture.mjs")],
                               check=True, capture_output=True, text=True, encoding="utf-8", timeout=20).stdout
    expected = json.loads(generated)["bots"][0]["skills"]
    assert len(expected) == 4
    with tempfile.TemporaryDirectory(prefix="gbot-hermes-contract-") as directory:
        temp = Path(directory)
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
        parsed = importer.parse_export(generated)
        assert len(parsed) == 1 and parsed[0]["instructions"] == ""
        assert len(parsed[0]["skills"]) == 4
        assert len({s["name"] for s in parsed[0]["skills"]}) == 4
        for field in ("memories", "user_facts", "routines", "apps"):
            assert parsed[0][field] == []
        print("PASS official parser: single-agent role/skill bundle, distinct IDs, no invented state")
        export = temp / "grok-bot-export.json"
        export.write_text(generated, encoding="utf-8")
        home = temp / "home"
        home.mkdir()
        previous = {key: os.environ.get(key) for key in ("HOME", "USERPROFILE", "HERMES_HOME")}
        os.environ.update(HOME=str(home), USERPROFILE=str(home), HERMES_HOME=str(temp / "target"))
        try:
            target = temp / "target"
            importer.GrokBotImporter([export], target, execute=False).run()
            assert not target.exists(), "Upstream dry-run wrote target files"
            print("PASS official importer: dry-run writes nothing")
            target.mkdir()
            (target / "memories").mkdir()
            protected = {"SOUL.md": b"Existing host persona\n", "config.yaml": b"operator-owned: unchanged\n",
                         "memories/MEMORY.md": b"Existing facts\n", "memories/USER.md": b"Existing user preferences\n"}
            for path, data in protected.items():
                (target / path).write_bytes(data)
            importer.GrokBotImporter([export], target, execute=True).run()
            skills = list((target / "skills" / "grok-bot-imports").glob("*/SKILL.md"))
            assert len(skills) == 4, "Upstream did not create every role/workflow skill"
            for skill in expected:
                installed = target / "skills" / "grok-bot-imports" / skill["name"] / "SKILL.md"
                assert skill["instructions"].strip() in installed.read_text(encoding="utf-8")
            for path, data in protected.items():
                assert (target / path).read_bytes() == data, f"Changed host state: {path}"
            print("PASS official importer: four skills written; persona, config and memory preserved")
            before = bytes_under(target)
            importer.GrokBotImporter([export], target, execute=True).run()
            assert bytes_under(target) == before, "Repeated import overwrote or duplicated user files"
            print("PASS official importer: repeated import preserves all existing bytes")
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
    print(f"PASS Hermes importer contract: 4 checks; upstream={REVISION}; no live account/runtime")


if __name__ == "__main__":
    main()
