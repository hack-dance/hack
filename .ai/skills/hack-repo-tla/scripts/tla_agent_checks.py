#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


JAVA_TOOL = "java@temurin-17.0.20+101"
APALACHE_JAVA_TOOL = "java@temurin-21.0.12+101.0.LTS"
TLA_VERSION = "1.7.4"
APALACHE_VERSION = "0.62.2"
TLA_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
APALACHE_SHA256 = "95746f11062b2dea716052c8f03258496a194afc4e9dd29e985f488ea3e90b76"
TLA_JAR_URL = f"https://github.com/tlaplus/tlaplus/releases/download/v{TLA_VERSION}/tla2tools.jar"
APALACHE_TGZ_URL = (
    f"https://github.com/apalache-mc/apalache/releases/download/v{APALACHE_VERSION}/apalache.tgz"
)
VALID_TEMPLATES = (
    "agent-loop",
    "tool-call-orchestrator",
    "queue-worker",
    "approval-workflow",
    "retry-backoff",
)
FIELD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
MODULE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


@dataclass
class ToolPaths:
    skill_dir: Path
    home_dir: Path
    downloads_dir: Path
    tools_dir: Path
    bin_dir: Path
    tla_jar: Path
    apalache_dir: Path
    apalache_bin: Path
    templates_dir: Path


def skill_dir() -> Path:
    return Path(__file__).resolve().parent.parent


def tool_paths() -> ToolPaths:
    base = Path(os.environ.get("TLA_AGENT_CHECKS_HOME", skill_dir() / ".local")).expanduser()
    return ToolPaths(
        skill_dir=skill_dir(),
        home_dir=base,
        downloads_dir=base / "downloads",
        tools_dir=base / "tools",
        bin_dir=base / "bin",
        tla_jar=base / "tools" / f"tla2tools-{TLA_VERSION}.jar",
        apalache_dir=base / "tools" / f"apalache-{APALACHE_VERSION}",
        apalache_bin=base / "tools" / f"apalache-{APALACHE_VERSION}" / "bin" / "apalache-mc",
        templates_dir=skill_dir() / "references" / "templates",
    )


def parser_common(description: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--dry-run", action="store_true", help="Print actions without mutating state")
    return parser


def print_cmd(cmd: Iterable[str]) -> None:
    print("$ " + " ".join(str(part) for part in cmd))


def run(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    capture_output: bool = False,
    dry_run: bool = False,
) -> subprocess.CompletedProcess[str]:
    print_cmd(cmd)
    if dry_run:
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=capture_output,
        check=False,
    )


def require_command(name: str) -> None:
    if shutil.which(name):
        return
    raise SystemExit(f"required command not found on PATH: {name}")


def ensure_dirs(paths: ToolPaths) -> None:
    paths.home_dir.mkdir(parents=True, exist_ok=True)
    paths.downloads_dir.mkdir(parents=True, exist_ok=True)
    paths.tools_dir.mkdir(parents=True, exist_ok=True)
    paths.bin_dir.mkdir(parents=True, exist_ok=True)


def ensure_java(*, dry_run: bool = False, tool: str = JAVA_TOOL) -> None:
    require_command("mise")
    use_result = run(["mise", "install", tool], dry_run=dry_run)
    if use_result.returncode != 0:
        raise SystemExit(use_result.returncode)
    check_result = run(["mise", "exec", tool, "--", "java", "-version"], dry_run=dry_run)
    if check_result.returncode != 0:
        raise SystemExit(check_result.returncode)


def download_file(url: str, destination: Path, *, dry_run: bool = False) -> Path:
    print(f"Downloading {url} -> {destination}")
    if dry_run:
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url) as response:
        with tempfile.NamedTemporaryFile(delete=False, dir=str(destination.parent)) as tmp:
            tmp.write(response.read())
            temp_path = Path(tmp.name)
    temp_path.replace(destination)
    return destination


