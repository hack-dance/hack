import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  mergeLifecycleCommandEnv,
  wrapLifecyclePersistentCommand,
} from "../src/commands/project.ts";
import { readLifecycleState } from "../src/lib/lifecycle-runtime.ts";
import {
  collectDescendantProcessGroupIds,
  parseProcessSnapshotOutput,
  resolveLifecycleProcessGroupIdsForTmuxState,
  resolvePersistedLifecycleProcessGroupIds,
  resolveVerifiedPersistedLifecycleProcessGroupIdsForStop,
} from "../src/lib/project-lifecycle-processes.ts";

const tempDirs = new Set<string>();
const originalHome = process.env.HOME;

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
  process.env.HOME = originalHome;
});

test("readLifecycleState preserves lifecycle pane and process group metadata", async () => {
  const projectDir = await createLifecycleProjectDir();
  const statePath = resolve(projectDir, ".internal", "lifecycle", "state.json");

  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        entries: [
          {
            composeProject: "event-agent",
            projectName: "event-agent",
            branch: "feature-cleanup",
            sessionName: "event-agent--lifecycle-feature-cleanup",
            backend: "tmux",
            updatedAt: "2026-04-01T14:00:00.000Z",
            processes: [
              {
                name: "proxy",
                windowName: "proxy",
                logPath: "/tmp/event-agent.log",
                panePid: "12345",
                processGroupId: 67_890,
              },
            ],
          },
        ],
      },
      null,
      2
    )}\n`
  );

  const entries = await readLifecycleState({ projectDir });

  expect(entries).toHaveLength(1);
  expect(entries[0]?.processes).toEqual([
    {
      name: "proxy",
      windowName: "proxy",
      logPath: "/tmp/event-agent.log",
      panePid: 12_345,
      processGroupId: 67_890,
    },
  ]);
});

test("parseProcessSnapshotOutput ignores malformed rows", () => {
  expect(
    parseProcessSnapshotOutput(
      ["101 1 101", "bad row", "202 x 202", "303 101 303 extra", ""].join("\n")
    )
  ).toEqual([
    { pid: 101, ppid: 1, processGroupId: 101 },
    { pid: 303, ppid: 101, processGroupId: 303 },
  ]);
});

test("collectDescendantProcessGroupIds returns root and descendant groups once", () => {
  const groups = collectDescendantProcessGroupIds({
    snapshot: [
      { pid: 100, ppid: 1, processGroupId: 100 },
      { pid: 101, ppid: 100, processGroupId: 101 },
      { pid: 102, ppid: 100, processGroupId: 101 },
      { pid: 103, ppid: 101, processGroupId: 103 },
      { pid: 200, ppid: 1, processGroupId: 200 },
    ],
    rootPids: [100, 999, 100],
  });

  expect(groups).toEqual([100, 101, 103]);
});

test("resolveLifecycleProcessGroupIdsForTmuxState ignores stale persisted ids", () => {
  const groups = resolveLifecycleProcessGroupIdsForTmuxState({
    lifecycleEntry: {
      composeProject: "event-agent",
      projectName: "event-agent",
      branch: "feature-cleanup",
      sessionName: "event-agent--lifecycle-feature-cleanup",
      backend: "tmux",
      updatedAt: "2026-04-01T14:00:00.000Z",
      processes: [
        {
          name: "proxy",
          windowName: "proxy",
          logPath: "/tmp/event-agent.log",
          panePid: 99_999,
          processGroupId: 99_999,
        },
      ],
    },
    panePidsByWindow: new Map([["proxy", [100]]]),
    snapshot: [
      { pid: 100, ppid: 1, processGroupId: 100 },
      { pid: 101, ppid: 100, processGroupId: 101 },
      { pid: 99_999, ppid: 1, processGroupId: 99_999 },
    ],
  });

  expect(groups).toEqual([100, 101]);
});

test("resolveLifecycleProcessGroupIdsForTmuxState falls back to persisted live groups when panes disappear", () => {
  const groups = resolveLifecycleProcessGroupIdsForTmuxState({
    lifecycleEntry: {
      composeProject: "event-agent",
      projectName: "event-agent",
      branch: "feature-cleanup",
      sessionName: "event-agent--lifecycle-feature-cleanup",
      backend: "tmux",
      updatedAt: "2026-04-01T14:00:00.000Z",
      processes: [
        {
          name: "proxy",
          windowName: "proxy",
          logPath: "/tmp/event-agent.log",
          panePid: 500,
          processGroupId: 500,
        },
      ],
    },
    panePidsByWindow: new Map([["proxy", []]]),
    snapshot: [
      { pid: 500, ppid: 1, processGroupId: 500 },
      { pid: 501, ppid: 500, processGroupId: 501 },
    ],
  });

  expect(groups).toEqual([500, 501]);
});

test("resolveLifecycleProcessGroupIdsForTmuxState ignores recycled process groups without a live pane pid", () => {
  const groups = resolveLifecycleProcessGroupIdsForTmuxState({
    lifecycleEntry: {
      composeProject: "event-agent",
      projectName: "event-agent",
      branch: "feature-cleanup",
      sessionName: "event-agent--lifecycle-feature-cleanup",
      backend: "tmux",
      updatedAt: "2026-04-01T14:00:00.000Z",
      processes: [
        {
          name: "proxy",
          windowName: "proxy",
          logPath: "/tmp/event-agent.log",
          panePid: 9999,
          processGroupId: 500,
        },
      ],
    },
    panePidsByWindow: new Map([["proxy", []]]),
    snapshot: [{ pid: 700, ppid: 1, processGroupId: 500 }],
  });

  expect(groups).toEqual([]);
});

test("resolvePersistedLifecycleProcessGroupIds recovers live groups without a mux session", () => {
  const groups = resolvePersistedLifecycleProcessGroupIds({
    lifecycleEntry: {
      composeProject: "event-agent",
      projectName: "event-agent",
      branch: "feature-cleanup",
      sessionName: "event-agent--lifecycle-feature-cleanup",
      backend: "tmux",
      updatedAt: "2026-04-01T14:00:00.000Z",
      processes: [
        {
          name: "proxy",
          windowName: "proxy",
          logPath: "/tmp/event-agent.log",
          panePid: 500,
          processGroupId: 500,
        },
      ],
    },
    snapshot: [
      { pid: 500, ppid: 1, processGroupId: 500 },
      { pid: 501, ppid: 500, processGroupId: 501 },
    ],
  });

  expect(groups).toEqual([500, 501]);
});

test("resolveVerifiedPersistedLifecycleProcessGroupIdsForStop skips stale persisted groups without a live session", () => {
  const groups = resolveVerifiedPersistedLifecycleProcessGroupIdsForStop({
    lifecycleEntry: {
      composeProject: "event-agent",
      projectName: "event-agent",
      branch: "feature-cleanup",
      sessionName: "event-agent--lifecycle-feature-cleanup",
      backend: "tmux",
      updatedAt: "2026-04-01T14:00:00.000Z",
      processes: [
        {
          name: "proxy",
          windowName: "proxy",
          logPath: "/tmp/event-agent.log",
          panePid: 500,
          processGroupId: 500,
        },
      ],
    },
    snapshot: [
      { pid: 500, ppid: 1, processGroupId: 500 },
      { pid: 501, ppid: 500, processGroupId: 501 },
    ],
    hasVerifiedSession: false,
  });

  expect(groups).toEqual([]);
});

test("resolveVerifiedPersistedLifecycleProcessGroupIdsForStop keeps verified persisted groups", () => {
  const groups = resolveVerifiedPersistedLifecycleProcessGroupIdsForStop({
    lifecycleEntry: {
      composeProject: "event-agent",
      projectName: "event-agent",
      branch: "feature-cleanup",
      sessionName: "event-agent--lifecycle-feature-cleanup",
      backend: "tmux",
      updatedAt: "2026-04-01T14:00:00.000Z",
      processes: [
        {
          name: "proxy",
          windowName: "proxy",
          logPath: "/tmp/event-agent.log",
          panePid: 500,
          processGroupId: 500,
        },
      ],
    },
    snapshot: [
      { pid: 500, ppid: 1, processGroupId: 500 },
      { pid: 501, ppid: 500, processGroupId: 501 },
    ],
    hasVerifiedSession: true,
  });

  expect(groups).toEqual([500, 501]);
});

test("wrapLifecyclePersistentCommand uses external kill for process-group cleanup", () => {
  const script = wrapLifecyclePersistentCommand({
    command: "bun run proxy",
    logPath: "/tmp/event-agent.log",
    serviceName: "proxy",
  });

  expect(script).toContain('/bin/kill -TERM -- "-$cmd_pid"');
  expect(script).toContain('/usr/bin/kill -TERM -- "-$cmd_pid"');
  expect(script).not.toContain(
    'kill -TERM -- "-$cmd_pid" 2>/dev/null || kill "$cmd_pid" 2>/dev/null || true'
  );
});

test("wrapLifecyclePersistentCommand avoids login-shell execution", () => {
  const script = wrapLifecyclePersistentCommand({
    command: "bun run proxy",
    logPath: "/tmp/event-agent.log",
    serviceName: "proxy",
  });

  expect(script).toContain('os.execvp("sh", ["sh", "-c", sys.argv[1]])');
  expect(script).toContain('sh -c "$HACK_LIFECYCLE_COMMAND" >"$fifo" 2>&1 &');
  expect(script).not.toContain('os.execvp("sh", ["sh", "-lc", sys.argv[1]])');
  expect(script).not.toContain(
    'sh -lc "$HACK_LIFECYCLE_COMMAND" >"$fifo" 2>&1 &'
  );
});

test("mergeLifecycleCommandEnv appends local Hack CA trust for host processes", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "hack-home-"));
  tempDirs.add(homeRoot);
  process.env.HOME = homeRoot;

  const caDir = resolve(homeRoot, ".hack", "caddy", "pki");
  await mkdir(caDir, { recursive: true });
  await writeFile(resolve(caDir, "caddy-local-authority.crt"), "local-ca\n");
  await writeFile(
    resolve(caDir, "caddy-host-trust-bundle.pem"),
    "system-ca\nlocal-ca\n"
  );

  const merged = await mergeLifecycleCommandEnv({
    APP_ENV: "dev",
  });

  expect(merged).toMatchObject({
    APP_ENV: "dev",
    CURL_CA_BUNDLE: resolve(caDir, "caddy-host-trust-bundle.pem"),
    GIT_SSL_CAINFO: resolve(caDir, "caddy-host-trust-bundle.pem"),
    HACK_HOST_TRUST_BUNDLE: resolve(caDir, "caddy-host-trust-bundle.pem"),
    HACK_LOCAL_CA_CERT: resolve(caDir, "caddy-local-authority.crt"),
    NODE_EXTRA_CA_CERTS: resolve(caDir, "caddy-local-authority.crt"),
    REQUESTS_CA_BUNDLE: resolve(caDir, "caddy-host-trust-bundle.pem"),
    SSL_CERT_FILE: resolve(caDir, "caddy-host-trust-bundle.pem"),
  });
});

test("mergeLifecycleCommandEnv preserves explicit TLS env values", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "hack-home-"));
  tempDirs.add(homeRoot);
  process.env.HOME = homeRoot;

  const caDir = resolve(homeRoot, ".hack", "caddy", "pki");
  await mkdir(caDir, { recursive: true });
  await writeFile(resolve(caDir, "caddy-local-authority.crt"), "local-ca\n");
  await writeFile(
    resolve(caDir, "caddy-host-trust-bundle.pem"),
    "system-ca\nlocal-ca\n"
  );

  const merged = await mergeLifecycleCommandEnv({
    APP_ENV: "dev",
    NODE_EXTRA_CA_CERTS: "/tmp/custom-extra.pem",
    SSL_CERT_FILE: "/tmp/custom-bundle.pem",
  });

  expect(merged).toMatchObject({
    APP_ENV: "dev",
    CURL_CA_BUNDLE: resolve(caDir, "caddy-host-trust-bundle.pem"),
    GIT_SSL_CAINFO: resolve(caDir, "caddy-host-trust-bundle.pem"),
    HACK_HOST_TRUST_BUNDLE: resolve(caDir, "caddy-host-trust-bundle.pem"),
    HACK_LOCAL_CA_CERT: resolve(caDir, "caddy-local-authority.crt"),
    NODE_EXTRA_CA_CERTS: "/tmp/custom-extra.pem",
    REQUESTS_CA_BUNDLE: resolve(caDir, "caddy-host-trust-bundle.pem"),
    SSL_CERT_FILE: "/tmp/custom-bundle.pem",
  });
});

async function createLifecycleProjectDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-lifecycle-processes-"));
  tempDirs.add(root);
  const projectDir = resolve(root, ".hack");

  await mkdir(resolve(projectDir, ".internal", "lifecycle"), {
    recursive: true,
  });

  return projectDir;
}
