// HACK-2681: the CI helpers that install Zig must survive a slow or dead
// download source without accepting unverified bytes. Fake `mise` and `curl`
// executables on PATH stand in for the network.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSyncBounded } from "./helpers/bounded-spawn-sync.ts";

const repoRoot = resolve(import.meta.dir, "..");
const owned: string[] = [];

afterAll(async () => {
  await Promise.all(
    owned.map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function workDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hack-ci-download-"));
  owned.push(dir);
  await mkdir(join(dir, "bin"));
  return dir;
}

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

function run(opts: {
  readonly cmd: readonly string[];
  readonly dir: string;
  readonly env?: Record<string, string>;
}) {
  const result = spawnSyncBounded([...opts.cmd], {
    cwd: opts.dir,
    env: {
      ...process.env,
      PATH: `${join(opts.dir, "bin")}:${process.env.PATH ?? ""}`,
      ...opts.env,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
  };
}

async function lines(path: string): Promise<string[]> {
  if (!existsSync(path)) {
    return [];
  }
  return (await readFile(path, "utf8")).split("\n").filter(Boolean);
}

test("prerelease Zig checks cache contents before running the compiler", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(join(repoRoot, ".github/workflows/prerelease.yml")).text()
  ) as {
    jobs: { build: { steps: Array<{ id?: string; run?: string }> } };
  };
  const script = workflow.jobs.build.steps.find(
    (step) => step.id === "zig"
  )?.run;
  if (!script) {
    throw new Error("Missing prerelease Zig step");
  }
  const fixture = await workDir();
  const archiveName = "zig-aarch64-macos-0.15.2.tar.xz";
  const source = join(fixture, "zig-release");
  await mkdir(source);
  const compiler = '#!/bin/sh\necho SOURCE >> "$TRACE"\necho 0.15.2\n';
  const verified = join(fixture, "verified.tar");
  const invalid = join(fixture, "invalid.tar");
  for (const [archive, label] of [
    [verified, "cached"],
    [invalid, "unexpected"],
  ] as const) {
    await executable(join(source, "zig"), compiler.replace("SOURCE", label));
    expect(
      run({ cmd: ["tar", "-cf", archive, "zig-release"], dir: fixture })
        .exitCode
    ).toBe(0);
  }
  const sha256 = createHash("sha256")
    .update(await readFile(verified))
    .digest("hex");
  const signedCompiler = join(fixture, "signed-zig");
  await executable(signedCompiler, compiler.replace("SOURCE", "signed"));

  for (const cached of [verified, invalid, undefined]) {
    const dir = await workDir();
    const trace = join(dir, "trace");
    const output = join(dir, "output");
    if (cached) {
      await copyFile(cached, join(dir, archiveName));
    }
    await executable(
      join(dir, "bin/mise"),
      `#!/bin/sh
set -eu
case "$1" in
  config) echo 0.15.2 ;;
  install)
    test "$MISE_ALWAYS_KEEP_DOWNLOAD" = 1
    echo install >> "$TRACE"
    mkdir -p "$MISE_INSTALLS_DIR/zig/0.15.2/bin" "$MISE_DOWNLOADS_DIR/zig/0.15.2"
    cp "$SIGNED_ZIG" "$MISE_INSTALLS_DIR/zig/0.15.2/bin/zig"
    cp "$VERIFIED_ARCHIVE" "$MISE_DOWNLOADS_DIR/zig/0.15.2/$HACK_PRERELEASE_ZIG_ARCHIVE"
    ;;
  where) echo "$MISE_INSTALLS_DIR/zig/0.15.2" ;;
  *) exit 2 ;;
esac
`
    );
    const result = run({
      cmd: ["bash", "-c", script],
      dir,
      env: {
        RUNNER_TEMP: dir,
        TRACE: trace,
        GITHUB_OUTPUT: output,
        GITHUB_PATH: join(dir, "path"),
        HACK_PRERELEASE_ZIG_ARCHIVE: archiveName,
        HACK_PRERELEASE_ZIG_SHA256: sha256,
        ZIG_ARCHIVE_CACHE_HIT: cached ? "true" : "",
        SIGNED_ZIG: signedCompiler,
        VERIFIED_ARCHIVE: verified,
      },
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await lines(trace)).toEqual(
      cached === verified ? ["cached"] : ["install", "signed"]
    );
    expect(await lines(output)).toEqual(cached ? [] : ["archive-ready=true"]);
    expect(await lines(join(dir, "path"))).toHaveLength(1);
  }
});

describe("scripts/mise-install-retry.sh", () => {
  const script = join(repoRoot, "scripts/mise-install-retry.sh");

  // The fake mise logs "<MISE_HTTP_TIMEOUT> <args>" and fails until it has
  // been called FAKE_MISE_FAILURES + 1 times.
  async function fakeMise(dir: string): Promise<string> {
    const log = join(dir, "mise.log");
    await executable(
      join(dir, "bin/mise"),
      `#!/bin/sh
echo "$MISE_HTTP_TIMEOUT $*" >> "${log}"
calls=$(wc -l < "${log}")
[ "$calls" -gt "$FAKE_MISE_FAILURES" ]
`
    );
    return log;
  }

  test("retries a failed install with a longer HTTP timeout until it succeeds", async () => {
    const dir = await workDir();
    const log = await fakeMise(dir);
    const result = run({
      cmd: ["sh", script, "zig"],
      dir,
      env: { FAKE_MISE_FAILURES: "2", MISE_INSTALL_RETRY_DELAY: "0" },
    });
    expect(result.exitCode).toBe(0);
    expect(await lines(log)).toEqual([
      "90s install zig",
      "90s install zig",
      "90s install zig",
    ]);
    expect(result.stderr).toContain("attempt 2 of 4");
  });

  test("stops after the attempt limit and fails", async () => {
    const dir = await workDir();
    const log = await fakeMise(dir);
    const result = run({
      cmd: ["sh", script],
      dir,
      env: {
        FAKE_MISE_FAILURES: "99",
        MISE_INSTALL_ATTEMPTS: "3",
        MISE_INSTALL_RETRY_DELAY: "0",
        MISE_HTTP_TIMEOUT: "45s",
      },
    });
    expect(result.exitCode).toBe(1);
    expect(await lines(log)).toEqual([
      "45s install",
      "45s install",
      "45s install",
    ]);
    expect(result.stderr).toContain("failed 3 times");
  });

  test("refuses a non-numeric attempt limit instead of retrying forever", async () => {
    const dir = await workDir();
    const log = await fakeMise(dir);
    for (const attempts of ["abc", "0", "007", "99999999999999999999999", ""]) {
      const result = run({
        cmd: ["sh", script, "zig"],
        dir,
        env: {
          FAKE_MISE_FAILURES: "99",
          MISE_INSTALL_ATTEMPTS: attempts,
          MISE_INSTALL_RETRY_DELAY: "0",
        },
      });
      // An empty value means the default (4 attempts), which still fails.
      expect(result.exitCode).toBe(attempts === "" ? 1 : 2);
    }
    expect((await lines(log)).length).toBe(4);
  });
});

describe("scripts/fetch-zig.sh", () => {
  const script = join(repoRoot, "scripts/fetch-zig.sh");
  const fixture = "pinned zig bytes\n";
  const sha = createHash("sha256").update(fixture).digest("hex");
  const file = "zig-test-0.15.2.tar.xz";

  // The fake curl logs each URL. ziglang.org serves other bytes (a fresh
  // mismatch moves on without retrying), mirrors listed in FAKE_GOOD serve
  // the fixture, and every other mirror serves other bytes too.
  async function fakeCurl(dir: string): Promise<string> {
    const log = join(dir, "curl.log");
    await writeFile(join(dir, "fixture"), fixture);
    await executable(
      join(dir, "bin/curl"),
      `#!/usr/bin/env bash
out="" url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    --continue-at|--speed-limit|--speed-time|--max-time|--connect-timeout|--proto|--proto-redir) shift 2 ;;
    *) url=$1; shift ;;
  esac
done
echo "$url" >> "${log}"
case "$url" in
  https://ziglang.org/*) printf 'other bytes\\n' > "$out" ;;
  *) if [[ -n "\${FAKE_GOOD:-}" && "$url" == "$FAKE_GOOD"* ]]; then cat "${join(dir, "fixture")}" > "$out"; else printf 'other bytes\\n' > "$out"; fi ;;
esac
`
    );
    return log;
  }

  test("falls back from ziglang.org to a mirror and keeps only verified bytes", async () => {
    const dir = await workDir();
    const log = await fakeCurl(dir);
    const out = join(dir, "zig");
    const result = run({
      cmd: ["bash", script, "0.15.2", file, sha, out],
      dir,
      env: { FAKE_GOOD: "https://pkg.hexops.org/zig/" },
    });
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(out, file), "utf8")).toBe(fixture);
    expect(existsSync(join(out, `${file}.partial`))).toBe(false);
    const urls = await lines(log);
    expect(urls[0]).toBe(`https://ziglang.org/download/0.15.2/${file}`);
    expect(urls.at(-1)).toBe(
      `https://pkg.hexops.org/zig/${file}?source=hack-ci`
    );
    expect(result.stderr).toContain(
      `sha256 mismatch for ${file} from https://ziglang.org/download/0.15.2/${file}`
    );
  });

  test("fails without leaving a file when no source has the pinned bytes", async () => {
    const dir = await workDir();
    const log = await fakeCurl(dir);
    const out = join(dir, "zig");
    const result = run({
      cmd: ["bash", script, "0.15.2", file, sha, out],
      dir,
    });
    expect(result.exitCode).toBe(1);
    expect(existsSync(join(out, file))).toBe(false);
    expect(existsSync(join(out, `${file}.partial`))).toBe(false);
    // ziglang.org plus every pinned mirror, each tried once.
    expect((await lines(log)).length).toBe(18);
    expect(result.stderr).toContain("could not fetch a verified");
  });

  test("reuses a cached tarball that verifies, without a request", async () => {
    const dir = await workDir();
    const log = await fakeCurl(dir);
    const out = join(dir, "zig");
    await mkdir(out);
    await writeFile(join(out, file), fixture);
    const result = run({
      cmd: ["bash", script, "0.15.2", file, sha, out],
      dir,
    });
    expect(result.exitCode).toBe(0);
    expect(await lines(log)).toEqual([]);
  });

  test("rejects the wrong number of arguments", async () => {
    const dir = await workDir();
    const result = run({ cmd: ["bash", script, "0.15.2"], dir });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: fetch-zig.sh");
  });
});
