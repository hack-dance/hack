import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { addLinkedWorktree } from "../fixture.ts";
import {
  type CliResult,
  expect,
  expectExit,
  extractJsonObject,
  type Scenario,
} from "../harness.ts";
import {
  cleanupPatternFixture,
  copyPatternFixture,
  ownedContainers,
  requirePatternEngine,
  waitFor,
} from "./pattern-fixture.ts";

const OWNER = "hack.e2e.pattern-p07-owner";
const BRANCH = "p07-runner";
const COMMAND_MS = 180_000;
/** Fixture values that value-free inspection must never print. */
const FIXTURE_VALUES = [
  "browser-session",
  "machine-identity",
  "host-helper",
  "http://upstream:4000",
  "e2e-runner-pool",
];
const RUNNER_LOCAL = `version: 1
environment: runner
secretsprovider: project_key
values:
  global:
    RUNNER_POOL: e2e-runner-pool
`;
const BROWSER_OPENERS = [
  "open",
  "xdg-open",
  "sensible-browser",
  "x-www-browser",
  "www-browser",
];
const CAPABILITIES = `const response = await fetch("http://127.0.0.1:3000/");
console.log(await response.text());`;

type Explain = {
  readonly key?: string;
  readonly available?: boolean;
  readonly secret?: boolean;
  readonly environment?: string | null;
  readonly target?: string;
  readonly delivered_to?: readonly string[];
  readonly source?: string | null;
  readonly precedence?: readonly string[];
};
type Capabilities = {
  readonly authMode?: string;
  readonly browserSignIn?: boolean;
  readonly helperMode?: string | null;
  readonly upstreamReachable?: boolean;
};

/**
 * HACK-P07 (HACK-1151): the checked-in laptop/headless-runner overlay fixture
 * against a real engine. The primary checkout runs the laptop overlay and a
 * linked worktree runs the runner overlay on the same topology. Value-free
 * `env explain` must name each overlay's source file, the expected keys must
 * reach the containers, the shared dependency must be reachable, and no CLI
 * step may try to open a browser.
 */
