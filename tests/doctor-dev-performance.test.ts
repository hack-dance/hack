import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDoctorJsonData,
  buildDoctorSummaryLines,
} from "../src/commands/doctor.ts";
import { scanComposeServiceLines } from "../src/lib/compose-service-lines.ts";
import {
  type ArchitectureProbe,
  annotateEmulatedPsItems,
  inspectContainerArchitectures,
  normalizeArchitecture,
  platformArchitecture,
} from "../src/lib/container-architecture.ts";
import {
  composeDevInputsFromText,
  DEV_PERFORMANCE_GUIDE_URL,
  type DevRuntimeContainer,
  devImageTagsCheck,
  emulatedServicesCheck,
  isMutableImageReference,
  pollingValueEnabled,
  pollingWatchersCheck,
  readDeclaredToolVersions,
  runDevPerformanceChecks,
  sharedVolumeArchCheck,
} from "../src/lib/doctor-dev-performance.ts";
import {
  planPollingFix,
  pollingFixPreservesDocument,
} from "../src/lib/doctor-polling-fix.ts";

const FILE = ".hack/docker-compose.yml";

/** The shape old `hack init` generated, plus non-legacy forms to leave alone. */
const LEGACY_COMPOSE = `name: demo
services:
  web:
    image: imbios/bun-node:latest
    platform: linux/amd64
    working_dir: /app
    volumes:
      - ..:/app
      - node_modules:/app/node_modules
    command: bun dev
    environment:
      CHOKIDAR_USEPOLLING: "true"
      WATCHPACK_POLLING: "true"
      PORT: "3000"
  worker:
    image: imbios/bun-node
    working_dir: /app
    volumes:
      - ..:/app
    environment:
      - CHOKIDAR_USEPOLLING=true
      - WATCHPACK_POLLING=750
  api:
    image: node:22.11-alpine
    platform: linux/arm64
    volumes:
      - ..:/app
    environment:
      CHOKIDAR_USEPOLLING: \${CHOKIDAR_USEPOLLING:-false}
      WATCHPACK_POLLING: "750"
networks:
  hack-dev:
    external: true
`;

const inputs = composeDevInputsFromText({ file: FILE, text: LEGACY_COMPOSE });

function container(
  overrides: Partial<DevRuntimeContainer> & { service: string }
): DevRuntimeContainer {
  return {
    instance: "demo",
    state: "running",
    image: "imbios/bun-node:latest",
    volumes: [],
    arch: "arm64",
    ...overrides,
  };
}

describe("compose line scanner", () => {
  test("places service keys and both environment forms", () => {
    const lines = scanComposeServiceLines(LEGACY_COMPOSE);
    expect(lines.get("web")?.keys.get("platform")).toBe(5);
    expect(lines.get("web")?.environmentBlock).toBe(11);
    expect(lines.get("web")?.environment).toEqual([
      { key: "CHOKIDAR_USEPOLLING", line: 12, form: "map", raw: '"true"' },
      { key: "WATCHPACK_POLLING", line: 13, form: "map", raw: '"true"' },
      { key: "PORT", line: 14, form: "map", raw: '"3000"' },
    ]);
    expect(lines.get("worker")?.environment.map((e) => e.form)).toEqual([
      "list",
      "list",
    ]);
    expect(lines.has("hack-dev")).toBe(false);
  });
});

