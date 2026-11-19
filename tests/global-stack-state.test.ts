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
  containerReadableMode,
  describeUnreadableContainerPaths,
  ensureContainerReadable,
  unreadableContainerPaths,
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

  // A longer window (the logging stack's) is watched to its end too.
  sleeps.length = 0;
  expect(
    await watchStartedContainers({
      read: () => Promise.resolve([running("a")]),
      settleMs: 10_000,
      sleep,
    })
  ).toEqual([]);
  expect(sleeps).toHaveLength(20);

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

const T = {
  corefile: "corefile template\n",
  loki: "loki template\n",
  datasource: "datasource template\n",
  provisioning: "provisioning template\n",
  dashboard: "dashboard template\n",
};

function entries(home: string) {
  return containerReadableGlobalPaths({
    coreDnsConfig: { path: join(home, "Corefile"), template: T.corefile },
    lokiConfig: { path: join(home, "loki.yaml"), template: T.loki },
    grafanaDatasource: { path: join(home, "d.yaml"), template: T.datasource },
    grafanaDashboardsProvisioning: {
      path: join(home, "p.yaml"),
      template: T.provisioning,
    },
    grafanaDashboardsDir: join(home, "dashboards"),
    grafanaDashboard: {
      path: join(home, "dashboards/logs.json"),
      template: T.dashboard,
    },
  });
}

