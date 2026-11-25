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
  await writeFile(join(root, "unexpected-native"), "#!/bin/sh\nexit 17\n", {
    mode: 0o700,
  });
  async function run(
    args: readonly string[],
    native = false,
    selection = "--project=sample",
    candidateHome?: string
  ) {
    const startedAt = performance.now();
    const proc = Bun.spawn(
      [process.execPath, "index.ts", "ps", selection, "--copies", ...args],
      {
        env: privateCliEnv({
          root,
          home: candidateHome,
          env: {
            HACK_CANDIDATE_ENTRYPOINT: candidateHome ? "hack-next" : undefined,
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
    expect(result.stdout).toContain(
      "2 copies on compose · 1 unknown · 1 unhealthy"
    );
    expect(result.stdout).toContain("https://feature-1.sample.hack.local");
    expect(result.stdout).not.toContain(f.root);
    expect((await readFile(f.calls, "utf8")).trim().split("\n")).toEqual([
      "ps -a --no-trunc --filter label=com.docker.compose.project --format json",
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
            state: "unknown",
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
    expect(result.stdout).toContain("1 copy on compose · 1 unknown");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("twenty idle copies need one docker call or no native processes", async () => {
  const f = await fixture(20);
  try {
    for (const native of [false, true]) {
      const result = await f.run([], native);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(
        `20 copies on ${native ? "native" : "compose"} · 20 unknown`
      );
      console.info(
        `copies-20 ${native ? "native" : "compose"}: ${Math.round(result.elapsed)} ms (source CLI, ${process.platform} fixture)`
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
    expect(result.stdout).toContain("2 copies on native · 2 unknown");
    expect(result.stdout).not.toContain(f.root);
    expect(result.stdout).toContain("from feature-1 (feature-1), run:");
    expect(result.stdout).toContain("--native-run-mapping");
    expect(result.stdout).toContain("--branch=feature-1");
    expect(result.stdout).toContain("--path=.");
    expect(result.stdout).not.toContain("../");
    const inHome = await f.run([], true, "--project=sample", f.root);
    expect(inHome.code).toBe(0);
    expect(inHome.stdout).toContain("~/.hack-next/bin/hack-next doctor");
    expect(inHome.stdout).toContain("--path ~/checkout-1");
    expect(inHome.stdout).not.toContain(f.root);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("native copies hold at most four observation slots and keep other rows", async () => {
  const f = await fixture(6);
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
        projectRoot: f.checkout(i),
        projectDir: join(f.checkout(i), ".hack"),
        nativeHome,
        branch: i === 0 ? null : `feature-${i}`,
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
    expect(result.stdout).toContain("6 copies on native · 6 unknown");
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
    const base = JSON.parse(inventory[0] ?? "{}");
    const older = base.Labels.replace(
      `/generations/${"a".repeat(32)}`,
      `/generations/${"b".repeat(32)}`
    );
    inventory.push(
      JSON.stringify({
        ...base,
        ID: "older",
        State: "exited",
        Status: "Exited (1) 1 second ago",
        Labels: older,
      })
    );
    await writeFile(f.reply, inventory.join("\n"));
    const result = await f.run([]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("feature/example");
    expect(result.stdout).toContain(
      "2 copies on compose · 1 exited (1) · 1 starting"
    );
    expect(result.stdout).not.toContain("hack-nc-");
    expect(result.stdout).not.toContain("no address");
    expect((await readFile(f.calls, "utf8")).trim().split("\n")).toHaveLength(
      1
    );
    await writeFile(join(dir, "hack.project.json"), "{");
    const broken = await f.run(["--json"]);
    expect(broken.code).toBe(0);
    expect(JSON.parse(broken.stdout).data.copies).toMatchObject([
      { authored: true, state: "unknown" },
      { authored: true, state: "unknown" },
    ]);
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

test("unobserved backends, bad config and duplicate branch names remain distinct", async () => {
  const f = await fixture(3);
  try {
    await writeFile(
      join(f.root, "git"),
      `#!/bin/sh
cat <<'WORKTREES'
worktree ${f.checkout(0)}
branch refs/heads/main

WORKTREES
`,
      { mode: 0o700 }
    );
    await writeFile(join(f.checkout(1), ".hack", "hack.config.json"), "{");
    await writeFile(
      join(f.checkout(1), ".hack", "docker-compose.yml"),
      "name: sample\nservices: {web: {image: web}}\n"
    );

    const entries = [
      ["sample", "web", "running", "Up 7 seconds", 0],
      ["sample", "jobs", "exited", "Exited (1) 2 seconds ago", 0],
      ["sample--main", "web", "running", "Up 7 seconds", 0],
      ["sample--feature-1", "web", "running", "Up 7 seconds", 1],
    ] as const;
    await writeFile(
      f.reply,
      entries
        .map(([name, service, state, status, index]) =>
          JSON.stringify({
            ID: `${name}-${service}`,
            State: state,
            Status: status,
            Labels: `com.docker.compose.project=${name},com.docker.compose.service=${service},com.docker.compose.project.working_dir=${join(f.checkout(index), ".hack")}`,
          })
        )
        .join("\n")
    );
    const result = await f.run([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("primary (default instance)");
    expect(result.stdout).toContain("primary (main)");
    expect(result.stdout).toContain(
      "4 copies on compose · 1 exited (1) · 1 running · 2 unknown"
    );
    const native = await f.run([], true);
    expect(native.code).toBe(0);
    expect(native.stdout).toContain("3 copies on native · 3 unknown");
    expect((await readFile(f.calls, "utf8")).trim().split("\n")).toHaveLength(
      1
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

async function gitList(root: string, entries: readonly [string, string][]) {
  const listing = entries
    .map(([path, branch]) => `worktree ${path}\nbranch refs/heads/${branch}\n`)
    .join("\n");
  await writeFile(
    join(root, "git"),
    `#!/bin/sh
cat <<'WORKTREES'
${listing}
WORKTREES
`,
    { mode: 0o700 }
  );
}

test("explicit registration wins over another project's saved worktree", async () => {
  const f = await fixture(2);
  try {
    const path = join(f.root, "projects.json");
    const registry = JSON.parse(await readFile(path, "utf8"));
    registry.projects.push({
      ...registry.projects[0],
      id: "other-id",
      name: "other",
      repoRoot: f.checkout(1),
      projectDir: join(f.checkout(1), ".hack"),
      worktrees: [],
    });
    await writeFile(path, JSON.stringify(registry));
    const other = await f.run(["--json"], false, "--project=other");
    expect(other.code).toBe(0);
    expect(JSON.parse(other.stdout).data).toMatchObject({
      project: "other",
      copies: [{ checkout: { root: f.checkout(1) } }],
    });
    const original = await f.run(["--json"]);
    expect(JSON.parse(original.stdout).data.copies).toHaveLength(1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("nested checkouts use Git main and linked identity and deduplicate moved roots", async () => {
  const f = await fixture(2);
  try {
    const path = join(f.root, "projects.json");
    const registry = JSON.parse(await readFile(path, "utf8"));
    const primary = registry.projects[0];
    primary.repoRoot = f.checkout(1);
    primary.projectDir = join(f.checkout(1), ".hack");
    primary.worktrees.push({ ...primary.worktrees[0], path: f.checkout(0) });
    await writeFile(path, JSON.stringify(registry));
    await gitList(f.root, [
      [f.checkout(0), "main"],
      [f.checkout(1), "linked"],
    ]);
    const result = await f.run(["--json"]);
    expect(JSON.parse(result.stdout).data.copies).toMatchObject([
      { checkout: { kind: "worktree" }, branch: "linked", instance: "linked" },
      { checkout: { kind: "primary" }, branch: "main", instance: null },
    ]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a fresh nested worktree joins the corresponding registered project", async () => {
  const f = await fixture(2);
  try {
    const project = (i: number) => join(f.checkout(i), "apps", "web");
    for (let i = 0; i < 2; i++) {
      await mkdir(project(i), { recursive: true });
      await Bun.write(join(project(i), ".keep"), "");
      await mkdir(join(project(i), ".hack"));
      await writeFile(
        join(project(i), ".hack", "docker-compose.yml"),
        "name: sample\nservices: {web: {image: web}}\n"
      );
    }
    const path = join(f.root, "projects.json");
    const registry = JSON.parse(await readFile(path, "utf8"));
    Object.assign(registry.projects[0], {
      repoRoot: project(0),
      projectDir: join(project(0), ".hack"),
      worktrees: [],
    });
    await writeFile(path, JSON.stringify(registry));
    await gitList(f.root, [
      [f.checkout(0), "main"],
      [f.checkout(1), "fresh/branch"],
    ]);
    const result = await f.run(["--json"], false, `--path=${project(1)}`);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({
      project: "sample",
      copies: [
        { branch: "main", checkout: { kind: "primary" }, instance: null },
        {
          branch: "fresh/branch",
          checkout: { kind: "worktree" },
          instance: "fresh-branch",
        },
      ],
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Compose keeps a saved native branch visible and reports inventory failure", async () => {
  const f = await fixture(1);
  try {
    await saveNativeProjectRun({
      projectRoot: f.checkout(0),
      projectDir: join(f.checkout(0), ".hack"),
      nativeHome: join(f.root, "candidate"),
      branch: "native-only",
      run: {
        run: "a".repeat(32),
        owner: "b".repeat(32),
        namespace: "c".repeat(64),
        planId: "d".repeat(64),
      },
    });
    const liveElsewhere = await f.run(["--json"]);
    expect(JSON.parse(liveElsewhere.stdout).data.copies).toMatchObject([
      { instance: null, state: "unknown" },
      { instance: "native-only", state: "unknown" },
    ]);
    const nativeStatus = {
      receipt: {
        run: "a".repeat(32),
        owner: "b".repeat(32),
        namespace: "c".repeat(64),
        plan_id: "d".repeat(64),
        phase: "ready-observed",
        resources: {
          "container:web": {
            kind: "container",
            key: "web",
            id: "e".repeat(64),
            phase: "started",
          },
        },
      },
      journal_incomplete: false,
      observations: { "container:web": { state: "running" } },
    };
    await writeFile(
      join(f.root, "unexpected-native"),
      `#!/bin/sh
printf '%s\n' '${JSON.stringify(nativeStatus)}'
`,
      { mode: 0o700 }
    );
    const confirmed = await f.run(["--json"], true);
    expect(JSON.parse(confirmed.stdout).data.copies).toMatchObject([
      { instance: null, state: "unknown" },
      { instance: "native-only", state: "running" },
    ]);
    const degraded = {
      ...nativeStatus,
      receipt: {
        ...nativeStatus.receipt,
        relay_startup: {},
        resources: {
          "container:web": {
            ...nativeStatus.receipt.resources["container:web"],
            loopback_ports: [{ host_port: 18_080, target: 8080 }],
          },
        },
      },
    };
    const owner = {
      ok: true,
      run: nativeStatus.receipt.run,
      plan: nativeStatus.receipt.plan_id,
      phase: "ready-observed",
      foreground_alive: true,
      runtime_verified: false,
      publisher_ports: [{ port: 18_080, state: "down" }],
    };
    await writeFile(
      join(f.root, "unexpected-native"),
      `#!${process.execPath}
const value = process.argv.includes("owner-status") ? ${JSON.stringify(owner)} : ${JSON.stringify(degraded)};
console.log(JSON.stringify(value));
`,
      { mode: 0o700 }
    );
    const portDown = await f.run(["--json"], true);
    expect(JSON.parse(portDown.stdout).data.copies).toMatchObject([
      { instance: null, state: "unknown" },
      { instance: "native-only", state: "port-down", address: null },
    ]);
    await writeFile(join(f.root, "docker"), "#!/bin/sh\nexit 124\n", {
      mode: 0o700,
    });
    const timedOut = await f.run(["--json"]);
    expect(timedOut.code).toBe(0);
    expect(JSON.parse(timedOut.stdout)).toMatchObject({
      ok: true,
      data: { observation: { ok: false, code: "E_TIMEOUT" } },
    });
    const text = await f.run([]);
    expect(text.stdout).toContain("compose status could not be fully observed");
    await rm(join(f.root, "unexpected-native"));
    const missing = await f.run([], true);
    expect(missing.code).toBe(0);
    expect(missing.stdout).toContain("install the hack-next candidate");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a pruned nested worktree cannot take the containing main tree's identity", async () => {
  const f = await fixture(1);
  try {
    const main = join(f.checkout(0), "apps", "web");
    const deleted = join(f.checkout(0), "removed", "apps", "web");
    await mkdir(join(main, ".hack"), { recursive: true });
    await writeFile(
      join(main, ".hack", "docker-compose.yml"),
      "name: sample\nservices: {web: {image: web}}\n"
    );
    const path = join(f.root, "projects.json");
    const registry = JSON.parse(await readFile(path, "utf8"));
    Object.assign(registry.projects[0], {
      repoRoot: main,
      projectDir: join(main, ".hack"),
      worktrees: [
        {
          path: deleted,
          branch: "former",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    await writeFile(path, JSON.stringify(registry));
    await gitList(f.root, [[f.checkout(0), "main"]]);
    const result = await f.run(["--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.copies).toMatchObject([
      { branch: "main", checkout: { kind: "primary" }, instance: null },
      { branch: "former", checkout: { kind: "worktree" }, state: "unknown" },
    ]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