def discover_apalache_root(extract_dir: Path) -> Path:
    direct = extract_dir / "apalache"
    if (direct / "bin" / "apalache-mc").exists():
        return direct
    for candidate in extract_dir.rglob("apalache-mc"):
        if candidate.name == "apalache-mc" and candidate.parent.name == "bin":
            return candidate.parent.parent
    raise SystemExit(f"could not find extracted Apalache binary under {extract_dir}")


def verify_checksum(path: Path, expected: str) -> None:
    with path.open("rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if actual != expected:
        raise SystemExit(f"SHA256 mismatch for {path}; refusing to use artifact")


def ensure_tla_jar(paths: ToolPaths, *, dry_run: bool = False) -> Path:
    if paths.tla_jar.exists():
        verify_checksum(paths.tla_jar, TLA_SHA256)
        return paths.tla_jar
    archive_path = paths.downloads_dir / f"tla2tools-{TLA_VERSION}.jar"
    download_file(TLA_JAR_URL, archive_path, dry_run=dry_run)
    if dry_run:
        return paths.tla_jar
    verify_checksum(archive_path, TLA_SHA256)
    shutil.copy2(archive_path, paths.tla_jar)
    return paths.tla_jar


def ensure_apalache(paths: ToolPaths, *, dry_run: bool = False) -> Path:
    if paths.apalache_bin.exists():
        return paths.apalache_bin
    archive_path = paths.downloads_dir / f"apalache-{APALACHE_VERSION}.tgz"
    download_file(APALACHE_TGZ_URL, archive_path, dry_run=dry_run)
    if dry_run:
        return paths.apalache_bin
    verify_checksum(archive_path, APALACHE_SHA256)
    extract_parent = paths.tools_dir / f"apalache-{APALACHE_VERSION}-extract"
    if extract_parent.exists():
        shutil.rmtree(extract_parent)
    extract_parent.mkdir(parents=True)
    with tarfile.open(archive_path, "r:gz") as tar:
        tar.extractall(extract_parent, filter="data")
    extracted_root = discover_apalache_root(extract_parent)
    if paths.apalache_dir.exists():
        shutil.rmtree(paths.apalache_dir)
    shutil.move(str(extracted_root), str(paths.apalache_dir))
    shutil.rmtree(extract_parent)
    return paths.apalache_bin


def ensure_toolchain(*, dry_run: bool = False, apalache: bool = False) -> ToolPaths:
    paths = tool_paths()
    if not dry_run:
        ensure_dirs(paths)
    ensure_java(dry_run=dry_run)
    ensure_tla_jar(paths, dry_run=dry_run)
    if apalache:
        ensure_java(dry_run=dry_run, tool=APALACHE_JAVA_TOOL)
        ensure_apalache(paths, dry_run=dry_run)
    if dry_run:
        print(f"Configured Java tool: {JAVA_TOOL}")
        print(f"Pinned TLA+ version: v{TLA_VERSION}")
        print(f"Pinned Apalache version: v{APALACHE_VERSION}")
    return paths


def sanitize_module_name(raw_name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_]+", "", raw_name.strip())
    if not cleaned:
        raise SystemExit("module name must contain letters or digits")
    if cleaned[0].isdigit():
        cleaned = f"M{cleaned}"
    if not MODULE_RE.match(cleaned):
        raise SystemExit(f"invalid module name: {raw_name}")
    return cleaned


def load_template(template_name: str) -> tuple[str, str]:
    paths = tool_paths()
    tla_template = paths.templates_dir / f"{template_name}.tla.tpl"
    cfg_template = paths.templates_dir / f"{template_name}.cfg.tpl"
    if not tla_template.exists() or not cfg_template.exists():
        raise SystemExit(f"template files missing for {template_name}")
    return tla_template.read_text(), cfg_template.read_text()


def scaffold_spec(template_name: str, module_name: str, output_dir: Path, *, force: bool = False) -> tuple[Path, Path]:
    if template_name not in VALID_TEMPLATES:
        raise SystemExit(f"unknown template '{template_name}', expected one of: {', '.join(VALID_TEMPLATES)}")
    tla_template, cfg_template = load_template(template_name)
    output_dir.mkdir(parents=True, exist_ok=True)
    tla_path = output_dir / f"{module_name}.tla"
    cfg_path = output_dir / f"{module_name}.cfg"
    if not force and (tla_path.exists() or cfg_path.exists()):
        raise SystemExit(f"refusing to overwrite existing spec files in {output_dir}; pass --force to replace them")
    tla_path.write_text(tla_template.replace("__MODULE_NAME__", module_name))
    cfg_path.write_text(cfg_template.replace("__MODULE_NAME__", module_name))
    return tla_path, cfg_path


def tlc_base_command(paths: ToolPaths, *, heap_mb: int = 512) -> list[str]:
    return [
        "mise",
        "exec",
        JAVA_TOOL,
        "--",
        "java",
        f"-Xmx{heap_mb}m",
        "-XX:+UseParallelGC",
        "-cp",
        str(paths.tla_jar),
        "tlc2.TLC",
    ]


def apalache_base_command(paths: ToolPaths) -> list[str]:
    return ["mise", "exec", APALACHE_JAVA_TOOL, "--", str(paths.apalache_bin)]


def resolve_spec(spec_arg: str) -> Path:
    spec_path = Path(spec_arg).expanduser().resolve()
    if not spec_path.exists():
        raise SystemExit(f"spec not found: {spec_path}")
    if spec_path.suffix != ".tla":
        raise SystemExit(f"spec must point to a .tla file: {spec_path}")
    return spec_path


def resolve_cfg(spec_path: Path, cfg_arg: str | None) -> Path | None:
    if cfg_arg:
        cfg_path = Path(cfg_arg).expanduser().resolve()
        if not cfg_path.exists():
            raise SystemExit(f"cfg not found: {cfg_path}")
        return cfg_path
    candidate = spec_path.with_suffix(".cfg")
    return candidate if candidate.exists() else None


def tlc_dump_trace_args(trace_path: Path) -> list[str]:
    return ["-dumpTrace", "json", trace_path.name]


def parse_value(value: Any) -> str:
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, list):
        return "<<" + ", ".join(parse_value(item) for item in value) + ">>"
    if isinstance(value, dict):
        fields = []
        for key, item in value.items():
            if not FIELD_RE.match(key):
                raise SystemExit(f"trace field '{key}' must be a valid TLA+ identifier")
            fields.append(f"{key} |-> {parse_value(item)}")
        return "[" + ", ".join(fields) + "]"
    raise SystemExit(f"unsupported trace value type: {type(value).__name__}")


