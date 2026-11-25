import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  countJsonValues,
  globalContainersVerdict,
  groupWritableAncestors,
  installedLauncher,
  noComposeDockerScript,
  noComposeInstallVerdict,
  parseCheckArgs,
  pathWithoutHack,
  renderStepTable,
} from "../scripts/linux-first-run-check.ts";

test("the no-Compose docker wrapper rejects only compose and runs the real CLI otherwise (HACK-2673)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "first-run-no-compose-"));
  try {
    // A stand-in for the real docker, at a path that needs quoting.
    const real = join(dir, "real docker's bin");
    await writeFile(real, '#!/bin/sh\necho "real $*"\n', { mode: 0o700 });
    const wrapper = join(dir, "docker");
    await writeFile(wrapper, noComposeDockerScript(real), { mode: 0o700 });
    const run = (args: string[]) =>
      Bun.spawnSync([wrapper, ...args], { stdout: "pipe", stderr: "pipe" });
    const compose = run(["compose", "version"]);
    expect(compose.exitCode).toBe(1);
    expect(compose.stderr.toString()).toContain(
      "'compose' is not a docker command"
    );
    const info = run(["info", "--format", "x y"]);
    expect(info.exitCode).toBe(0);
    expect(info.stdout.toString()).toBe("real info --format x y\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the no-Compose install passes only when it names the plugin and not the ports (HACK-2673)", () => {
  const refusal =
    "E_DOCKER_UNAVAILABLE: Docker is running, but `docker compose version` failed: Hack needs the Docker Compose v2 plugin.\n";
  expect(
    noComposeInstallVerdict({ exit: 1, stdout: "", stderr: refusal })
  ).toEqual({
    ok: true,
    note: "E_DOCKER_UNAVAILABLE names the Compose plugin",
  });
  expect(
    noComposeInstallVerdict({
      exit: 1,
      stdout: "",
      stderr: `${refusal}The proxy could not start on ports 80 and 443.\n`,
    })
  ).toEqual({ ok: false, note: "blamed ports 80/443" });
  // The listener-naming message and the setting count as blaming the ports.
  expect(
    noComposeInstallVerdict({
      exit: 1,
      stdout: "",
      stderr: `${refusal}The proxy cannot publish ports 80 and 443: 10.8.0.2:443 is already in use by vpn-client.\n`,
    })
  ).toEqual({ ok: false, note: "blamed ports 80/443" });
  expect(
    noComposeInstallVerdict({
      exit: 1,
      stdout: "",
      stderr: `${refusal}Set proxy.bind_address to publish on one address.\n`,
    })
  ).toEqual({ ok: false, note: "blamed ports 80/443" });
  expect(noComposeInstallVerdict({ exit: 0, stdout: "", stderr: "" }).ok).toBe(
    false
  );
  expect(
    noComposeInstallVerdict({ exit: 1, stdout: "", stderr: "boom\n" }).note
  ).toContain("did not name the plugin");
});

test("the no-Compose install runs after the real install, so that one starts from a fresh HOME (HACK-2673)", async () => {
  const source = await Bun.file(
    join(import.meta.dir, "..", "scripts", "linux-first-run-check.ts")
  ).text();
  const body = source.slice(source.indexOf("async function globalSetup("));
  const realInstall = body.indexOf('"2 global install",');
  const noCompose = body.indexOf("await composePluginMissingStep(run);");
  expect(realInstall).toBeGreaterThan(0);
  expect(noCompose).toBeGreaterThan(realInstall);
  // Called once, from globalSetup only.
  expect(source.split("await composePluginMissingStep(run);").length).toBe(2);
});

test("counts one document, line-delimited values, and refuses garbage", () => {
  expect(countJsonValues('{\n  "ok": true\n}\n')).toBe(1);
  expect(
    countJsonValues('{"type":"start"}\n{"type":"log"}\n{"type":"end"}\n')
  ).toBe(3);
  expect(countJsonValues("")).toBe(0);
  expect(countJsonValues('{"ok":true}\nSTEP: noise\n')).toBeNull();
});

test("requires absolute --hack and --scratch and a bounded one-shot", () => {
  expect(parseCheckArgs(["--hack", "/x/hack", "--scratch", "/tmp/s"])).toEqual({
    hack: "/x/hack",
    scratch: "/tmp/s",
    oneShotSeconds: 150,
    reuseGlobalStack: false,
    keep: false,
  });
  expect(() =>
    parseCheckArgs(["--hack", "hack", "--scratch", "/tmp/s"])
  ).toThrow("absolute");
  expect(() =>
    parseCheckArgs([
      "--hack",
      "/x",
      "--scratch",
      "/s",
      "--one-shot-seconds",
      "0",
    ])
  ).toThrow("1..1500");
  expect(() =>
    parseCheckArgs([
      "--hack",
      "/x",
      "--scratch",
      "/s",
      "--one-shot-seconds",
      "1501",
    ])
  ).toThrow("1..1500");
  expect(
    parseCheckArgs([
      "--hack",
      "/x",
      "--scratch",
      "/s",
      "--one-shot-seconds",
      "1500",
    ]).oneShotSeconds
  ).toBe(1500);
  expect(() => parseCheckArgs(["--sudo"])).toThrow("Unknown argument");
});

test("renders one Markdown row per step with pipes escaped", () => {
  const table = renderStepTable([
    {
      step: "3 ps --json",
      command: "hack ps --json",
      exit: 0,
      seconds: 0.42,
      result: "pass",
      note: "a | b",
    },
    {
      step: "0 preflight",
      command: "docker info",
      exit: null,
      seconds: 0,
      result: "fail",
      note: "refused",
    },
  ]);
  expect(table.split("\n")).toEqual([
    "| Step | Command | Exit | Seconds | Result | Note |",
    "| --- | --- | --- | --- | --- | --- |",
    "| 3 ps --json | `hack ps --json` | 0 | 0.4 | pass | a \\| b |",
    "| 0 preflight | `docker info` | - | 0.0 | fail | refused |",
  ]);
});

test("drops PATH entries that hold a hack so the CLI under test is the one re-invoked", () => {
  expect(
    pathWithoutHack(
      "/opt/hack/bin:/usr/bin::/opt/tools/.hack/bin",
      (file) =>
        file.endsWith("/opt/hack/bin/hack") || file.endsWith("/.hack/bin/hack")
    )
  ).toEqual({
    path: "/usr/bin",
    dropped: ["/opt/hack/bin", "/opt/tools/.hack/bin"],
  });
});

test("reports scratch ancestors other users can write, ignoring sticky ones", async () => {
  const { mkdtemp, mkdir, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "hack-frc-"));
  try {
    const shared = join(root, "shared");
    const sticky = join(shared, "sticky");
    await mkdir(join(sticky, "scratch"), { recursive: true });
    await chmod(root, 0o700);
    await chmod(shared, 0o775);
    await chmod(sticky, 0o1777);
    await chmod(join(sticky, "scratch"), 0o700);
    // Only paths at or below the test root are asserted: what lies above it
    // depends on the runner's TMPDIR.
    const found = groupWritableAncestors(join(sticky, "scratch", "new")).filter(
      (dir) => dir === root || dir.startsWith(`${root}/`)
    );
    expect(found).toEqual([shared]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer mode installs under the check's HOME and validates its local inputs", () => {
  const digest = "a".repeat(64);
  // The installer's default root, in the HOME the check creates under scratch.
  const launcher = ["/tmp/s", "home", ".hack-next", "bin", "hack-next"].join(
    "/"
  );
  expect(installedLauncher("/tmp/s")).toBe(launcher);
  expect(
    parseCheckArgs(["--installer", "/x/install.sh", "--scratch", "/tmp/s"])
  ).toEqual({
    hack: launcher,
    scratch: "/tmp/s",
    oneShotSeconds: 150,
    reuseGlobalStack: false,
    keep: false,
    installer: { path: "/x/install.sh" },
  });
  expect(
    parseCheckArgs([
      "--scratch",
      "/tmp/s",
      "--installer",
      "/x/install.sh",
      "--archive",
      "/x/bundle.tar.gz",
      "--sha256",
      digest,
      "--manager",
      "/x/manager",
      "--reuse-global-stack",
    ]).installer
  ).toEqual({
    path: "/x/install.sh",
    archive: "/x/bundle.tar.gz",
    sha256: digest,
    manager: "/x/manager",
  });
  for (const [args, message] of [
    [["--installer", "/x/i.sh", "--hack", "/x/hack"], "not both"],
    [["--installer", "i.sh"], "--installer with an absolute path"],
    [
      ["--hack", "/x/hack", "--archive", "/x/a", "--sha256", digest],
      "need --installer",
    ],
    [["--installer", "/x/i.sh", "--archive", "/x/a"], "go together"],
    [["--installer", "/x/i.sh", "--sha256", digest], "go together"],
    [
      ["--installer", "/x/i.sh", "--archive", "a", "--sha256", digest],
      "absolute paths",
    ],
    [
      ["--installer", "/x/i.sh", "--archive", "/x/a", "--sha256", "ABC"],
      "lowercase SHA-256",
    ],
    [["--installer", "/x/i.sh", "--manager", "manager"], "absolute paths"],
  ] as const) {
    expect(() => parseCheckArgs([...args, "--scratch", "/tmp/s"])).toThrow(
      message
    );
  }
});

test("every global container the logging choice asks for must be running, and the note names the ones that are not (HACK-2381)", () => {
  const proxy = [
    "hack-dev-proxy hack-dev-proxy-caddy-1 running",
    "hack-dev-proxy hack-dev-proxy-coredns-1 running",
    "lq-abc123 lq-abc123-web-1 exited",
  ];
  const all = [
    ...proxy,
    "hack-logging hack-logging-loki-1 running",
    "hack-logging hack-logging-alloy-1 running",
    "hack-logging hack-logging-grafana-1 running",
  ];
  expect(globalContainersVerdict(all.join("\n"), { logging: "on" })).toEqual({
    ok: true,
    note: "all 5 global containers running, logging on",
  });
  // The state the release shipped in: Caddy and Alloy up, the three
  // non-root containers exited. The Caddy-only proxy step passed on it.
  const shipped = all
    .join("\n")
    .replace("coredns-1 running", "coredns-1 exited")
    .replace("loki-1 running", "loki-1 exited")
    .replace("grafana-1 running", "grafana-1 exited");
  expect(globalContainersVerdict(shipped, { logging: "on" })).toEqual({
    ok: false,
    note: "not as expected: hack-dev-proxy-coredns-1 exited, hack-logging-loki-1 exited, hack-logging-grafana-1 exited",
  });
  expect(
    globalContainersVerdict(all.slice(0, 5).join("\n"), { logging: "on" })
  ).toEqual({
    ok: false,
    note: "not as expected: hack-logging-grafana-1 missing",
  });
  expect(globalContainersVerdict("", { logging: "on" }).ok).toBe(false);
  // Logging is opt-in: the proxy alone is the default, stopped logging
  // containers may stay behind, and a running one is a failure.
  expect(globalContainersVerdict(proxy.join("\n"), { logging: "off" })).toEqual(
    { ok: true, note: "all 2 global containers running, logging off" }
  );
  expect(
    globalContainersVerdict(
      all.join("\n").replaceAll(/(hack-logging-\S+) running/g, "$1 exited"),
      { logging: "off" }
    ).ok
  ).toBe(true);
  expect(globalContainersVerdict(all.join("\n"), { logging: "off" })).toEqual({
    ok: false,
    note: "not as expected: hack-logging-loki-1 running with logging off, hack-logging-alloy-1 running with logging off, hack-logging-grafana-1 running with logging off",
  });
  expect(globalContainersVerdict(shipped, { logging: "off" }).note).toContain(
    "hack-dev-proxy-coredns-1 exited"
  );
});
