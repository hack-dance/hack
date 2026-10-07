#!/usr/bin/env python3
"""Check generated shape projection independently of Rust semantic validation."""
import json
from pathlib import Path
import subprocess

from jsonschema import Draft202012Validator


def check_corpus(root, document):
    schema = json.loads((root / f"packages/config-compiler/generated/hack.{document}.schema.json").read_text())
    corpus_name = "schema-corpus.json" if document == "project" else "local-schema-corpus.json"
    corpus = json.loads((root / "packages/config-compiler/tests/fixtures" / corpus_name).read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    compiler = root / "dist/hack-config-compiler"
    for case in corpus:
        actual = validator.is_valid(case["input"])
        if actual != case["valid"]:
            raise RuntimeError(f"{document} schema corpus mismatch: " + case["name"])
        command = "compile" if document == "project" else "resolve"
        request = case["input"] if document == "project" else {
            "request_version": 1,
            "project": '{"schema_version":1,"name":"corpus"}',
            "checkout_local": json.dumps(case["input"]),
        }
        result = subprocess.run([str(compiler), command],
                                input=json.dumps(request).encode(),
                                capture_output=True, timeout=10, check=False,
                                env={"PATH": "/usr/bin:/bin"})
        envelope = json.loads(result.stdout)
        if (result.returncode != (0 if case["valid"] else 1)
                or envelope.get("ok") != case["valid"]
                or envelope.get("transport_version") != 1):
            raise RuntimeError(f"{document} compiler corpus mismatch: " + case["name"])
    return len(corpus)


def main():
    root = Path(__file__).resolve().parent.parent
    project_count = check_corpus(root, "project")
    local_count = check_corpus(root, "local")
    print(f"Independent JSON Schema / Rust shape corpus: {project_count} project + {local_count} local cases passed")


if __name__ == "__main__":
    main()