export const patternP07CapabilityOverlaysScenario: Scenario = {
  name: "pattern-p07-capability-overlays",
  tier: "docker",
  summary:
    "P07 fixture: laptop/runner overlays, value-free explain, container env",
  run: async (ctx) => {
    const engine = await requirePatternEngine(ctx);
    const fixture = await copyPatternFixture({
      ctx,
      cardId: "HACK-P07",
      owner: OWNER,
      engine,
    });
    const linked = await addLinkedWorktree({ fixture, branch: BRANCH });
    const laptopProject = fixture.name;
    const runnerProject = `${fixture.name}--${BRANCH}`;
    const owned = {
      ctx,
      owner: OWNER,
      name: fixture.name,
      projects: [laptopProject, runnerProject],
    };
    // An untracked primary-local runner override that the linked worktree
    // inherits; inspection must show where it came from.
    const inheritedOverride = join(
      fixture.hackDir,
      "hack.env.runner.local.yaml"
    );
    await Bun.write(inheritedOverride, RUNNER_LOCAL);

    // Every browser opener on PATH, and BROWSER, records an attempt.
    const sentinelBin = join(ctx.tempRoot, "browser-sentinel");
    const browserAttempts = join(ctx.tempRoot, "browser-attempts.log");
    await mkdir(sentinelBin, { recursive: true });
    for (const opener of BROWSER_OPENERS) {
      const path = join(sentinelBin, opener);
      await Bun.write(
        path,
        `#!/bin/sh\necho "${opener}" >> "${browserAttempts}"\nexit 0\n`
      );
      await chmod(path, 0o755);
    }
    const env = {
      PATH: `${sentinelBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      BROWSER: join(sentinelBin, "xdg-open"),
      HACK_COMPOSE_STARTUP_TIMEOUT_MS: "150000",
    };
    const hack = async (cwd: string, args: readonly string[]) =>
      await ctx.cli({ cwd, args, env, timeoutMs: COMMAND_MS });
    const succeed = async (cwd: string, args: readonly string[]) => {
      const result = await hack(cwd, args);
      expectExit({
        result,
        codes: [0],
        message: `hack ${args.join(" ")} (P07 fixture)`,
      });
      return result;
    };
    const valueFree = (result: CliResult) => {
      for (const value of FIXTURE_VALUES) {
        expect({
          that: !result.combined.includes(value),
          message: "env explain must not print a resolved value",
          result,
        });
      }
    };
    const explain = async (opts: {
      readonly cwd: string;
      readonly key: string;
      readonly overlay: string;
      readonly compose: boolean;
    }) => {
      const result = await succeed(opts.cwd, [
        "env",
        "explain",
        opts.key,
        "--env",
        opts.overlay,
        ...(opts.compose ? ["--target", "compose"] : []),
        "--json",
      ]);
      valueFree(result);
      const payload = extractJsonObject<Explain>({ text: result.stdout });
      expect({
        that: payload?.key === opts.key,
        message: "env explain --json must describe the requested key",
        result,
      });
      return { payload: payload as Explain, result };
    };
    const explainedFrom = async (opts: {
      readonly cwd: string;
      readonly key: string;
      readonly overlay: string;
      readonly file: string;
    }) => {
      const { payload, result } = await explain({ ...opts, compose: true });
      expect({
        that:
          payload.available === true &&
          payload.secret === false &&
          payload.environment === opts.overlay &&
          payload.target === "compose" &&
          payload.delivered_to?.join(",") === "compose" &&
          payload.source === `global:${opts.file}` &&
          payload.precedence?.includes(opts.file) === true,
        message: `${opts.key} under --env ${opts.overlay} must come from its expected file`,
        result,
      });
    };
    const healthyApi = async (project: string) => {
      let api: Awaited<ReturnType<typeof ownedContainers>>[number] | undefined;
      await waitFor({
        timeoutMs: 120_000,
        message: `api in ${project} never became healthy`,
        check: async () => {
          api = (
            await ownedContainers({ ...owned, project, service: "api" })
          )[0];
          return api?.State?.Health?.Status === "healthy";
        },
      });
      return api as NonNullable<typeof api>;
    };
    const containerEnv = (
      api: Awaited<ReturnType<typeof healthyApi>>
    ): Map<string, string> =>
      new Map(
        (api.Config?.Env ?? []).map((entry) => {
          const index = entry.indexOf("=");
          return [entry.slice(0, index), entry.slice(index + 1)] as const;
        })
      );
    const capabilities = async (cwd: string, overlay: string) => {
      const result = await succeed(cwd, [
        "exec",
        "--env",
        overlay,
        "api",
        "--",
        "bun",
        "-e",
        CAPABILITIES,
      ]);
      const payload = extractJsonObject<Capabilities>({ text: result.stdout });
      expect({
        that: payload?.upstreamReachable === true,
        message: "the api container must reach the shared upstream",
        result,
      });
      return payload as Capabilities;
    };
    try {
      // Value-free inspection before anything starts.
      const laptopFile = join(fixture.hackDir, "hack.env.laptop.yaml");
      const runnerFile = join(linked, ".hack/hack.env.runner.yaml");
      await explainedFrom({
        cwd: fixture.root,
        key: "AUTH_MODE",
        overlay: "laptop",
        file: laptopFile,
      });
      await explainedFrom({
        cwd: linked,
        key: "AUTH_MODE",
        overlay: "runner",
        file: runnerFile,
      });
      await explainedFrom({
        cwd: linked,
        key: "BROWSER_SIGN_IN",
        overlay: "runner",
        file: runnerFile,
      });
      await explainedFrom({
        cwd: linked,
        key: "UPSTREAM_URL",
        overlay: "runner",
        file: join(linked, ".hack/hack.env.default.yaml"),
      });
      await explainedFrom({
        cwd: linked,
        key: "RUNNER_POOL",
        overlay: "runner",
        file: inheritedOverride,
      });
      // Host-view inspection reports the same overlay source.
      const hostView = await explain({
        cwd: fixture.root,
        key: "AUTH_MODE",
        overlay: "laptop",
        compose: false,
      });
      expect({
        that: hostView.payload.source === `global:${laptopFile}`,
        message: "host-view explain must name the same overlay source",
        result: hostView.result,
      });
      // Negative control: the base layers alone provide no auth capability.
      const base = await explain({
        cwd: fixture.root,
        key: "AUTH_MODE",
        overlay: "base",
        compose: true,
      });
      expect({
        that:
          base.payload.available === false &&
          base.payload.source === null &&
          (base.payload.delivered_to ?? []).length === 0,
        message: "without an overlay AUTH_MODE must be unavailable",
        result: base.result,
      });
      ctx.log(
        "env explain named each overlay, base and inherited source without values"
      );

      // One topology, two overlays, two instances.
      for (const [cwd, overlay] of [
        [fixture.root, "laptop"],
        [linked, "runner"],
      ] as const) {
        const started = await succeed(cwd, ["up", "--env", overlay, "--json"]);
        expect({
          that:
            extractJsonObject<{ ok?: boolean }>({ text: started.stdout })
              ?.ok === true,
          message: "hack up --json must report a successful envelope",
          result: started,
        });
      }
      const laptopApi = await healthyApi(laptopProject);
      const runnerApi = await healthyApi(runnerProject);
      const laptopEnv = containerEnv(laptopApi);
      const runnerEnv = containerEnv(runnerApi);
      const expected: readonly [Map<string, string>, Record<string, string>][] =
        [
          [
            laptopEnv,
            {
              AUTH_MODE: "browser-session",
              BROWSER_SIGN_IN: "allowed",
              HELPER_MODE: "host-helper",
              UPSTREAM_URL: "http://upstream:4000",
              UPSTREAM_TIMEOUT_MS: "3000",
            },
          ],
          [
            runnerEnv,
            {
              AUTH_MODE: "machine-identity",
              BROWSER_SIGN_IN: "disabled",
              HELPER_MODE: "none",
              UPSTREAM_URL: "http://upstream:4000",
              UPSTREAM_TIMEOUT_MS: "3000",
              RUNNER_POOL: "e2e-runner-pool",
            },
          ],
        ];
      for (const [actual, values] of expected) {
        for (const [key, value] of Object.entries(values)) {
          expect({
            that: actual.get(key) === value,
            message: `container metadata must carry the overlay's ${key}`,
          });
        }
      }
      expect({
        that: !laptopEnv.has("RUNNER_POOL"),
        message: "a runner-only local override must not reach the laptop stack",
      });
      ctx.log("container metadata carries each overlay's expected keys");

      const laptop = await capabilities(fixture.root, "laptop");
      const runner = await capabilities(linked, "runner");
      expect({
        that:
          laptop.authMode === "browser-session" &&
          laptop.browserSignIn === true &&
          runner.authMode === "machine-identity" &&
          runner.browserSignIn === false &&
          runner.helperMode === "none",
        message: "each api must report its overlay's capabilities",
      });
      // Negative control: exec cannot silently switch a running stack's overlay.
      const switched = await hack(linked, [
        "exec",
        "--env",
        "laptop",
        "api",
        "--",
        "true",
      ]);
      expect({
        that: !switched.timedOut && switched.exitCode !== 0,
        message:
          "exec with a different overlay than the running stack must fail",
        result: switched,
      });
      await succeed(linked, ["logs", "--no-follow", "--tail", "100", "api"]);
      ctx.log(
        "both stacks reached the shared upstream with their own overlays"
      );

      expect({
        that: !(await Bun.file(browserAttempts).exists()),
        message: "no Hack command may try to open a browser for sign-in",
      });
      ctx.log("no browser opener was invoked");
    } finally {
      await cleanupPatternFixture({
        ...owned,
        checkouts: [fixture.root, linked],
      });
    }
  },
};
