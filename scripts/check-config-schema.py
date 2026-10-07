#!/usr/bin/env python3
"""Check generated shape projection independently of Rust semantic validation."""
import json
from pathlib import Path
import subprocess

from jsonschema import Draft202012Validator


def main():
    root = Path(__file__).resolve().parent.parent
    schema = json.loads((root / "packages/config-compiler/generated/hack.project.schema.json").read_text())
    corpus = json.loads((root / "packages/config-compiler/tests/fixtures/schema-corpus.json").read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    compiler = root / "dist/hack-config-compiler"
    for case in corpus:
        actual = validator.is_valid(case["input"])
        if actual != case["valid"]:
            raise RuntimeError("Schema corpus mismatch: " + case["name"])
        result = subprocess.run([str(compiler), "compile"],
                                input=json.dumps(case["input"]).encode(),
                                capture_output=True, timeout=10, check=False,
                                env={"PATH": "/usr/bin:/bin"})
        envelope = json.loads(result.stdout)
        if (result.returncode != (0 if case["valid"] else 1)
                or envelope.get("ok") != case["valid"]
                or envelope.get("transport_version") != 1):
            raise RuntimeError("Compiler corpus mismatch: " + case["name"])
    print("Independent JSON Schema / Rust shape corpus: " + str(len(corpus)) + " cases passed")


if __name__ == "__main__":
    main()
