import { createMonorepoFixture } from "../fixture.ts";
import {
  expect,
  expectExit,
  extractJsonObject,
  type Scenario,
} from "../harness.ts";
import {
  downBestEffort,
  execServiceProbe,
  requireDockerPreconditions,
  resolveLocalCaPem,
  tryFetchRoute,
} from "./docker-shared.ts";

type PsPayload = {
  readonly services?: readonly {
    readonly name?: string;
    readonly state?: string;
    readonly status?: string;
  }[];
};

type OpenPayload = { readonly url?: string };

const UP_TIMEOUT_MS = 420_000;
const WEB_PORT = 3000;

/**
 * Full local runtime loop against the machine's real docker + global infra:
 * `up --detach` → `ps --json` shows running services → `open --json` route →
 * HTTP probe (direct via the routed dev_host with the Caddy local CA, or
 * in-container fallback when DNS is sandboxed) → `logs --no-follow` →
 * `down`. Cleanup always runs, with a raw docker compose sweep as backstop.
 */
export const upDownScenario: Scenario = {
  name: "up-down",
  tier: "docker",
  summary: "hack up/ps/open/logs/down loop against a live fixture",
  run: async (ctx) => {
    await requireDockerPreconditions({ ctx });

    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
    });

    try {
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

      const ps = await ctx.cli({
        args: ["ps", "--json"],
        cwd: fixture.root,
      });
      expectExit({
        result: ps,
        codes: [0],
        message: "hack ps --json should succeed while services run",
      });
      const psText = ps.stdout;
      const psPayload = extractJsonObject<PsPayload>({ text: psText });
      const runningEvidence =
        psPayload?.services?.some((service) =>
          `${service.state ?? ""} ${service.status ?? ""}`
            .toLowerCase()
            .includes("running")
        ) === true ||
        (psText.toLowerCase().includes("running") &&
          psText.includes("web") &&
          psText.includes("api"));
      expect({
        that: runningEvidence,
        message:
          "hack ps --json should show the web and api services running after up --detach",
        result: ps,
      });

      const open = await ctx.cli({
        args: ["open", "--json"],
        cwd: fixture.root,
      });
      expectExit({
        result: open,
        codes: [0],
        message: "hack open --json should succeed",
      });
      const url =
        extractJsonObject<OpenPayload>({ text: open.stdout })?.url ?? "";
      expect({
        that: url === `https://${fixture.devHost}`,
        message: `open --json should route https://${fixture.devHost}, got "${url}"`,
        result: open,
      });

      const caPem = await resolveLocalCaPem({ ctx });
      const direct =
        caPem === null ? null : await tryFetchRoute({ url, caPem });
      if (direct !== null) {
        expect({
          that: direct.includes("ok web"),
          message: `routed ${url} should answer "ok web", got: ${direct.slice(0, 200)}`,
        });
        ctx.log(`verified route ${url} directly (TLS via hack local CA)`);
      } else {
        ctx.log(
          `route ${url} not reachable from harness (sandboxed DNS or missing CA); using in-container probe`
        );
        const probed = await execServiceProbe({
          fixture,
          composeProject: fixture.name,
          service: "web",
          port: WEB_PORT,
        });
        expect({
          that: probed?.includes("ok web") === true,
          message: `in-container probe of web:${WEB_PORT} should answer "ok web", got: ${String(probed).slice(0, 200)}`,
        });
      }

      const logs = await ctx.cli({
        args: ["logs", "--no-follow", "--compose"],
        cwd: fixture.root,
        timeoutMs: 120_000,
      });
      expectExit({
        result: logs,
        codes: [0],
        message: "hack logs --no-follow --compose should succeed",
      });
      expect({
        that: logs.combined.includes("listening on"),
        message:
          "service logs should contain the fixture 'listening on' startup line",
        result: logs,
      });

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
