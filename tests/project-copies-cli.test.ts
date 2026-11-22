import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveNativeProjectRun } from "../src/backends/native-project-run.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

async function fixture(count: number) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-copies-")));
  const checkout = (i: number) => join(root, `checkout-${i}`);
  for (let i = 0; i < count; i++) {
    const dir = join(checkout(i), ".hack");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(dir, "hack.config.json"),
      JSON.stringify({ name: "sample", dev_host: "sample.hack.local" })
    );
    await writeFile(
      join(dir, "docker-compose.yml"),
      "services:\n  web:\n    image: web\n    labels:\n      caddy: sample.hack.local\n"
    );
  }
  const time = "2026-01-01T00:00:00.000Z";
  await writeFile(
    join(root, "projects.json"),
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: "sample-id",
          name: "sample",
          repoRoot: checkout(0),
          projectDir: join(checkout(0), ".hack"),
          projectDirName: ".hack",
          createdAt: time,
          worktrees: Array.from({ length: count - 1 }, (_, i) => ({
            path: checkout(i + 1),
            branch: `feature-${i + 1}`,
            lastSeenAt: time,
          })),
        },
      ],
    })
  );
  const calls = join(root, "docker-calls");
  const reply = join(root, "docker-reply");
  await writeFile(reply, "");
  await writeFile(
    join(root, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$COPY_TEST_CALLS"
[ "$1" = ps ] || exit 17
cat "$COPY_TEST_REPLY"
`,
    { mode: 0o700 }
  );
  const nativeHome = join(root, "candidate");
  await mkdir(nativeHome, { mode: 0o700 });
  async function run(args: readonly string[], native = false) {
    const startedAt = performance.now();
    const proc = Bun.spawn(
      [
        process.execPath,
        "index.ts",
        "ps",
        "--project=sample",
        "--copies",
        ...args,
      ],
      {
        env: privateCliEnv({
          root,
          env: {
            PATH: `${root}:${process.env.PATH}`,
            HACK_GLOBAL_CONFIG_PATH: join(root, "global.json"),
            HACK_NO_INTERACTIVE: "1",
            HACK_RUNTIME_BACKEND: native ? "native" : "compose",
            HACK_NATIVE_HOME: nativeHome,
            HACK_NATIVE_BINARY: join(root, "unexpected-native"),
            COPY_TEST_CALLS: calls,
            COPY_TEST_REPLY: reply,
            NO_COLOR: "1",
          },
        }),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 8000,
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr, elapsed: performance.now() - startedAt };
  }
  return { root, checkout, calls, reply, run };
}

test("copies attributes an instance to its worktree using one Compose inventory", async () => {
  const f = await fixture(2);
  try {
    await writeFile(
      f.reply,
      `${JSON.stringify({
        ID: "abcdef",
        State: "running",
        Status: "Up 7 seconds (unhealthy)",
        Labels: [
          "com.docker.compose.project=sample--feature-1",
          "com.docker.compose.service=web",
          `com.docker.compose.project.working_dir=${join(f.checkout(1), ".hack")}`,
        ].join(","),
      })}\n`
    );
    const result = await f.run([]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("BRANCH");
    expect(result.stdout).toContain("CHECKOUT");
    expect(result.stdout).toContain("2 copies · 1 stopped · 1 unhealthy");
    expect(result.stdout).toContain("https://feature-1.sample.hack.local");
    expect(result.stdout).not.toContain(f.root);
    expect((await readFile(f.calls, "utf8")).trim().split("\n")).toEqual([
      "ps -a --filter label=com.docker.compose.project --format json",
    ]);

    const json = await f.run(["--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: true,
      data: {
        project: "sample",
        copies: [
          {
            branch: null,
            checkout: { kind: "primary", name: "primary" },
            instance: null,
            state: "stopped",
            address: null,
          },
          {
            branch: "feature-1",
            checkout: { kind: "worktree", name: "feature-1" },
            instance: "feature-1",
            state: "unhealthy",
            address: "https://feature-1.sample.hack.local",
          },
        ],
      },
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("one copy has a normal table and singular count", async () => {
  const f = await fixture(1);
  try {
    const result = await f.run([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("1 copy · 1 stopped");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("twenty stopped copies need one docker call or no native processes", async () => {
  const f = await fixture(20);
  try {
    for (const native of [false, true]) {
      const result = await f.run([], native);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("20 copies · 20 stopped");
      console.info(
        `copies-20 ${native ? "native" : "compose"}: ${Math.round(result.elapsed)} ms (source CLI, Linux fixture)`
      );
    }
    expect((await readFile(f.calls, "utf8")).trim().split("\n")).toHaveLength(
      1
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a foreign native home leaves an unknown row and a scoped recovery hint", async () => {
  const f = await fixture(2);
  try {
    const oldHome = join(f.root, "old-candidate");
    await mkdir(oldHome, { mode: 0o700 });
    await saveNativeProjectRun({
      projectRoot: f.checkout(1),
      projectDir: join(f.checkout(1), ".hack"),
      nativeHome: oldHome,
      branch: "feature-1",
      run: {
        run: "a".repeat(32),
        owner: "b".repeat(32),
        namespace: "c".repeat(64),
        planId: "d".repeat(64),
      },
    });
    await rm(oldHome, { recursive: true });
    const result = await f.run([], true);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("2 copies · 1 stopped · 1 unknown");
    expect(result.stdout).not.toContain(f.root);
    expect(result.stdout).toContain("from feature-1, run:");
    expect(result.stdout).toContain("--native-run-mapping");
    expect(result.stdout).toContain("--branch=feature-1");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("native copies hold at most four observation slots and keep other rows", async () => {
  const f = await fixture(1);
  try {
    const nativeHome = join(f.root, "candidate");
    const run = {
      run: "a".repeat(32),
      owner: "b".repeat(32),
      namespace: "c".repeat(64),
      planId: "d".repeat(64),
    };
    for (let i = 0; i < 6; i++) {
      await saveNativeProjectRun({
        projectRoot: f.checkout(0),
        projectDir: join(f.checkout(0), ".hack"),
        nativeHome,
        branch: `instance-${i}`,
        run,
      });
    }

    const trace = join(f.root, "native-trace");
    await writeFile(
      join(f.root, "unexpected-native"),
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
const trace = ${JSON.stringify(trace)};
if (process.argv[4] !== "graph" || process.argv[5] !== "status") process.exit(17);
appendFileSync(trace, "+");
await Bun.sleep(100);
appendFileSync(trace, "-");
console.error(JSON.stringify({code: "provider_pin_changed"}));
process.exit(1);
`,
      { mode: 0o700 }
    );
    const result = await f.run([], true);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("7 copies · 1 stopped · 6 unknown");
    const events = await readFile(trace, "utf8");
    let inFlight = 0;
    let peak = 0;
    for (const event of events) {
      inFlight += event === "+" ? 1 : -1;
      peak = Math.max(peak, inFlight);
    }
    expect(events).toHaveLength(12);
    expect(inFlight).toBe(0);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("authored Compose copies match the generated base and branch inventory", async () => {
  const f = await fixture(1);
  try {
    const root = f.checkout(0);
    const dir = join(root, ".hack");
    await rm(join(dir, "hack.config.json"));
    await rm(join(dir, "docker-compose.yml"));
    await writeFile(join(dir, "hack.project.json"), "{}");
    const { dev, ino } = await stat(root);
    const inventory: string[] = [];
    for (const instance of [null, "feature/example"]) {
      const instanceId = createHash("sha256")
        .update(JSON.stringify([root, dev, ino, instance]))
        .digest("hex");
      const composeProject = `hack-nc-${instanceId.slice(0, 32)}`;
      const store = join(dir, ".internal", "native-compose", instanceId);
      const generation = join(store, "generations", "a".repeat(32));
      await mkdir(generation, { recursive: true });
      await writeFile(
        join(store, "receipt.json"),
        JSON.stringify({
          identity: { checkoutRoot: root, instance, composeProject },
        }),
        { mode: 0o600 }
      );
      inventory.push(
        JSON.stringify({
          ID: instance ?? "base",
          State: "running",
          Status: instance
            ? "Up 1 second (health: starting)"
            : "Up 1 minute (healthy)",
          Labels: [
            `com.docker.compose.project=${composeProject}`,
            "com.docker.compose.service=web",
            `com.docker.compose.project.working_dir=${generation}`,
          ].join(","),
        })
      );
    }
    await writeFile(f.reply, inventory.join("\n"));
    const result = await f.run([]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("feature/example");
    expect(result.stdout).toContain("2 copies · 1 healthy · 1 starting");
    expect(result.stdout).not.toContain("hack-nc-");
    expect((await readFile(f.calls, "utf8")).trim().split("\n")).toHaveLength(
      1
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("copies uses live worktree branches instead of stale registration branches", async () => {
  const f = await fixture(2);
  try {
    await writeFile(
      join(f.root, "git"),
      `#!/bin/sh
cat <<'WORKTREES'
worktree ${f.checkout(0)}
branch refs/heads/main

worktree ${f.checkout(1)}
branch refs/heads/changed/branch

WORKTREES
`,
      { mode: 0o700 }
    );
    const result = await f.run(["--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.copies).toMatchObject([
      { branch: "main", instance: null },
      {
        branch: "changed/branch",
        checkout: { name: "changed/branch" },
        instance: "changed-branch",
      },
    ]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
