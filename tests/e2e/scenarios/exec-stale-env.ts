import { createMonorepoFixture } from "../fixture.ts";
import {
  type CliResult,
  expect,
  expectExit,
  type Scenario,
  type ScenarioContext,
} from "../harness.ts";
import { downBestEffort, requireDockerPreconditions } from "./docker-shared.ts";

const UP_TIMEOUT_MS = 420_000;
const EXEC_TIMEOUT_MS = 120_000;
const PROBE_KEY = "E2E_STALE_PROBE";
const VALUE_AT_UP = "synthetic-stale-probe-at-up";
const VALUE_AFTER_EDIT = "synthetic-stale-probe-after-edit";
const STALE_MARKER = "changed since it started";

/**
 * HACK-1140: synthetic env delivery and refresh against real compose
 * containers. `hack up` delivers a global env value to web and api; editing
 * the value afterwards makes `hack exec` print a closed stderr warning that
 * names the service and suggests `hack restart <service>` without printing any
 * value, while the container keeps its start-time env. `hack restart web`
 * recreates web with the new value and clears its warning; api, not
 * restarted, still warns. Identical env never warns (negative control).
 */
export const execStaleEnvScenario: Scenario = {
  name: "exec-stale-env",
  tier: "docker",
  summary: "hack exec warns value-free when delivered env changed since up",
  run: async (ctx) => {
    await requireDockerPreconditions({ ctx });

    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: { standaloneContainers: true },
    });

    const setProbe = async (value: string): Promise<void> => {
      const result = await ctx.cli({
        args: ["env", "add", PROBE_KEY, value],
        cwd: fixture.root,
      });
      expectExit({
        result,
        codes: [0],
        message: "hack env add should update the synthetic probe value",
      });
    };

    try {
      await setProbe(VALUE_AT_UP);
      const up = await ctx.cli({
        args: ["up", "--detach"],
        cwd: fixture.root,
        timeoutMs: UP_TIMEOUT_MS,
      });
      expectExit({
        result: up,
        codes: [0],
        message: "hack up --detach should succeed",
      });

      const fresh = await execProbe({
        ctx,
        root: fixture.root,
        service: "web",
      });
      expect({
        that: execProbeValue({ stdout: fresh.stdout }) === VALUE_AT_UP,
        message: "web should receive the env value resolved at up",
        result: fresh,
      });
      expect({
        that: !fresh.stderr.includes(STALE_MARKER),
        message: "negative control: identical env must not warn",
        result: fresh,
      });

      await setProbe(VALUE_AFTER_EDIT);
      for (const service of ["web", "api"]) {
        const stale = await execProbe({ ctx, root: fixture.root, service });
        expect({
          that: execProbeValue({ stdout: stale.stdout }) === VALUE_AT_UP,
          message: `${service} keeps its start-time env until recreated`,
          result: stale,
        });
        expectValueFreeWarning({ result: stale, service });
      }

      const restart = await ctx.cli({
        args: ["restart", "web"],
        cwd: fixture.root,
        timeoutMs: UP_TIMEOUT_MS,
      });
      expectExit({
        result: restart,
        codes: [0],
        message: "hack restart web should recreate web",
      });

      const refreshed = await execProbe({
        ctx,
        root: fixture.root,
        service: "web",
      });
      expect({
        that: execProbeValue({ stdout: refreshed.stdout }) === VALUE_AFTER_EDIT,
        message: "restarted web should receive the edited env value",
        result: refreshed,
      });
      expect({
        that: !refreshed.stderr.includes(STALE_MARKER),
        message: "restarted web must not warn",
        result: refreshed,
      });

      const stillStale = await execProbe({
        ctx,
        root: fixture.root,
        service: "api",
      });
      expectValueFreeWarning({ result: stillStale, service: "api" });

      const down = await ctx.cli({
        args: ["down"],
        cwd: fixture.root,
        timeoutMs: UP_TIMEOUT_MS,
      });
      expectExit({
        result: down,
        codes: [0],
        message: "hack down should succeed",
      });
    } finally {
      await downBestEffort({ ctx, fixture });
    }
  },
};

async function execProbe(opts: {
  readonly ctx: ScenarioContext;
  readonly root: string;
  readonly service: string;
}): Promise<CliResult> {
  // Hack's own diagnostics (for example CoreDNS/Caddy reachability warnings)
  // go through the logger; the console backend writes them to stderr so
  // stdout carries only the child command's output.
  const result = await opts.ctx.cli({
    args: ["exec", opts.service, "--", "printenv", PROBE_KEY],
    cwd: opts.root,
    env: { HACK_LOGGER: "console" },
    timeoutMs: EXEC_TIMEOUT_MS,
  });
  expectExit({
    result,
    codes: [0],
    message: `hack exec ${opts.service} printenv should succeed`,
  });
  return result;
}

/**
 * The value printed by the exec'd `printenv`: the last non-empty stdout line,
 * trimmed. Returns null when stdout has no non-empty line, so a missing value
 * never equals an expected one.
 */
export function execProbeValue(opts: {
  readonly stdout: string;
}): string | null {
  const lines = opts.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? null;
}

function expectValueFreeWarning(opts: {
  readonly result: CliResult;
  readonly service: string;
}): void {
  const { stderr } = opts.result;
  const warning =
    stderr.split("\n").find((line) => line.includes(STALE_MARKER)) ?? "";
  expect({
    that:
      warning.includes(`service "${opts.service}" ${STALE_MARKER}`) &&
      warning.includes(`hack restart ${opts.service}`),
    message: `${opts.service} exec should warn that its env changed and suggest a restart`,
    result: opts.result,
  });
  expect({
    that: !(
      warning.includes(PROBE_KEY) ||
      stderr.includes(VALUE_AT_UP) ||
      stderr.includes(VALUE_AFTER_EDIT)
    ),
    message: "stale env warning must not print any key or value",
    result: opts.result,
  });
}
