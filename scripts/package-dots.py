#!/usr/bin/env python3
"""Package only the reviewed skill files; never include runtime/user state."""
from pathlib import Path
import json
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
source = root / "plugins/douyin-dots"
files = ["plugin.json", "skills/douyin-direct/SKILL.md", "skills/douyin-direct/references.md",
         "skills/douyin-direct/agents/openai.yaml", "skills/douyin-direct/scripts/state.py"]
version = json.loads((source / "plugin.json").read_text())["version"]
target = root / "dist" / f"douyin-dots-{version}.zip"
target.parent.mkdir(exist_ok=True)
with ZipFile(target, "w", compression=ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(source / name, name)
    archive.write(root / "LICENSE", "LICENSE")
print(target)
