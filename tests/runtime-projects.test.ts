import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

let dockerAvailable = false;
let currentIds: string[] = [];
let inspectExitCode = 0;
const inspectCalls: string[][] = [];

const shellMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/shell.ts",
  overrides: {
    exec: async (command: readonly string[]) => {
      if (command[1] === "ps") {
        return {
          stdout: currentIds
            .map((id) => JSON.stringify(makePsRow({ id })))
            .join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      if (command[1] === "inspect") {
        const ids = [...command.slice(2)];
        inspectCalls.push(ids);
        const returnedIds = inspectExitCode === 0 ? ids : ids.slice(0, 1);
        return {
          stdout: JSON.stringify(
            returnedIds.map((id) => makeInspectRow({ id }))
          ),
          stderr:
            inspectExitCode === 0 ? "" : "one inspected container disappeared",
          exitCode: inspectExitCode,
        };
      }
      throw new Error(`unexpected command: ${command.join(" ")}`);
    },
    findExecutableInPath: (executableName: string) =>
      executableName === "docker" && !dockerAvailable ? null : executableName,
  },
});

const {
  createRuntimeInspectCache,
  getRuntimeInspectCacheDiagnostics,
  readRuntimeProjects,
} = await import("../src/lib/runtime-projects.ts");

beforeAll(() => {
  shellMock.activate();
});

beforeEach(() => {
  dockerAvailable = false;
  currentIds = [];
  inspectExitCode = 0;
  inspectCalls.length = 0;
});

afterAll(() => {
  shellMock.deactivate();
});

test("readRuntimeProjects reports docker absence instead of throwing", async () => {
  const result = await readRuntimeProjects({ includeGlobal: false });

  expect(result.ok).toBe(false);
  expect(result.runtime).toEqual([]);
  expect(result.error).toBe("docker is not installed or not on PATH");
});

test("runtime inspect cache reuses unchanged IDs and reconciles replacements", async () => {
  dockerAvailable = true;
  const firstId = "aaaaaaaaaaaa";
  const replacedId = "bbbbbbbbbbbb";
  const replacementId = "cccccccccccc";
  currentIds = [firstId, replacedId];
  const inspectCache = createRuntimeInspectCache();

  await readRuntimeProjects({
    includeGlobal: true,
    inspectCache,
    forceInspect: true,
  });
  await readRuntimeProjects({
    includeGlobal: true,
    inspectCache,
    forceInspect: false,
  });
  currentIds = [firstId, replacementId];
  await readRuntimeProjects({
    includeGlobal: true,
    inspectCache,
    forceInspect: false,
  });
  await readRuntimeProjects({
    includeGlobal: true,
    inspectCache,
    forceInspect: true,
  });

  expect(inspectCalls).toEqual([
    [firstId, replacedId],
    [replacementId],
    [firstId, replacementId],
  ]);
  expect([...inspectCache.entries.keys()]).toEqual([firstId, replacementId]);
  expect(getRuntimeInspectCacheDiagnostics({ cache: inspectCache })).toEqual({
    inspectCalls: 3,
    inspectIds: 5,
    cacheHits: 3,
    cacheMisses: 3,
    fullRefreshes: 2,
  });
});

test("runtime inspection keeps valid stdout when another container disappears", async () => {
  dockerAvailable = true;
  currentIds = ["aaaaaaaaaaaa", "missing00000"];
  inspectExitCode = 1;

  const result = await readRuntimeProjects({ includeGlobal: true });

  expect(result.ok).toBe(true);
  const app = result.runtime[0]?.services.get("service-aaaaaaaaaaaa");
  expect(app?.containers[0]?.image).toBe("image:aaaaaaaaaaaa");
  expect(app?.containers[0]?.networks[0]?.name).toBe("hack-dev");
});

function makePsRow(opts: { readonly id: string }): Record<string, string> {
  return {
    ID: opts.id,
    State: "running",
    Status: "Up 10 seconds",
    Names: `container-${opts.id}`,
    Ports: "3000/tcp",
    Labels: [
      "com.docker.compose.project=alpha",
      `com.docker.compose.service=service-${opts.id}`,
      "com.docker.compose.project.working_dir=/tmp/alpha/.hack",
    ].join(","),
  };
}

function makeInspectRow(opts: {
  readonly id: string;
}): Record<string, unknown> {
  return {
    Id: `${opts.id}${"0".repeat(52)}`,
    Config: {
      Image: `image:${opts.id}`,
      Labels: {
        "com.docker.compose.project": "alpha",
        "com.docker.compose.service": `service-${opts.id}`,
        "com.docker.compose.project.working_dir": "/tmp/alpha/.hack",
      },
    },
    Mounts: [],
    NetworkSettings: {
      Networks: {
        "hack-dev": {
          IPAddress: "172.20.0.2",
          Gateway: "172.20.0.1",
          Aliases: [`container-${opts.id}`],
        },
      },
    },
  };
}