/** Writes all six paths with template content and owner-only modes. */
async function tightTemplates(home: string) {
  await mkdir(join(home, "dashboards"));
  for (const [name, text] of [
    ["Corefile", T.corefile],
    ["loki.yaml", T.loki],
    ["d.yaml", T.datasource],
    ["p.yaml", T.provisioning],
    ["dashboards/logs.json", T.dashboard],
  ] as const) {
    await writeFile(join(home, name), text);
    await chmod(join(home, name), 0o600);
  }
  await chmod(join(home, "dashboards"), 0o700);
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;

test("the container-readable list is closed: five files and one directory, nothing else", () => {
  const list = entries("/h");
  expect(list.map((entry) => [entry.path, entry.kind])).toEqual([
    ["/h/Corefile", "file"],
    ["/h/loki.yaml", "file"],
    ["/h/d.yaml", "file"],
    ["/h/p.yaml", "file"],
    ["/h/dashboards", "directory"],
    ["/h/dashboards/logs.json", "file"],
  ]);
  // Every reader is a container user other than root.
  for (const entry of list) {
    expect(entry.reader).toMatch(/nonroot|uid \d+/);
  }
  expect(containerReadableMode("file")).toBe(0o644);
  expect(containerReadableMode("directory")).toBe(0o755);
});

test("template content written owner-only is made readable, and a rerun changes nothing", async () => {
  root = await mkdtemp(join(tmpdir(), "hack-gcc-"));
  await tightTemplates(root);
  const first = await ensureContainerReadable(entries(root));
  expect(first.retained).toEqual([]);
  expect(first.changed).toHaveLength(6);
  for (const entry of entries(root)) {
    expect([entry.path, await mode(entry.path)]).toEqual([
      entry.path,
      entry.kind === "file" ? 0o644 : 0o755,
    ]);
  }
  expect(await ensureContainerReadable(entries(root))).toEqual({
    changed: [],
    retained: [],
  });
});

test("a customised config keeps its mode: Hack never widens content it does not know", async () => {
  root = await mkdtemp(join(tmpdir(), "hack-gcc-"));
  await tightTemplates(root);
  // The Codex finding: a datasource the user edited, with credentials, and
  // made private. `global install` keeps a differing file; so must its mode.
  const datasource = join(root, "d.yaml");
  await writeFile(datasource, "basicAuthPassword: hunter2\n");
  await chmod(datasource, 0o600);
  const result = await ensureContainerReadable(entries(root));
  expect(await mode(datasource)).toBe(0o600);
  expect(result.retained).toEqual([
    {
      path: datasource,
      kind: "file",
      mode: 0o600,
      reader: "Grafana (uid 472)",
    },
  ]);
  expect(result.changed).not.toContain(datasource);
  // The other five still hold Hack's content and are widened.
  expect(result.changed).toHaveLength(5);
  const message = describeUnreadableContainerPaths(result.retained);
  expect(message).toContain(`${datasource} (mode 600)`);
  expect(message).toContain(
    "never changes the permissions of one whose content you customised"
  );
  expect(message).toContain(`chmod 644 ${datasource}`);
});

test("the dashboards directory is opened only when it holds nothing but Hack's dashboard", async () => {
  // A second, private dashboard beside Hack's.
  root = await mkdtemp(join(tmpdir(), "hack-gcc-"));
  await tightTemplates(root);
  await writeFile(join(root, "dashboards/private.json"), "{}");
  await chmod(join(root, "dashboards/private.json"), 0o600);
  let result = await ensureContainerReadable(entries(root));
  expect(await mode(join(root, "dashboards"))).toBe(0o700);
  expect(await mode(join(root, "dashboards/private.json"))).toBe(0o600);
  expect(result.retained.map((entry) => [entry.path, entry.kind])).toEqual([
    [join(root, "dashboards"), "directory"],
  ]);
  expect(describeUnreadableContainerPaths(result.retained)).toContain(
    `chmod 755 ${join(root, "dashboards")}`
  );
  await rm(root, { recursive: true, force: true });

  // Hack's dashboard itself customised: neither it nor its directory.
  root = await mkdtemp(join(tmpdir(), "hack-gcc-"));
  await tightTemplates(root);
  await writeFile(join(root, "dashboards/logs.json"), '{"mine":true}');
  await chmod(join(root, "dashboards/logs.json"), 0o600);
  result = await ensureContainerReadable(entries(root));
  expect(await mode(join(root, "dashboards"))).toBe(0o700);
  expect(await mode(join(root, "dashboards/logs.json"))).toBe(0o600);
  expect(result.retained).toHaveLength(2);
});

test("links, wrong kinds, missing paths and already readable files are left alone", async () => {
  root = await mkdtemp(join(tmpdir(), "hack-gcc-"));
  await tightTemplates(root);
  // A link whose target has the template content: still the user's own
  // arrangement, and its target is not opened up.
  const target = join(root, "loki.real");
  await writeFile(target, T.loki);
  await chmod(target, 0o600);
  await rm(join(root, "loki.yaml"));
  await symlink(target, join(root, "loki.yaml"));
  // Already readable, with customised content: nothing to do or to report.
  await writeFile(join(root, "p.yaml"), "custom but public\n");
  await chmod(join(root, "p.yaml"), 0o644);
  await rm(join(root, "Corefile"));
  const result = await ensureContainerReadable(entries(root));
  expect(await mode(target)).toBe(0o600);
  expect(await mode(join(root, "p.yaml"))).toBe(0o644);
  expect(result.retained).toEqual([]);
  expect(result.changed.sort()).toEqual(
    [
      join(root, "d.yaml"),
      join(root, "dashboards"),
      join(root, "dashboards/logs.json"),
    ].sort()
  );
});

test("unreadable configs are named by mode alone, for the stopped-container message", async () => {
  root = await mkdtemp(join(tmpdir(), "hack-gcc-"));
  await tightTemplates(root);
  await chmod(join(root, "Corefile"), 0o644);
  const unreadable = await unreadableContainerPaths([
    { path: join(root, "Corefile"), kind: "file" },
    { path: join(root, "loki.yaml"), kind: "file" },
    { path: join(root, "dashboards"), kind: "directory" },
    { path: join(root, "missing"), kind: "file" },
  ]);
  expect(unreadable).toEqual([
    { path: join(root, "loki.yaml"), kind: "file", mode: 0o600 },
    { path: join(root, "dashboards"), kind: "directory", mode: 0o700 },
  ]);
  expect(describeUnreadableContainerPaths(unreadable)).toContain(
    "hack global install resets the mode of a config that still has Hack's own content."
  );
});
