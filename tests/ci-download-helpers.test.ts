// HACK-2681: the CI helpers that install Zig must survive a slow or dead
// download source without accepting unverified bytes. Fake `mise` and `curl`
// executables on PATH stand in for the network.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
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