describe("emulated services", () => {
  test("arm64 host: a pin with its line and a running amd64 container, with the fix and guide", () => {
    const check = emulatedServicesCheck({
      inputs,
      hostArch: "arm64",
      containers: [
        container({ service: "web", arch: "amd64" }),
        // Unpinned but still amd64: the cached-tag trap.
        container({ service: "worker", arch: "amd64" }),
        container({ service: "api", arch: "arm64" }),
        // Stopped containers are not "running emulated".
        container({ service: "api", arch: "amd64", state: "exited" }),
      ],
    });
    expect(check.status).toBe("warn");
    expect(check.message).toContain(`pinned at ${FILE}:5`);
    expect(check.message).toContain(
      "worker runs a amd64 image in demo without a pin"
    );
    expect(check.message).toContain("Remove the pin");
    expect(check.message).toContain("docker pull --platform linux/arm64");
    expect(check.message).toContain("multi-architecture digest");
    expect(check.message).toContain(DEV_PERFORMANCE_GUIDE_URL);
    expect(check.devPerformance).toEqual({
      kind: "emulated_services",
      hostArch: "arm64",
      runtimeInspected: true,
      pins: [
        {
          service: "web",
          platform: "linux/amd64",
          arch: "amd64",
          file: FILE,
          line: 5,
        },
      ],
      containers: [
        {
          instance: "demo",
          service: "web",
          arch: "amd64",
          image: "imbios/bun-node:latest",
          pinned: true,
        },
        {
          instance: "demo",
          service: "worker",
          arch: "amd64",
          image: "imbios/bun-node:latest",
          pinned: false,
        },
      ],
    });
  });

  test("arm64 host without Docker still reports the pin from the Compose file", () => {
    const check = emulatedServicesCheck({
      inputs,
      hostArch: "arm64",
      containers: null,
    });
    expect(check.status).toBe("warn");
    expect(check.message).toContain(`web pins linux/amd64 at ${FILE}:5`);
    expect(check.devPerformance).toMatchObject({ runtimeInspected: false });
  });

  test("amd64 host: the amd64 pin is native, so no platform finding", () => {
    const amd64Only = composeDevInputsFromText({
      file: FILE,
      text: "services:\n  web:\n    image: x:1\n    platform: linux/amd64\n",
    });
    const check = emulatedServicesCheck({
      inputs: amd64Only,
      hostArch: "amd64",
      containers: [container({ service: "web", arch: "amd64" })],
    });
    expect(check.status).toBe("ok");
    expect(check.devPerformance).toMatchObject({ pins: [], containers: [] });
  });

  test("an interpolated platform is judged by its default only", () => {
    const text =
      "services:\n  a:\n    platform: ${P:-linux/amd64}\n  b:\n    platform: ${P}\n";
    const check = emulatedServicesCheck({
      inputs: composeDevInputsFromText({ file: FILE, text }),
      hostArch: "arm64",
      containers: null,
    });
    expect(check.devPerformance).toMatchObject({
      pins: [{ service: "a", line: 3 }],
    });
  });
});

describe("polling watchers", () => {
  test("flags truthy values per service with file and line; marks only the generated form legacy", () => {
    const check = pollingWatchersCheck(inputs);
    expect(check.status).toBe("warn");
    expect(check.devPerformance).toEqual({
      kind: "polling_watchers",
      services: [
        {
          service: "web",
          variable: "CHOKIDAR_USEPOLLING",
          value: "true",
          file: FILE,
          line: 12,
          legacy: true,
        },
        {
          service: "web",
          variable: "WATCHPACK_POLLING",
          value: "true",
          file: FILE,
          line: 13,
          legacy: true,
        },
        {
          service: "worker",
          variable: "CHOKIDAR_USEPOLLING",
          value: "true",
          file: FILE,
          line: 21,
          legacy: false,
        },
      ],
    });
    expect(check.message).toContain(
      `web: CHOKIDAR_USEPOLLING=true (${FILE}:12)`
    );
    expect(check.message).toContain(
      "hack doctor --fix --only 'polling watchers'"
    );
  });

  test("numeric intervals, falsy values and opt-in defaults are not flagged", () => {
    const cases: [Parameters<typeof pollingValueEnabled>[0], boolean][] = [
      [{ variable: "WATCHPACK_POLLING", value: "750" }, false],
      [{ variable: "WATCHPACK_POLLING", value: 750 }, false],
      [
        {
          variable: "CHOKIDAR_USEPOLLING",
          value: "${CHOKIDAR_USEPOLLING:-false}",
        },
        false,
      ],
      [
        { variable: "CHOKIDAR_USEPOLLING", value: "${CHOKIDAR_USEPOLLING}" },
        false,
      ],
      [{ variable: "CHOKIDAR_USEPOLLING", value: "false" }, false],
      [{ variable: "CHOKIDAR_USEPOLLING", value: "0" }, false],
      [{ variable: "CHOKIDAR_USEPOLLING", value: true }, true],
      [{ variable: "CHOKIDAR_USEPOLLING", value: "1" }, true],
      [{ variable: "CHOKIDAR_USEPOLLING", value: 1 }, true],
      [{ variable: "WATCHPACK_POLLING", value: "TRUE" }, true],
      [{ variable: "WATCHPACK_POLLING", value: "${W:-true}" }, true],
    ];
    for (const [input, expected] of cases) {
      expect([input, pollingValueEnabled(input)]).toEqual([input, expected]);
    }
  });

  test("a clean project is ok", () => {
    const clean = composeDevInputsFromText({
      file: FILE,
      text: "services:\n  web:\n    image: x:1\n    environment:\n      PORT: '3000'\n",
    });
    expect(pollingWatchersCheck(clean).status).toBe("ok");
  });
});