def extract_states(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        states = payload
    elif isinstance(payload, dict):
        for key in ("states", "trace", "counterexample", "counterExample"):
            if key in payload and isinstance(payload[key], list):
                states = payload[key]
                break
        else:
            raise SystemExit("could not find a list of states in the trace payload")
    else:
        raise SystemExit("trace payload must be a JSON object or array")
    if not states:
        raise SystemExit("trace payload contains no states")
    normalized = []
    for index, state in enumerate(states, start=1):
        if not isinstance(state, dict):
            raise SystemExit(f"trace state {index} is not a JSON object")
        normalized.append(state)
    return normalized


def build_trace_validation_module(spec_path: Path, states: list[dict[str, Any]], module_name: str | None = None) -> str:
    variables = list(states[0].keys())
    if not variables:
        raise SystemExit("trace states must contain at least one variable")
    for state in states[1:]:
        if list(state.keys()) != variables:
            raise SystemExit("all trace states must share the same variable ordering and keys")
    trace_name = module_name or f"{spec_path.stem}TraceValidation"
    vars_vector = "<<{}>>".format(", ".join(variables))
    trace_records = ",\n      ".join(parse_value(state) for state in states)
    match_lines = "\n".join(f"    /\\ {name} = StateAt(step).{name}" for name in variables)
    prime_lines = "\n".join(f"    /\\ {name}' = StateAt(traceStep + 1).{name}" for name in variables)
    unchanged_lines = " /\\ ".join(f"{name}' = {name}" for name in variables)
    return textwrap.dedent(
        f"""\
        ---- MODULE {trace_name} ----
        EXTENDS {spec_path.stem}, Sequences, TLC

        VARIABLE traceStep

        TraceVars == {vars_vector}
        ValidationVars == <<traceStep, {", ".join(variables)}>>

        RecordedTrace ==
            <<
              {trace_records}
            >>

        StateAt(step) == RecordedTrace[step]

        TraceMatches(step) ==
        {match_lines}

        TraceInit ==
            /\\ Init
            /\\ traceStep = 1
            /\\ TraceMatches(traceStep)

        TraceNext ==
            /\\ traceStep < Len(RecordedTrace)
            /\\ Next
            /\\ {prime_lines}
            /\\ traceStep' = traceStep + 1

        TraceDone ==
            /\\ traceStep = Len(RecordedTrace)
            /\\ {unchanged_lines}
            /\\ traceStep' = traceStep

        TraceInvariant == TraceMatches(traceStep)

        TraceSpec == TraceInit /\\ [][TraceNext \\/ TraceDone]_ValidationVars

        ====
        """
    )


def build_trace_validation_cfg(module_name: str, base_cfg: Path | None) -> str:
    lines = ["SPECIFICATION TraceSpec", "INVARIANT TraceInvariant", "CHECK_DEADLOCK TRUE"]
    if base_cfg and base_cfg.exists():
        excluded_prefixes = (
            "SPECIFICATION",
            "INIT",
            "NEXT",
            "PROPERTY",
            "PROPERTIES",
            "INVARIANT",
            "CHECK_DEADLOCK",
        )
        carried = []
        for raw_line in base_cfg.read_text().splitlines():
            stripped = raw_line.strip()
            if not stripped:
                carried.append(raw_line)
                continue
            if stripped.startswith("\\*"):
                carried.append(raw_line)
                continue
            if any(stripped.startswith(prefix) for prefix in excluded_prefixes):
                continue
            carried.append(raw_line)
        carried_text = "\n".join(line for line in carried if line.strip())
        if carried_text:
            lines.append("")
            lines.append(carried_text)
    return "\n".join(lines) + "\n"


def write_trace_validation_files(spec_path: Path, states: list[dict[str, Any]], cfg_path: Path | None) -> tuple[Path, Path]:
    module_name = f"{spec_path.stem}TraceValidation"
    harness_tla = spec_path.with_name(f"{module_name}.tla")
    harness_cfg = spec_path.with_name(f"{module_name}.cfg")
    harness_tla.write_text(build_trace_validation_module(spec_path, states, module_name))
    harness_cfg.write_text(build_trace_validation_cfg(module_name, cfg_path))
    return harness_tla, harness_cfg


def load_trace_payload(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid JSON trace file {path}: {exc}") from exc


def render_regression_checklist(states: list[dict[str, Any]]) -> str:
    first = states[0]
    last = states[-1]
    lines = [
        "# Regression checklist",
        "",
        "1. Add an initial state test that asserts the workflow starts in the recorded baseline state.",
        f"   Initial state: {json.dumps(first, sort_keys=True)}",
        "2. Add transition tests for each adjacent pair in the counterexample.",
    ]
    for index, (left, right) in enumerate(zip(states, states[1:]), start=1):
        lines.append(f"   Transition {index}: {json.dumps(left, sort_keys=True)} -> {json.dumps(right, sort_keys=True)}")
    lines.extend(
        [
            "3. Add an invariant-style assertion that the final violating state is unreachable in the healthy path.",
            f"   Violating state: {json.dumps(last, sort_keys=True)}",
            "4. Add operational logging or assertions around the transition just before the violation so future runs emit enough state to replay the trace.",
        ]
    )
    return "\n".join(lines) + "\n"


def parse_tlc_value(raw: str) -> Any:
    value = raw.strip()
    if value == "TRUE":
        return True
    if value == "FALSE":
        return False
    if re.fullmatch(r"-?[0-9]+", value):
        return int(value)
    if value.startswith('"') and value.endswith('"'):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def parse_tlc_trace(output: str) -> list[dict[str, Any]]:
    states: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if line.startswith("State ") and ":" in line:
            if current:
                states.append(current)
            current = {}
            continue
        if current is None:
            continue
        if line.startswith("/\\ ") and " = " in line:
            assignment = line[3:]
            key, value = assignment.split(" = ", 1)
            current[key.strip()] = parse_tlc_value(value)
            continue
        if current and line == "":
            states.append(current)
            current = None
    if current:
        states.append(current)
    return states


def main_ensure_tla_tools(argv: list[str] | None = None) -> int:
    parser = parser_common("Install and verify the pinned Java, TLA+, and Apalache toolchain.")
    args = parser.parse_args(argv)
    ensure_toolchain(dry_run=args.dry_run, apalache=True)
    return 0


def main_new_agent_spec(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Scaffold a new TLA+ spec from one of the built-in agent templates.")
    parser.add_argument("template", nargs="?", help=f"Template name. One of: {', '.join(VALID_TEMPLATES)}")
    parser.add_argument("--name", required=False, help="TLA+ module name for the new spec")
    parser.add_argument(
        "--output-dir",
        default=str(Path.cwd()),
        help="Directory where the .tla and .cfg files should be written",
    )
    parser.add_argument("--force", action="store_true", help="Overwrite existing files if present")
    parser.add_argument("--list-templates", action="store_true", help="Print the available templates and exit")
    args = parser.parse_args(argv)

    if args.list_templates:
        for template in VALID_TEMPLATES:
            print(template)
        return 0

    if not args.template:
        parser.error("template is required unless --list-templates is used")
    if not args.name:
        parser.error("--name is required")

    module_name = sanitize_module_name(args.name)
    tla_path, cfg_path = scaffold_spec(args.template, module_name, Path(args.output_dir).expanduser().resolve(), force=args.force)
    print(f"Scaffolded {tla_path}")
    print(f"Scaffolded {cfg_path}")
    print("Note: the generated .cfg is template-specific. If you replace the scaffolded model, update the .cfg invariants/constants before running TLC.")
    return 0


def main_run_tlc(argv: list[str] | None = None) -> int:
    parser = parser_common("Run TLC against a TLA+ spec using the pinned per-command toolchain.")
    parser.add_argument("spec", help="Path to the .tla spec file")
    parser.add_argument("--config", help="Optional path to the TLC .cfg file")
    parser.add_argument("--workers", default="2", help="Worker count to pass to TLC (default: 2)")
    parser.add_argument("--heap-mb", type=int, default=512, help="Java maximum heap in MiB (default: 512)")
    parser.add_argument("--dump-trace", action="store_true", help="Dump any error trace as JSON next to the spec")
    parser.add_argument("--trace-file", help="Path for the dumped JSON trace file")
    args = parser.parse_args(argv)

    spec_path = resolve_spec(args.spec)
    cfg_path = resolve_cfg(spec_path, args.config)
    paths = ensure_toolchain(dry_run=args.dry_run)
    if args.heap_mb < 1:
        parser.error("--heap-mb must be positive")
    cmd = tlc_base_command(paths, heap_mb=args.heap_mb)
    cmd.extend(["-workers", args.workers])
    if cfg_path:
        cmd.extend(["-config", str(cfg_path)])
    cmd.append(spec_path.stem)
    capture_output = args.dump_trace and not args.dry_run
    result = run(cmd, cwd=spec_path.parent, capture_output=capture_output, dry_run=args.dry_run)
    if capture_output:
        if result.stdout:
            print(result.stdout, end="")
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr)
        trace_path = Path(args.trace_file).expanduser().resolve() if args.trace_file else spec_path.with_suffix(".trace.json")
        states = parse_tlc_trace((result.stdout or "") + "\n" + (result.stderr or ""))
        if states:
            trace_path.write_text(json.dumps({"states": states}, indent=2) + "\n")
            print(f"Wrote {trace_path}")
        else:
            print("No TLC state trace found to serialize.", file=sys.stderr)
    return result.returncode


def main_run_apalache(argv: list[str] | None = None) -> int:
    parser = parser_common("Run Apalache bounded checking against a TLA+ spec.")
    parser.add_argument("spec", help="Path to the .tla spec file")
    parser.add_argument("--config", help="Optional path to a TLC-style .cfg file")
    parser.add_argument("--length", default="10", help="Maximum execution length for bounded checking")
    parser.add_argument("--init", help="Override the Init operator (otherwise use config/default)")
    parser.add_argument("--next", dest="next_op", help="Override the Next operator (otherwise use config/default)")
    args = parser.parse_args(argv)

    spec_path = resolve_spec(args.spec)
    cfg_path = resolve_cfg(spec_path, args.config)
    paths = ensure_toolchain(dry_run=args.dry_run, apalache=True)
    cmd = apalache_base_command(paths) + [
        "check",
        f"--length={args.length}",
    ]
    if args.init:
        cmd.append(f"--init={args.init}")
    if args.next_op:
        cmd.append(f"--next={args.next_op}")
    if cfg_path:
        cmd.append(f"--config={cfg_path}")
    cmd.append(str(spec_path))
    result = run(cmd, cwd=spec_path.parent, dry_run=args.dry_run)
    return result.returncode


def main_validate_trace(argv: list[str] | None = None) -> int:
    parser = parser_common("Generate a trace-validation harness and optionally run TLC against it.")
    parser.add_argument("spec", help="Path to the .tla spec file")
    parser.add_argument("trace", help="Path to a JSON trace file")
    parser.add_argument("--config", help="Optional path to the base TLC .cfg file")
    parser.add_argument("--emit-only", action="store_true", help="Only write the validation harness; do not run TLC")
    args = parser.parse_args(argv)

    spec_path = resolve_spec(args.spec)
    cfg_path = resolve_cfg(spec_path, args.config)
    trace_path = Path(args.trace).expanduser().resolve()
    if not trace_path.exists():
        raise SystemExit(f"trace file not found: {trace_path}")

    states = extract_states(load_trace_payload(trace_path))
    if args.dry_run:
        print(build_trace_validation_module(spec_path, states))
        return 0

    harness_tla, harness_cfg = write_trace_validation_files(spec_path, states, cfg_path)
    print(f"Wrote {harness_tla}")
    print(f"Wrote {harness_cfg}")
    if args.emit_only:
        return 0
    paths = ensure_toolchain()
    with tempfile.TemporaryDirectory(prefix="tla-trace-") as metadata:
        result = run(tlc_base_command(paths) + ["-workers", "2", "-metadir", metadata,
                     "-config", str(harness_cfg), str(harness_tla)],
                     cwd=spec_path.parent, capture_output=True)
    output = (result.stdout or "") + "\n" + (result.stderr or "")
    print(output)
    if result.returncode != 0:
        return result.returncode
    counts = re.findall(r"(\d+) distinct states found", output)
    if not counts or int(counts[-1]) != len(states):
        print("Trace validation did not visit every recorded state", file=sys.stderr)
        return 1
    return 0


def main_spec_to_tests(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Turn a TLC/Apalache trace into a practical regression checklist.")
    parser.add_argument("trace", help="Path to a JSON trace or counterexample file")
    args = parser.parse_args(argv)

    trace_path = Path(args.trace).expanduser().resolve()
    if not trace_path.exists():
        raise SystemExit(f"trace file not found: {trace_path}")
    states = extract_states(load_trace_payload(trace_path))
    print(render_regression_checklist(states), end="")
    return 0


def main() -> int:
    program = Path(sys.argv[0]).name
    dispatch = {
        "ensure-tla-tools": main_ensure_tla_tools,
        "new-agent-spec": main_new_agent_spec,
        "run-tlc": main_run_tlc,
        "run-apalache": main_run_apalache,
        "validate-trace": main_validate_trace,
        "spec-to-tests": main_spec_to_tests,
    }
    if program in dispatch:
        return dispatch[program](sys.argv[1:])
    raise SystemExit(f"unknown entrypoint: {program}")


if __name__ == "__main__":
    raise SystemExit(main())
