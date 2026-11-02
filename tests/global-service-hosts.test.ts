import { expect, test } from "bun:test";
import { resolveOpenUrl } from "../src/commands/project.ts";
import {
  DEFAULT_GRAFANA_HOST,
  DEFAULT_LOKI_HOST,
  DEFAULT_PROJECT_TLD,
  DEFAULT_SCHEMAS_HOST,
} from "../src/constants.ts";
import { BRANCHES_SCHEMA_URL } from "../src/lib/branches.ts";

test("preferred global URLs do not change legacy project fallback", () => {
  expect([
    DEFAULT_GRAFANA_HOST,
    DEFAULT_LOKI_HOST,
    DEFAULT_SCHEMAS_HOST,
  ]).toEqual(["logs.hack.local", "loki.hack.local", "schemas.hack.local"]);
  expect(DEFAULT_PROJECT_TLD).toBe("hack");
  expect(BRANCHES_SCHEMA_URL).toBe(
    "https://schemas.hack.local/hack.branches.schema.json"
  );
  expect(
    resolveOpenUrl({ targetRaw: "logs", resolvedHost: "ignored.example" })
  ).toBe("https://logs.hack.local");
  for (const url of ["https://logs.hack", "https://custom.example/path"]) {
    expect(
      resolveOpenUrl({ targetRaw: url, resolvedHost: "ignored.example" })
    ).toBe(url);
  }
  expect(
    resolveOpenUrl({ targetRaw: "api", resolvedHost: "api.custom.example" })
  ).toBe("https://api.custom.example");
});

test("installed route selection preserves old, dual and explicit unknown states", async () => {
  const { selectGlobalGrafanaHost, resolveInstalledGrafanaHost } = await import(
    "../src/lib/global-service-host.ts"
  );
  const source = (route: string) =>
    `services:\n  grafana:\n    labels:\n      caddy: ${route}\n`;
  expect(selectGlobalGrafanaHost(source("logs.hack"))).toBe("logs.hack");
  expect(selectGlobalGrafanaHost(source("logs.hack.local, logs.hack"))).toBe(
    "logs.hack.local"
  );
  expect(selectGlobalGrafanaHost(source("custom.example"))).toBeNull();
  expect(selectGlobalGrafanaHost("services: [")).toBeNull();
  expect(selectGlobalGrafanaHost(source("${HOST}"))).toBeNull();
  expect(
    await resolveInstalledGrafanaHost({ root: "/nonexistent-hack-test-global" })
  ).toBeNull();
  expect(
    resolveOpenUrl({
      targetRaw: "logs",
      resolvedHost: "unused",
      grafanaHost: "logs.hack",
    })
  ).toBe("https://logs.hack");
});

test("installed logging file selects existing routes without modifying files", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveInstalledGrafanaHost } = await import(
    "../src/lib/global-service-host.ts"
  );
  const { GLOBAL_LOGGING_DIR_NAME, GLOBAL_LOGGING_COMPOSE_FILENAME } =
    await import("../src/constants.ts");
  const root = await mkdtemp(join(tmpdir(), "global-host-selection-"));
  try {
    await mkdir(join(root, GLOBAL_LOGGING_DIR_NAME));
    const path = join(
      root,
      GLOBAL_LOGGING_DIR_NAME,
      GLOBAL_LOGGING_COMPOSE_FILENAME
    );
    for (const [route, expected] of [
      ["logs.hack", "logs.hack"],
      ["logs.hack.local, logs.hack", "logs.hack.local"],
      ["custom.example", null],
    ] as const) {
      const source = `services:\n  grafana:\n    labels:\n      - caddy=${route}\n`;
      await writeFile(path, source);
      expect(await resolveInstalledGrafanaHost({ root })).toBe(expected);
      expect(await readFile(path, "utf8")).toBe(source);
    }
    await writeFile(path, "invalid: [");
    expect(await resolveInstalledGrafanaHost({ root })).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "installed logging FIFO refuses without waiting for a writer",
  async () => {
    const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const { GLOBAL_LOGGING_DIR_NAME, GLOBAL_LOGGING_COMPOSE_FILENAME } =
      await import("../src/constants.ts");
    const root = await mkdtemp(join(tmpdir(), "global-host-fifo-"));
    try {
      await mkdir(join(root, GLOBAL_LOGGING_DIR_NAME));
      const fifo = join(
        root,
        GLOBAL_LOGGING_DIR_NAME,
        GLOBAL_LOGGING_COMPOSE_FILENAME
      );
      const maker = Bun.spawn(["mkfifo", fifo], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await maker.exited).toBe(0);
      const modulePath = resolve(
        import.meta.dir,
        "../src/lib/global-service-host.ts"
      );
      const script =
        "const {resolveInstalledGrafanaHost} = await import(process.argv[1]); process.exit((await resolveInstalledGrafanaHost({root:process.argv[2]})) === null ? 0 : 1);";
      const child = Bun.spawn(
        [process.execPath, "-e", script, modulePath, root],
        { stdout: "ignore", stderr: "ignore" }
      );
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 3000);
      try {
        expect(await child.exited).toBe(0);
        expect(timedOut).toBe(false);
      } finally {
        clearTimeout(timer);
        child.kill("SIGKILL");
        await child.exited;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