describe("mixed architectures on a shared volume", () => {
  test("warns per instance volume naming each service's architecture", () => {
    const check = sharedVolumeArchCheck([
      container({
        service: "web",
        volumes: ["demo_node_modules"],
        arch: "arm64",
      }),
      container({
        service: "install",
        state: "exited",
        volumes: ["demo_node_modules"],
        arch: "amd64",
      }),
      // Another instance using its own volume of the same logical name.
      container({
        instance: "demo--feature",
        service: "web",
        volumes: ["demo--feature_node_modules"],
        arch: "arm64",
      }),
    ]);
    expect(check.status).toBe("warn");
    expect(check.devPerformance).toEqual({
      kind: "shared_volume_architectures",
      volumes: [
        {
          instance: "demo",
          volume: "demo_node_modules",
          services: [
            { service: "install", arch: "amd64" },
            { service: "web", arch: "arm64" },
          ],
        },
      ],
    });
    expect(check.message).toContain("Native modules");
  });

  test("one architecture, or unknown architectures, is ok", () => {
    expect(
      sharedVolumeArchCheck([
        container({ service: "a", volumes: ["v"] }),
        container({ service: "b", volumes: ["v"] }),
        container({ service: "c", volumes: ["v"], arch: null }),
      ]).status
    ).toBe("ok");
  });
});

