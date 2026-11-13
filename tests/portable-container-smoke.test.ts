import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable smoke accepts metadata and rejects value fields or leaked sentinels", async () => {
  const source = await Bun.file(
    new URL("../scripts/portable-container-smoke.sh", import.meta.url)
  ).text();
  const script = source.match(/-lc '([\s\S]*?)'\s*\n/)?.[1];
  expect(script).toBeDefined();
  if (!script) {
    throw new Error("Portable smoke container command is missing");
  }
  const root = await mkdtemp(join(tmpdir(), "hack-portable-smoke-check-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  const hack = join(bin, "hack");
  await writeFile(
    hack,
    `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "env list --json") printf '%s\\n' "$SMOKE_LIST_JSON" ;;
  "env get PORTABLE_PLAIN"|"host exec -- printenv PORTABLE_PLAIN") printf '%s\\n' portable-ready ;;
  "env get PORTABLE_SECRET"|"host exec -- printenv PORTABLE_SECRET") printf '%s\\n' portable-secret ;;
  *) exit 64 ;;
esac
`
  );
  await chmod(hack, 0o755);
  const vars = [{ key: "PORTABLE_PLAIN" }, { key: "PORTABLE_SECRET" }];
  for (const [payload, accepted] of [
    [{ vars }, true],
    [{ vars: [{ ...vars[0], value: "" }, vars[1]] }, false],
    [{ vars, unexpected: "portable-secret" }, false],
    [{ vars, unexpected: "portable-ready" }, false],
  ] as const) {
    const child = Bun.spawn(["bash", "-c", script], {
      cwd: root,
      env: privateCliEnv({
        root,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          TMPDIR: root,
          SMOKE_LIST_JSON: JSON.stringify(payload),
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code === 0).toBe(accepted);
    expect(stdout + stderr).not.toContain("portable-secret");
    expect(stdout + stderr).not.toContain("portable-ready");
    if (!accepted) {
      expect(stderr).toContain("env list --json exposed values");
    }
  }
});
