import { expect, test } from "bun:test";
import { join } from "node:path";
import { isRecord } from "../src/lib/guards.ts";
import { renderNativeCompose } from "../src/lib/native-compose-renderer.ts";
import { compileNativeConfig } from "../src/lib/native-config-compiler.ts";
import { mapLegacyNativeImport } from "../src/lib/native-config-import-plan.ts";
import { stringAdoptionWorkerSources } from "./e2e/scenarios/native-compose-adoption-worktrees.ts";
import { composeFixture } from "./helpers/native-compose.ts";

const configTest =
  process.env.HACK_TEST_COMPOSE_CONFIG === "1" ? test : test.skip;

/** Uses configuration normalization only: no daemon connection, container start, pull or build. */
async function normalized(opts: {
  readonly json: string;
  readonly profiles?: readonly string[];
}): Promise<Record<string, unknown>> {
  const args = ["docker", "compose", "-f", "-"];
  for (const profile of opts.profiles ?? []) {
    args.push("--profile", profile);
  }
  args.push("config", "--format", "json");
  const child = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AMBIENT: "hostile-interpolation-value",
      READY: "hostile-interpolation-value",
      COMPOSE_PROFILES: "unselected-profile",
    },
  });
  child.stdin.write(opts.json);
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).not.toContain("hostile-interpolation-value");
    expect(exit).toBe(0);
    const result: unknown = JSON.parse(stdout);
    if (!isRecord(result)) {
      throw new Error("Compose config did not produce an object");
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

configTest(
  "actual Compose normalization preserves dollars, empty args and explicit shell healthcheck",
  async () => {
    const input = composeFixture({
      services: {
        web: {
          image: "fixture/web:1",
          command: { exec: ["server", "${AMBIENT}", "$", "$$", ""] },
          entrypoint: { exec: [] },
          init: false,
          shutdown: { signal: "SIGTERM", grace: "45000ms" },
          restart: { kind: "on-failure", max_retries: 3 },
          readiness: {
            kind: "exec",
            command: { shell: 'test -n "$READY"' },
            interval: "1000ms",
            timeout: "1000ms",
            retries: 3,
          },
          environment: {
            LITERAL: { literal: "${AMBIENT:-wrong}" },
            NUMBER: { literal: "false" },
            EMPTY: { literal: "" },
          },
        },
      },
    });
    input.environmentPlan.workloads.web = {
      LITERAL: { kind: "literal", value: "${AMBIENT:-wrong}" },
      NUMBER: { kind: "literal", value: "false" },
      EMPTY: { kind: "literal", value: "" },
    };
    const result = await normalized(renderNativeCompose(input));
    expect(result).toMatchObject({
      name: "nc03-fixture-a",
      services: {
        web: {
          command: ["server", "$${AMBIENT}", "$$", "$$$$", ""],
          entrypoint: [],
          init: false,
          restart: "on-failure:3",
          stop_signal: "SIGTERM",
          stop_grace_period: "45s",
          environment: {
            LITERAL: "$${AMBIENT:-wrong}",
            NUMBER: "false",
            EMPTY: "",
          },
          healthcheck: {
            test: ["CMD", "/bin/sh", "-c", 'test -n "$$READY"'],
            interval: "1s",
            timeout: "1s",
            retries: 3,
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("hostile-interpolation-value");
  }
);

configTest(
  "legacy dollar-pair argv matches real compiler plan and Compose normalization",
  async () => {
    const source = {
      name: "fixture",
      services: {
        web: {
          image: "fixture/web:1",
          command: ["serve", "$${AMBIENT}", "$$", "$$$$", ""],
          entrypoint: ["/bin/echo", "prefix-$$HOME"],
        },
        inactive: {
          image: "fixture/optional:1",
          profiles: ["qa"],
          command: ["optional", "$${INACTIVE}"],
        },
      },
    };
    const mapped = mapLegacyNativeImport({
      configText: '{"name":"fixture"}',
      composeText: JSON.stringify(source),
    });
    expect(mapped.report.complete).toBe(true);
    expect(mapped.candidate).toBeDefined();
    for (const profiles of [[], ["qa"]]) {
      const compiled = await compileNativeConfig({
        input: new TextEncoder().encode(JSON.stringify(mapped.candidate)),
        binary: join(import.meta.dir, "../dist/hack-config-compiler"),
        profiles,
      });
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) {
        continue;
      }
      const fixture = composeFixture({
        services: {
          web: { image: "fixture/web:1" },
          inactive: { image: "fixture/optional:1" },
        },
      });
      const selected = profiles.length ? ["web", "inactive"] : ["web"];
      fixture.environmentPlan.workloads = Object.fromEntries(
        selected.map((name) => [name, {}])
      );
      fixture.managedValues = Object.fromEntries(
        selected.map((name) => [name, {}])
      );
      const generated = renderNativeCompose({
        ...fixture,
        plan: compiled.plan,
      });
      const original = await normalized({
        json: JSON.stringify(source),
        profiles,
      });
      const actual = await normalized({ json: generated.json, profiles });
      expect(Object.keys(generated.document.services).sort()).toEqual(
        [...selected].sort()
      );
      for (const name of selected) {
        const sourceService = isRecord(original.services)
          ? original.services[name]
          : undefined;
        const generatedService = isRecord(actual.services)
          ? actual.services[name]
          : undefined;
        expect(isRecord(sourceService)).toBe(true);
        expect(isRecord(generatedService)).toBe(true);
        if (isRecord(sourceService) && isRecord(generatedService)) {
          expect(generatedService.command).toEqual(sourceService.command);
          expect(generatedService.entrypoint).toEqual(sourceService.entrypoint);
        }
      }
      expect(JSON.stringify(actual)).not.toContain(
        "hostile-interpolation-value"
      );
    }
  }
);

configTest(
  "one authored bridge keeps internal policy and static aliases through compiler and Compose normalization",
  async () => {
    for (const internal of [true, false]) {
      const source = {
        name: "fixture",
        services: {
          web: {
            image: "fixture/web:1",
            networks: { private: { aliases: ["web-api"] } },
          },
          inactive: {
            image: "fixture/optional:1",
            profiles: ["qa"],
            networks: { private: { aliases: ["qa-api"] } },
          },
        },
        networks: {
          private: { ...(internal ? { driver: "bridge" } : {}), internal },
        },
      };
      const mapped = mapLegacyNativeImport({
        configText: '{"name":"fixture"}',
        composeText: JSON.stringify(source),
      });
      expect(mapped.report.complete).toBe(true);
      expect(mapped.candidate).toBeDefined();
      for (const profiles of [[], ["qa"]]) {
        const compiled = await compileNativeConfig({
          input: new TextEncoder().encode(JSON.stringify(mapped.candidate)),
          binary: join(import.meta.dir, "../dist/hack-config-compiler"),
          profiles,
        });
        expect(compiled.ok).toBe(true);
        if (!compiled.ok) {
          continue;
        }
        const fixture = composeFixture({
          services: {
            web: { image: "fixture/web:1" },
            inactive: { image: "fixture/optional:1" },
          },
        });
        const selected = profiles.length ? ["web", "inactive"] : ["web"];
        fixture.environmentPlan.workloads = Object.fromEntries(
          selected.map((name) => [name, {}])
        );
        fixture.managedValues = Object.fromEntries(
          selected.map((name) => [name, {}])
        );
        const generated = renderNativeCompose({
          ...fixture,
          plan: compiled.plan,
        });
        const original = await normalized({
          json: JSON.stringify(source),
          profiles,
        });
        const actual = await normalized({ json: generated.json, profiles });
        const sourceNetworks = original.networks;
        const generatedNetworks = actual.networks;
        expect(isRecord(sourceNetworks)).toBe(true);
        expect(isRecord(generatedNetworks)).toBe(true);
        if (!(isRecord(sourceNetworks) && isRecord(generatedNetworks))) {
          continue;
        }
        const sourceBridge = sourceNetworks.private;
        const generatedBridge = generatedNetworks.private;
        expect(isRecord(sourceBridge)).toBe(true);
        expect(isRecord(generatedBridge)).toBe(true);
        if (!(isRecord(sourceBridge) && isRecord(generatedBridge))) {
          continue;
        }
        expect(sourceBridge.driver ?? "bridge").toBe("bridge");
        expect(sourceBridge.internal ?? false).toBe(internal);
        expect(generatedBridge.driver).toBe("bridge");
        expect(generatedBridge.internal ?? false).toBe(internal);
        for (const name of selected) {
          const sourceService = isRecord(original.services)
            ? original.services[name]
            : undefined;
          const generatedService = isRecord(actual.services)
            ? actual.services[name]
            : undefined;
          expect(isRecord(sourceService)).toBe(true);
          expect(isRecord(generatedService)).toBe(true);
          if (isRecord(sourceService) && isRecord(generatedService)) {
            expect(sourceService.networks).toEqual(generatedService.networks);
          }
        }
      }
    }
  }
);

configTest(
  "Compose string words match real compiler and renderer exec argv for selected profiles",
  async () => {
    const source = {
      name: "fixture",
      services: {
        web: {
          image: "fixture/web:1",
          command: "  /bin/echo   'two words' \"\" a\\ b $${AMBIENT} $$$$ ",
          entrypoint: " /bin/sh -c 'printf \"a b\"' ",
        },
        cleared: {
          image: "fixture/cleared:1",
          command: " /bin/echo clear ",
          entrypoint: "",
        },
        clearspace: {
          image: "fixture/clearspace:1",
          command: "/bin/echo clear",
          entrypoint: " \t ",
        },
        defaults: {
          image: "fixture/defaults:1",
          command: null,
          entrypoint: null,
        },
        omitted: { image: "fixture/omitted:1" },
        joined: {
          image: "fixture/joined:1",
          command: "echo 'a'\"b\"c 'a\\ b'",
        },
        multiline: {
          image: "fixture/multiline:1",
          command: "echo\ta\nb",
        },
        escaped: {
          image: "fixture/escaped:1",
          command: 'echo a\\ b a\\"b',
        },
        doubleescape: {
          image: "fixture/doubleescape:1",
          command: 'echo "a\\ b" "a\\qb"',
        },
        lineescape: {
          image: "fixture/lineescape:1",
          command: "echo a\\\nb",
        },
        comment: {
          image: "fixture/comment:1",
          command: "echo #comment 'a && b'",
        },
        "worker-entrypoint": {
          image: "fixture/worker-entrypoint:1",
          ...stringAdoptionWorkerSources["string-entrypoint"],
        },
        "worker-cleared": {
          image: "fixture/worker-cleared:1",
          ...stringAdoptionWorkerSources["string-cleared"],
        },
        inactive: {
          image: "fixture/inactive:1",
          profiles: ["qa"],
          command: "printf 'later arg' $$LATER",
          entrypoint: " /bin/echo ",
        },
      },
    };
    const mapped = mapLegacyNativeImport({
      configText: '{"name":"fixture"}',
      composeText: JSON.stringify(source),
    });
    expect(mapped.report.complete).toBe(true);
    expect(mapped.candidate).toBeDefined();
    for (const profiles of [[], ["qa"]]) {
      const compiled = await compileNativeConfig({
        input: new TextEncoder().encode(JSON.stringify(mapped.candidate)),
        binary: join(import.meta.dir, "../dist/hack-config-compiler"),
        profiles,
      });
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) {
        continue;
      }
      const selected = profiles.length
        ? [
            "web",
            "cleared",
            "clearspace",
            "defaults",
            "omitted",
            "joined",
            "multiline",
            "escaped",
            "doubleescape",
            "lineescape",
            "comment",
            "worker-entrypoint",
            "worker-cleared",
            "inactive",
          ]
        : [
            "web",
            "cleared",
            "clearspace",
            "defaults",
            "omitted",
            "joined",
            "multiline",
            "escaped",
            "doubleescape",
            "lineescape",
            "comment",
            "worker-entrypoint",
            "worker-cleared",
          ];
      const fixture = composeFixture({
        services: Object.fromEntries(
          selected.map((name) => [name, { image: `fixture/${name}:1` }])
        ),
      });
      fixture.environmentPlan.workloads = Object.fromEntries(
        selected.map((name) => [name, {}])
      );
      fixture.managedValues = Object.fromEntries(
        selected.map((name) => [name, {}])
      );
      const generated = renderNativeCompose({
        ...fixture,
        plan: compiled.plan,
      });
      const original = await normalized({
        json: JSON.stringify(source),
        profiles,
      });
      const actual = await normalized({ json: generated.json, profiles });
      expect(Object.keys(generated.document.services).sort()).toEqual(
        [...selected].sort()
      );
      for (const name of selected) {
        const sourceService = isRecord(original.services)
          ? original.services[name]
          : undefined;
        const generatedService = isRecord(actual.services)
          ? actual.services[name]
          : undefined;
        expect(isRecord(sourceService)).toBe(true);
        expect(isRecord(generatedService)).toBe(true);
        if (isRecord(sourceService) && isRecord(generatedService)) {
          expect(generatedService.command).toEqual(sourceService.command);
          expect(generatedService.entrypoint).toEqual(sourceService.entrypoint);
        }
      }
      expect(JSON.stringify(actual)).not.toContain(
        "hostile-interpolation-value"
      );
    }
  }
);

configTest(
  "raw unpaired dollars cannot become accepted pairs after Compose word splitting",
  async () => {
    for (const command of [
      "echo $\\$AMBIENT",
      "echo $''$AMBIENT",
      "echo '$' '$AMBIENT'",
    ]) {
      const source = {
        name: "fixture",
        services: { web: { image: "fixture/web:1", command } },
      };
      const original = await normalized({ json: JSON.stringify(source) });
      expect(JSON.stringify(original)).toContain("hostile-interpolation-value");
      const mapped = mapLegacyNativeImport({
        configText: '{"name":"fixture"}',
        composeText: JSON.stringify(source),
      });
      expect(mapped.report.complete).toBe(false);
      expect(mapped.candidate).toBeUndefined();
      expect(mapped.report.fields).toContainEqual(
        expect.objectContaining({
          pointer: "/services/web/command",
          status: "refused",
          code: "invalid_or_ambiguous_value",
        })
      );
      expect(JSON.stringify(mapped)).not.toContain(
        "hostile-interpolation-value"
      );
    }
  }
);

configTest(
  "actual Compose normalization keeps profiles, dependency conditions and owned persistent names",
  async () => {
    const input = composeFixture({
      services: {
        web: {
          image: "fixture/web:1",
          profiles: ["dev"],
          depends_on: [
            { service: "db", condition: "ready" },
            { job: "setup", condition: "completed" },
          ],
          mounts: [
            { source: ".", target: "/app", access: "read-only" },
            { storage: "data", target: "/data", access: "read-write" },
          ],
        },
        db: {
          image: "fixture/db:1",
          readiness: {
            kind: "exec",
            command: { exec: ["db-ready"] },
            interval: "2000ms",
            timeout: "1000ms",
            retries: 3,
          },
        },
      },
      jobs: {
        setup: {
          build: { context: "backend", dockerfile: "Dockerfile" },
          command: { exec: ["setup"] },
        },
      },
    });
    input.plan.selected_profiles = ["dev"];
    input.plan.storage.data = { kind: "persistent", scope: "worktree" };
    const result = await normalized(renderNativeCompose(input));
    expect(result).toMatchObject({
      name: "nc03-fixture-a",
      services: {
        web: {
          profiles: ["dev"],
          labels: {
            "io.hack.native-config.owner": "c".repeat(32),
            "io.hack.native-config.workload": "service",
          },
          depends_on: {
            db: { condition: "service_healthy" },
            setup: { condition: "service_completed_successfully" },
          },
          volumes: [
            {
              type: "bind",
              source: "/verified/checkout",
              target: "/app",
              read_only: true,
              bind: { create_host_path: false },
            },
            { type: "volume", source: "data", target: "/data" },
          ],
        },
        setup: {
          labels: {
            "io.hack.native-config.owner": "c".repeat(32),
            "io.hack.native-config.workload": "job",
          },
          build: {
            context: "/verified/checkout/backend",
            dockerfile: "Dockerfile",
          },
        },
      },
      volumes: {
        data: {
          name: "hack-14-nc03-fixture-a-4-data",
          labels: { "io.hack.native-config.owner": "c".repeat(32) },
        },
      },
      networks: {
        default: {
          name: "nc03-fixture-a_default",
          labels: { "io.hack.native-config.owner": "c".repeat(32) },
        },
      },
    });
  }
);

configTest(
  "normalization negative control expands an unescaped host interpolation",
  async () => {
    const result = await normalized({
      json: JSON.stringify({
        name: "nc03-negative-control",
        services: {
          web: {
            image: "fixture/web:1",
            command: ["server", "${AMBIENT}"],
            environment: { LITERAL: "${AMBIENT}" },
          },
        },
      }),
    });
    expect(result).toMatchObject({
      services: {
        web: {
          command: ["server", "hostile-interpolation-value"],
          environment: { LITERAL: "hostile-interpolation-value" },
        },
      },
    });
  }
);

configTest(
  "dollar-bearing checkout paths remain literal in normalized bind and build sources",
  async () => {
    const input = composeFixture({
      services: {
        web: {
          image: "fixture/web:1",
          mounts: [{ source: "src", target: "/app", access: "read-only" }],
        },
      },
      jobs: {
        buildcheck: {
          build: { context: "backend", dockerfile: "Dockerfile" },
          command: { exec: ["check"] },
        },
      },
    });
    input.projectRoot = "/verified/${AMBIENT}/checkout";
    const result = await normalized(renderNativeCompose(input));
    expect(result).toMatchObject({
      services: {
        web: { volumes: [{ source: "/verified/$${AMBIENT}/checkout/src" }] },
        buildcheck: {
          build: { context: "/verified/$${AMBIENT}/checkout/backend" },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("hostile-interpolation-value");
  }
);

configTest(
  "actual Compose normalization preserves canonical pull/build policy intent",
  async () => {
    const input = composeFixture({
      services: {
        always: { image: "fixture/always:1", pull_policy: "always" },
        never: { image: "fixture/never:1", pull_policy: "never" },
        missing: { image: "fixture/missing:latest", pull_policy: "missing" },
        builder: {
          build: { context: ".", dockerfile: "Dockerfile" },
          pull_policy: "build",
        },
      },
    });
    const result = await normalized(renderNativeCompose(input));
    expect(result).toMatchObject({
      services: {
        always: { pull_policy: "always" },
        never: { pull_policy: "never" },
        missing: { image: "fixture/missing:latest", pull_policy: "missing" },
        builder: { pull_policy: "build" },
      },
    });
  }
);
