import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  containerReadableGlobalPaths,
  ensureContainerReadable,
} from "../src/lib/global-container-config.ts";
import {
  containersNotRunning,
  describeContainersNotRunning,
  type GlobalContainerState,
  parseComposePs,
  watchStartedContainers,
} from "../src/lib/global-stack-state.ts";

/*
 * HACK-2381: `hack global install` reported "Global infra is up" while
 * CoreDNS, Loki and Grafana had exited, because their bind-mounted configs
 * were written owner-only under a strict umask.
 */

const running = (name: string): GlobalContainerState => ({
  name,
  service: name,
  state: "running",
  exitCode: 0,
});

test("compose ps output is parsed line by line or as one array; noise is ignored", () => {
  const lines = [
    '{"Name":"hack-dev-proxy-caddy-1","Service":"caddy","State":"running","ExitCode":0}',
    "time=now level=warning msg=noise",
    '{"Name":"hack-dev-proxy-coredns-1","Service":"coredns","State":"exited","ExitCode":1}',
  ].join("\n");
  expect(parseComposePs(lines)).toEqual([
    {
      name: "hack-dev-proxy-caddy-1",
      service: "caddy",
      state: "running",
      exitCode: 0,
    },
    {
      name: "hack-dev-proxy-coredns-1",
      service: "coredns",
      state: "exited",
      exitCode: 1,
    },
  ]);
  expect(
    parseComposePs(
      '[{"Name":"a","Service":"s","State":"running","ExitCode":0}]'
    )
  ).toEqual([{ name: "a", service: "s", state: "running", exitCode: 0 }]);
  for (const nothing of ["", "\n", "not json", '{"State":"running"}', "[]"]) {
    expect(parseComposePs(nothing)).toEqual([]);
  }
});

test("only `running` counts as running, and the report names each container", () => {
  const containers: GlobalContainerState[] = [
    running("hack-logging-alloy-1"),
    {
      name: "hack-logging-loki-1",
      service: "loki",
      state: "exited",
      exitCode: 1,
    },
    {
      name: "hack-logging-grafana-1",
      service: "grafana",
      state: "restarting",
      exitCode: null,
    },
    { name: "x-created-1", service: "x", state: "created", exitCode: 0 },
  ];
  const stopped = containersNotRunning(containers);
  expect(stopped.map((container) => container.name)).toEqual([
    "hack-logging-loki-1",
    "hack-logging-grafana-1",
    "x-created-1",
  ]);
  const message = describeContainersNotRunning({
    stack: "The logging stack (Grafana, Loki, Alloy)",
    containers: stopped.slice(0, 2),
  });
  expect(message).toContain(
    "The logging stack (Grafana, Loki, Alloy) started, but these containers are not running: hack-logging-loki-1 (exited, exit code 1), hack-logging-grafana-1 (restarting)."
  );
  expect(message).toContain("docker logs --tail 50 hack-logging-loki-1");
  expect(message).toContain("docker logs --tail 50 hack-logging-grafana-1");
  expect(
    describeContainersNotRunning({
      stack: "X",
      containers: stopped.slice(0, 1),
    })
  ).toContain("X started, but this container is not running: ");
});

test("the watch fails as soon as a container is seen stopped, and passes only after the whole window", async () => {
  const sleeps: number[] = [];
  const sleep = (ms: number) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  // Healthy: looked at for the whole window.
  let looks = 0;
  expect(
    await watchStartedContainers({
      read: () => {
        looks++;
        return Promise.resolve([running("a"), running("b")]);
      },
      sleep,
    })
  ).toEqual([]);
  expect(looks).toBe(5);
  expect(sleeps).toEqual([500, 500, 500, 500]);

  // A container that starts and exits a second later is caught then.
  sleeps.length = 0;
  looks = 0;
  const stopped = await watchStartedContainers({
    read: () => {
      looks++;
      return Promise.resolve([
        running("a"),
        looks < 3
          ? running("b")
          : { name: "b", service: "b", state: "exited", exitCode: 1 },
      ]);
    },
    sleep,
  });
  expect(stopped.map((container) => container.name)).toEqual(["b"]);
  expect(sleeps).toEqual([500, 500]);

  // No answer is not a finding, and costs no wait.
  sleeps.length = 0;
  expect(
    await watchStartedContainers({ read: () => Promise.resolve([]), sleep })
  ).toEqual([]);
  expect(sleeps).toEqual([]);
});

let root: string | null = null;
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

test("the container-readable list is closed: five files and one directory, nothing else", () => {
  const entries = containerReadableGlobalPaths({
    coreDnsConfig: "/h/caddy/Corefile",
    lokiConfig: "/h/logging/loki.yaml",
    grafanaDatasource: "/h/logging/grafana/provisioning/datasources/d.yaml",
    grafanaDashboardsProvisioning:
      "/h/logging/grafana/provisioning/dashboards/p.yaml",
    grafanaDashboardsDir: "/h/logging/grafana/dashboards",
    grafanaDashboard: "/h/logging/grafana/dashboards/logs.json",
  });
  expect(
    entries.map((entry) => [entry.path, entry.kind, entry.mode.toString(8)])
  ).toEqual([
    ["/h/caddy/Corefile", "file", "644"],
    ["/h/logging/loki.yaml", "file", "644"],
    ["/h/logging/grafana/provisioning/datasources/d.yaml", "file", "644"],
    ["/h/logging/grafana/provisioning/dashboards/p.yaml", "file", "644"],
    ["/h/logging/grafana/dashboards", "directory", "755"],
    ["/h/logging/grafana/dashboards/logs.json", "file", "644"],
  ]);
  // Every reader is a container user other than root.
  for (const entry of entries) {
    expect(entry.reader).toMatch(/nonroot|uid \d+/);
  }
});

test("modes are set only on listed paths that exist as the expected kind", async () => {
  root = await mkdtemp(join(tmpdir(), "hack-gcc-"));
  const file = join(root, "tight.yaml");
  const directory = join(root, "tight-dir");
  const fine = join(root, "fine.yaml");
  const target = join(root, "secret-target");
  const link = join(root, "link.yaml");
  const unlisted = join(root, "unlisted");
  await writeFile(file, "a");
  await chmod(file, 0o600);
  await mkdir(directory);
  await chmod(directory, 0o700);
  await writeFile(fine, "b");
  await chmod(fine, 0o644);
  await writeFile(target, "c");
  await chmod(target, 0o600);
  await symlink(target, link);
  await writeFile(unlisted, "d");
  await chmod(unlisted, 0o600);
  const mode = async (path: string) => (await stat(path)).mode & 0o777;

  const changed = await ensureContainerReadable([
    { path: file, kind: "file", mode: 0o644, reader: "x" },
    { path: directory, kind: "directory", mode: 0o755, reader: "x" },
    { path: fine, kind: "file", mode: 0o644, reader: "x" },
    // A link is the user's own arrangement: its target is not opened up.
    { path: link, kind: "file", mode: 0o644, reader: "x" },
    // A directory where a file is expected, and a missing path, are skipped.
    { path: directory, kind: "file", mode: 0o644, reader: "x" },
    { path: join(root, "missing"), kind: "file", mode: 0o644, reader: "x" },
  ]);
  expect(changed).toEqual([file, directory]);
  expect(await mode(file)).toBe(0o644);
  expect(await mode(directory)).toBe(0o755);
  expect(await mode(fine)).toBe(0o644);
  expect(await mode(target)).toBe(0o600);
  expect(await mode(unlisted)).toBe(0o600);
});