describe("mutable dev image tags", () => {
  test("reference classification", () => {
    expect(isMutableImageReference("node")).toBe(true);
    expect(isMutableImageReference("node:latest")).toBe(true);
    expect(isMutableImageReference("registry:5000/team/node")).toBe(true);
    expect(isMutableImageReference("node:22.11")).toBe(false);
    expect(isMutableImageReference("node@sha256:abc")).toBe(false);
    expect(isMutableImageReference("${IMAGE}")).toBe(false);
  });

  test("a note, not a warning, only when the repo declares Node or Bun", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctor-dev-tags-"));
    try {
      await Bun.write(
        join(root, "package.json"),
        JSON.stringify({
          engines: { node: ">=22" },
          packageManager: "bun@1.2.3",
        })
      );
      await Bun.write(join(root, ".nvmrc"), "22.11.0\n");
      const declared = await readDeclaredToolVersions(root);
      expect(declared).toEqual([
        { tool: "node", version: ">=22", source: "package.json engines" },
        {
          tool: "bun",
          version: "1.2.3",
          source: "package.json packageManager",
        },
        { tool: "node", version: "22.11.0", source: ".nvmrc" },
      ]);
      const check = devImageTagsCheck({ inputs, declared });
      expect(check.status).toBe("ok");
      expect(check.message).toStartWith("Note: ");
      expect(check.message).toContain(
        `web uses imbios/bun-node:latest (${FILE}:4)`
      );
      expect(check.message).toContain("worker uses imbios/bun-node");
      expect(check.message).not.toContain("api uses");
      expect(
        devImageTagsCheck({ inputs, declared: [] }).devPerformance
      ).toMatchObject({
        services: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("doctor output", () => {
  test("JSON carries each report and the polling preview command; text summary groups them", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctor-dev-json-"));
    try {
      const composeFile = join(root, FILE);
      await Bun.write(composeFile, LEGACY_COMPOSE);
      const checks = await runDevPerformanceChecks({
        projectRoot: root,
        composeFile,
        hostArch: "arm64",
        containers: [container({ service: "web", arch: "amd64" })],
      });
      const results = checks.map((check) => ({ ...check, durationMs: 1 }));
      const data = buildDoctorJsonData({ results });
      expect(data.checks.map((c) => [c.id, c.status])).toEqual([
        ["emulated services", "warn"],
        ["polling watchers", "warn"],
        ["shared volume architectures", "ok"],
        ["dev image tags", "ok"],
      ]);
      const polling = data.checks.find((c) => c.id === "polling watchers");
      expect(polling?.fix).toEqual({
        kind: "manual",
        args: ["doctor", "--fix", "--only", "polling watchers", "--json"],
        doc_url: DEV_PERFORMANCE_GUIDE_URL,
      });
      expect(polling?.devPerformance?.kind).toBe("polling_watchers");
      const emulated = data.checks.find((c) => c.id === "emulated services");
      expect(emulated?.fix.kind).toBe("manual");
      expect(emulated?.area).toBe("engine");
      expect(emulated?.scope).toBe("project");

      const summary = buildDoctorSummaryLines({ results });
      expect(summary).toHaveLength(1);
      expect(summary[0]).toStartWith(
        "Dev performance: warn - emulated services:"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("polling fix", () => {
  test("removes exactly the generated lines and shows a diff", () => {
    const plan = planPollingFix({ text: LEGACY_COMPOSE, file: FILE });
    expect(plan.removed).toEqual([
      { service: "web", variable: "CHOKIDAR_USEPOLLING", line: 12 },
      { service: "web", variable: "WATCHPACK_POLLING", line: 13 },
    ]);
    expect(plan.diff).toBe(
      [
        `--- a/${FILE}`,
        `+++ b/${FILE}`,
        "@@ -10,6 +10,4 @@",
        "     command: bun dev",
        "     environment:",
        '-      CHOKIDAR_USEPOLLING: "true"',
        '-      WATCHPACK_POLLING: "true"',
        '       PORT: "3000"',
        "   worker:",
        "",
      ].join("\n")
    );
    expect(plan.after).toContain("- CHOKIDAR_USEPOLLING=true");
    expect(plan.after).toContain("${CHOKIDAR_USEPOLLING:-false}");
    expect(pollingFixPreservesDocument(plan)).toBe(true);
  });

  test("an emptied environment block is removed; a commented one becomes {}", () => {
    const text =
      'services:\n  web:\n    image: x:1\n    environment:\n      CHOKIDAR_USEPOLLING: "true"\n      WATCHPACK_POLLING: "true"\n    command: dev\n';
    const plan = planPollingFix({ text, file: FILE });
    expect(plan.after).toBe(
      "services:\n  web:\n    image: x:1\n    command: dev\n"
    );
    expect(pollingFixPreservesDocument(plan)).toBe(true);

    const commented =
      'services:\n  web:\n    environment:\n      # keep me\n      CHOKIDAR_USEPOLLING: "true"\n';
    const kept = planPollingFix({ text: commented, file: FILE });
    expect(kept.after).toBe(
      "services:\n  web:\n    environment: {}\n      # keep me\n"
    );
    expect(pollingFixPreservesDocument(kept)).toBe(true);
  });

  test("non-legacy forms are left alone and a clean project is a no-op", () => {
    const nonLegacy = [
      "services:",
      "  web:",
      "    environment:",
      "      CHOKIDAR_USEPOLLING: true",
      '      WATCHPACK_POLLING: "true" # measured on this runtime',
      "  worker:",
      "    environment:",
      "      - CHOKIDAR_USEPOLLING=true",
      "      - WATCHPACK_POLLING=750",
      "",
    ].join("\n");
    for (const text of [nonLegacy, "services:\n  web:\n    image: x:1\n", ""]) {
      const plan = planPollingFix({ text, file: FILE });
      expect(plan.removed).toEqual([]);
      expect(plan.after).toBe(text);
      expect(plan.diff).toBe("");
    }
  });
});

describe("review follow-ups", () => {
  test("only Node or Bun images get the dev image note", () => {
    const text = [
      "services:",
      "  db:",
      "    image: postgres",
      "    volumes:",
      "      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql",
      "  app:",
      "    image: oven/bun",
      "    volumes:",
      "      - ..:/app",
      "",
    ].join("\n");
    const check = devImageTagsCheck({
      inputs: composeDevInputsFromText({ file: FILE, text }),
      declared: [{ tool: "node", version: "20", source: ".nvmrc" }],
    });
    expect(check.devPerformance).toMatchObject({
      services: [{ service: "app", image: "oven/bun", line: 7 }],
    });
  });

  test("a duplicated key reports the entry Compose keeps", () => {
    const text =
      'services:\n  web:\n    environment:\n      CHOKIDAR_USEPOLLING: "false"\n      CHOKIDAR_USEPOLLING: "true"\n';
    const parsed = composeDevInputsFromText({ file: FILE, text });
    expect(pollingWatchersCheck(parsed).devPerformance).toMatchObject({
      services: [{ line: 5, legacy: true }],
    });
  });

  test("the fix is refused when the document would change beyond the removed keys", () => {
    const text =
      'services:\n  web:\n    environment:\n      CHOKIDAR_USEPOLLING: "true"\n      CHOKIDAR_USEPOLLING: "false"\n';
    const plan = planPollingFix({ text, file: FILE });
    expect(plan.removed).toHaveLength(1);
    expect(pollingFixPreservesDocument(plan)).toBe(false);
  });

  test("a service whose only property is the block keeps environment: {}", () => {
    const text =
      'services:\n  web:\n    environment:\n      CHOKIDAR_USEPOLLING: "true"\n';
    const plan = planPollingFix({ text, file: FILE });
    expect(plan.after).toBe("services:\n  web:\n    environment: {}\n");
    expect(pollingFixPreservesDocument(plan)).toBe(true);
  });

  test("a column-0 comment after the block does not keep the header, and CRLF is kept", () => {
    const text =
      'services:\r\n  web:\r\n    image: x:1\r\n    environment:\r\n      CHOKIDAR_USEPOLLING: "true"\r\n# trailing\r\n';
    const plan = planPollingFix({ text, file: FILE });
    expect(plan.after).toBe(
      "services:\r\n  web:\r\n    image: x:1\r\n# trailing\r\n"
    );
    const only = planPollingFix({
      text: 'services:\r\n  web:\r\n    environment:\r\n      WATCHPACK_POLLING: "true"\r\n',
      file: FILE,
    });
    expect(only.after).toBe("services:\r\n  web:\r\n    environment: {}\r\n");
  });

  test("ps annotation gives up after its deadline and leaves items unchanged", async () => {
    const items = [{ ID: "aaaa" }];
    const hang: ArchitectureProbe = () => new Promise(() => undefined);
    expect(
      await annotateEmulatedPsItems({ items, probe: hang, deadlineMs: 20 })
    ).toEqual(items);
  });
});

describe("container architectures", () => {
  test("normalizes engine and platform spellings", () => {
    expect(normalizeArchitecture("x86_64")).toBe("amd64");
    expect(normalizeArchitecture("aarch64")).toBe("arm64");
    expect(platformArchitecture("linux/arm64/v8")).toBe("arm64");
    expect(platformArchitecture("amd64")).toBe("amd64");
  });

  const probe =
    (engine: string | null): ArchitectureProbe =>
    async (args) => {
      if (args[0] === "version") {
        return engine === null
          ? { exitCode: 1, stdout: "" }
          : { exitCode: 0, stdout: `${JSON.stringify(engine)}\n` };
      }
      if (args[0] === "inspect") {
        return {
          // Docker exits 1 when one id is gone but still prints the rest.
          exitCode: 1,
          stdout:
            '{"id":"aaaa1111","image":"sha256:amd"}\n{"id":"bbbb2222","image":"sha256:arm"}\n',
        };
      }
      return {
        exitCode: 0,
        stdout:
          '{"id":"sha256:amd","arch":"amd64"}\n{"id":"sha256:arm","arch":"arm64"}\n',
      };
    };

  test("inspects image architecture per container, short ids included", async () => {
    const archs = await inspectContainerArchitectures({
      ids: ["aaaa", "bbbb2222", "gone"],
      probe: probe("arm64"),
    });
    expect(archs.get("aaaa")).toBe("amd64");
    expect(archs.get("bbbb2222")).toBe("arm64");
    expect(archs.has("gone")).toBe(false);
  });

  test("ps items gain emulated: true only where the architecture differs", async () => {
    const items = [
      { ID: "aaaa", Service: "web" },
      { ID: "bbbb2222", Service: "api" },
      { ID: "gone", Service: "old" },
    ];
    expect(
      await annotateEmulatedPsItems({ items, probe: probe("aarch64") })
    ).toEqual([
      { ID: "aaaa", Service: "web", emulated: true },
      { ID: "bbbb2222", Service: "api" },
      { ID: "gone", Service: "old" },
    ]);
    expect(
      await annotateEmulatedPsItems({ items, probe: probe(null) })
    ).toEqual(items);
    expect(
      await annotateEmulatedPsItems({ items, probe: probe("x86_64") })
    ).toEqual([
      { ID: "aaaa", Service: "web" },
      { ID: "bbbb2222", Service: "api", emulated: true },
      { ID: "gone", Service: "old" },
    ]);
  });
});
