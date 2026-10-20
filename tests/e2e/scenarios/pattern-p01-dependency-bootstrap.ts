import { mkdir } from "node:fs/promises";
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
  checkedDocker,
  cleanupPatternFixture,
  copyPatternFixture,
  docker,
  ownedContainers,
  readComposeFile,
  replaceFile,
  requirePatternEngine,
  waitFor,
  writeComposeFile,
} from "./pattern-fixture.ts";

const OWNER = "hack.e2e.pattern-p01-owner";
const BRANCH = "p01-linked";
const COMMAND_MS = 180_000;
const CACHE = "/app/node_modules";
const META = `${CACHE}/.hack-dependency-cache-v1`;
const BEGAN = `${CACHE}/.e2e-installer-began`;
/**
 * Test-only initializer used for the interrupted attempt: it writes into the
 * cache, then blocks before the real installer so the scenario can kill it.
 */
const INTERRUPTED_INSTALL = [
  "sh",
  "-c",
  `touch ${BEGAN} && sleep 120 && exec bun install --frozen-lockfile`,
];
/**
 * Consumer readback inside a running `app`: the generated artifact parses,
 * the dependency payload carries the protocol's ready marker, the installed
 * `greeting` package works, and the served response is complete. Prints which
 * payload the consumer sees (`farewell` exists only after the lock change).
 */
const READ_ARTIFACTS = `const fs = await import("node:fs");
const info = JSON.parse(fs.readFileSync("/generated/build-info.json", "utf8"));
if (typeof info.generatedAt !== "string") process.exit(41);
if (!fs.existsSync("${META}/ready")) process.exit(42);
const { greet } = await import("greeting");
if (greet("x") !== "hello, x") process.exit(43);
const body = await (await fetch("http://127.0.0.1:3000/")).json();
if (body.message !== "hello, pattern-p01" || body.generatedAt !== info.generatedAt) process.exit(44);
let farewell = false;
try { await import("farewell"); farewell = true; } catch {}
console.log(JSON.stringify({ farewell, generatedAt: info.generatedAt }));`;
/** The bun.lock change: one more local package, resolved by Bun 1.4. */
const CHANGED_PACKAGE_JSON = `${JSON.stringify(
  {
    name: "pattern-p01",
    private: true,
    type: "module",
    dependencies: {
      farewell: "file:./packages/farewell",
      greeting: "file:./packages/greeting",
    },
  },
  null,
  2
)}\n`;
const CHANGED_LOCK = `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "pattern-p01",
      "dependencies": {
        "farewell": "file:./packages/farewell",
        "greeting": "file:./packages/greeting",
      },
    },
  },
  "packages": {
    "farewell": ["farewell@file:packages/farewell", {}],

    "greeting": ["greeting@file:packages/greeting", {}],
  }
}
`;

type Readback = { readonly farewell: boolean; readonly generatedAt: string };

/**
 * HACK-P01 (HACK-1145): the checked-in dependency-bootstrap fixture against a
 * real engine. Covers cold and warm runs, two worktrees, a bun.lock change and
 * an installer killed mid-run; every running consumer must see a complete old
 * or complete new artifact, never the interrupted one.
 */
export const patternP01DependencyBootstrapScenario: Scenario = {
  name: "pattern-p01-dependency-bootstrap",
  tier: "docker",
  summary:
    "P01 fixture: cold/warm, two worktrees, lock change, killed installer",
  run: async (ctx) => {
    const engine = await requirePatternEngine(ctx);
    const fixture = await copyPatternFixture({
      ctx,
      cardId: "HACK-P01",
      owner: OWNER,
      engine,
    });
    const linked = await addLinkedWorktree({ fixture, branch: BRANCH });
    const primaryProject = fixture.name;
    const linkedProject = `${fixture.name}--${BRANCH}`;
    const owned = {
      ctx,
      owner: OWNER,
      name: fixture.name,
      projects: [primaryProject, linkedProject],
    };
    const pending: Promise<CliResult>[] = [];
    const hack = (cwd: string, args: readonly string[]) => {
      const task = ctx.cli({
        cwd,
        args,
        env: { HACK_COMPOSE_STARTUP_TIMEOUT_MS: "150000" },
        timeoutMs: COMMAND_MS,
      });
      pending.push(task);
      return task;
    };
    const succeed = async (cwd: string, args: readonly string[]) => {
      const result = await hack(cwd, args);
      expectExit({
        result,
        codes: [0],
        message: `hack ${args.join(" ")} (P01 fixture)`,
      });
      return result;
    };
    const refused = (result: CliResult, message: string) =>
      expect({
        that: !result.timedOut && result.exitCode !== 0,
        message,
        result,
      });
    const up = async (cwd: string) => {
      const result = await succeed(cwd, ["up", "--json"]);
      expect({
        that:
          extractJsonObject<{ ok?: boolean }>({ text: result.stdout })?.ok ===
          true,
        message: "hack up --json must report a successful envelope",
        result,
      });
    };
    const only = async (project: string, service: string) => {
      const resources = await ownedContainers({ ...owned, project, service });
      expect({
        that: resources.length === 1,
        message: `exactly one owned ${service} container in ${project}`,
      });
      return resources[0] as NonNullable<(typeof resources)[number]>;
    };
    const installerVolume = async (project: string) => {
      const mount = (await only(project, "install")).Mounts?.find(
        (entry) => entry.Destination === CACHE
      );
      expect({
        that:
          mount?.Type === "volume" &&
          mount.RW &&
          mount.Name?.startsWith(`hack-cache-${fixture.name}-dependencies-`) ===
            true,
        message: "installer must write one fingerprinted dependency volume",
      });
      return mount?.Name as string;
    };
    const consumerMounts = async (project: string) => {
      const app = await only(project, "app");
      const deps = app.Mounts?.find((entry) => entry.Destination === CACHE);
      const generated = app.Mounts?.find(
        (entry) => entry.Destination === "/generated"
      );
      expect({
        that:
          app.State?.Running === true &&
          deps?.Type === "volume" &&
          !deps.RW &&
          generated?.Type === "volume" &&
          !generated.RW,
        message:
          "running app must mount dependencies and generated output read-only",
      });
      return {
        dependencies: deps?.Name as string,
        generated: generated?.Name as string,
      };
    };
    const installerSaid = async (project: string, outcome: string) => {
      const logs = await checkedDocker({
        ctx,
        args: ["logs", (await only(project, "install")).Id as string],
      });
      expect({
        that: logs.stdout.includes(`Dependency cache ${outcome} (locked-v1).`),
        message: `installer in ${project} must report ${outcome}`,
        result: logs,
      });
    };
    const read = async (cwd: string, farewell: boolean) => {
      const result = await succeed(cwd, [
        "exec",
        "app",
        "--",
        "bun",
        "-e",
        READ_ARTIFACTS,
      ]);
      const payload = extractJsonObject<Readback>({ text: result.stdout });
      expect({
        that: payload !== null && payload.farewell === farewell,
        message: `consumer must read a complete ${farewell ? "new" : "old"} artifact`,
        result,
      });
      return payload as Readback;
    };
    /**
     * Every running consumer, in either instance, reads a complete artifact
     * from a ready payload and never mounts `excluded`.
     */
    const runningConsumersComplete = async (excluded: string) => {
      const apps = (await ownedContainers({ ...owned, service: "app" })).filter(
        (app) => app.State?.Running === true
      );
      for (const app of apps) {
        const mount = app.Mounts?.find((entry) => entry.Destination === CACHE);
        expect({
          that: mount?.Name !== excluded,
          message: "no consumer may mount the interrupted dependency volume",
        });
        const result = await docker({
          ctx,
          args: ["exec", app.Id as string, "bun", "-e", READ_ARTIFACTS],
        });
        expectExit({
          result,
          codes: [0],
          message: "running consumer must read a complete artifact",
        });
      }
      return apps.length;
    };
    const inspectVolume = async (volume: string, script: string) =>
      await docker({
        ctx,
        args: [
          "run",
          "--rm",
          "--pull=never",
          "--network=none",
          "--label",
          `${OWNER}=${fixture.name}`,
          "--label",
          `com.docker.compose.project=${linkedProject}`,
          "--volume",
          `${volume}:/deps:ro`,
          engine.image,
          "sh",
          "-c",
          script,
        ],
      });
    const incomplete = async (volume: string) => {
      const result = await inspectVolume(
        volume,
        "test -f /deps/.e2e-installer-began && test -f /deps/.hack-dependency-cache-v1/attempt && test ! -e /deps/.hack-dependency-cache-v1/ready && test ! -e /deps/.hack-dependency-cache-v1/ready.pending"
      );
      expectExit({
        result,
        codes: [0],
        message:
          "interrupted volume must be populated but carry no ready marker",
      });
    };
    const setInstaller = async (opts: {
      readonly command: readonly string[] | null;
      readonly generation: string;
    }) => {
      const compose = await readComposeFile(linked);
      const services = compose.services as Record<
        string,
        Record<string, unknown>
      >;
      const install = services.install as Record<string, unknown>;
      if (opts.command !== null) {
        install.command = [...opts.command];
      }
      (install.labels as Record<string, string>)[
        "hack.dependencies.cache-generation"
      ] = opts.generation;
      await writeComposeFile({ root: linked, compose });
    };
    try {
      // Cold start, then the fixture README's inspection commands.
      await up(fixture.root);
      await installerSaid(primaryProject, "initialized");
      const cold = await consumerMounts(primaryProject);
      const coldRead = await read(fixture.root, false);
      const ps = await succeed(fixture.root, ["ps", "--json"]);
      let psDocument: unknown = null;
      try {
        psDocument = JSON.parse(ps.stdout);
      } catch {
        psDocument = null;
      }
      expect({
        that: typeof psDocument === "object" && psDocument !== null,
        message: "hack ps --json must print one JSON document on stdout",
        result: ps,
      });
      await succeed(fixture.root, [
        "logs",
        "--no-follow",
        "--tail",
        "100",
        "install",
      ]);
      ctx.log("cold start installed, generated and served a complete artifact");

      // Warm restart: ordinary down keeps the payload; generation reruns.
      await succeed(fixture.root, ["down"]);
      await up(fixture.root);
      await installerSaid(primaryProject, "ready");
      const warm = await consumerMounts(primaryProject);
      expect({
        that: warm.dependencies === cold.dependencies,
        message: "warm start must reuse the same dependency volume",
      });
      const warmRead = await read(fixture.root, false);
      expect({
        that: warmRead.generatedAt !== coldRead.generatedAt,
        message: "the always-run generation step must publish a new artifact",
      });
      ctx.log("warm start reused the payload and regenerated the artifact");

      // Second worktree: shares the ready payload, owns its generated output.
      await up(linked);
      await installerSaid(linkedProject, "ready");
      const second = await consumerMounts(linkedProject);
      expect({
        that:
          second.dependencies === cold.dependencies &&
          second.generated !== cold.generated,
        message:
          "linked worktree must share the payload but own its generated volume",
      });
      await read(linked, false);
      ctx.log("linked worktree reused the payload with its own generation");

      // bun.lock change in the linked worktree selects a fresh payload.
      await mkdir(join(linked, "packages/farewell"), { recursive: true });
      await replaceFile({
        path: join(linked, "packages/farewell/package.json"),
        content: `${JSON.stringify({ name: "farewell", version: "1.0.0", type: "module", main: "index.js" }, null, 2)}\n`,
      });
      await replaceFile({
        path: join(linked, "packages/farewell/index.js"),
        content:
          "export function farewell(name) {\n  return `goodbye, ${name}`;\n}\n",
      });
      await replaceFile({
        path: join(linked, "package.json"),
        content: CHANGED_PACKAGE_JSON,
      });
      await replaceFile({
        path: join(linked, "bun.lock"),
        content: CHANGED_LOCK,
      });
      await up(linked);
      await installerSaid(linkedProject, "initialized");
      const changed = await consumerMounts(linkedProject);
      expect({
        that:
          changed.dependencies !== cold.dependencies &&
          changed.generated === second.generated,
        message:
          "a lock change must select a fresh payload and keep the instance's generated volume",
      });
      await read(linked, true);
      await read(fixture.root, false);
      expect({
        that:
          (await consumerMounts(primaryProject)).dependencies ===
          cold.dependencies,
        message: "the primary consumer must keep its complete old payload",
      });
      ctx.log("lock change installed a new payload; primary kept the old one");

      // Kill the installer mid-run under a fresh generation.
      await setInstaller({ command: INTERRUPTED_INSTALL, generation: "1" });
      const interrupted = hack(linked, ["up", "--json"]);
      let killedId = "";
      await waitFor({
        timeoutMs: 90_000,
        message: "interrupted installer never began writing its payload",
        check: async () => {
          const installers = await ownedContainers({
            ...owned,
            project: linkedProject,
            service: "install",
          });
          const running = installers.find((entry) => entry.State?.Running);
          if (!running?.Id) {
            return false;
          }
          const began = await docker({
            ctx,
            args: ["exec", running.Id, "test", "-f", BEGAN],
          });
          if (began.exitCode !== 0) {
            return false;
          }
          killedId = running.Id;
          return true;
        },
      });
      const interruptedVolume = await installerVolume(linkedProject);
      expect({
        that: (await runningConsumersComplete(interruptedVolume)) >= 1,
        message: "consumers stay on complete payloads while the writer runs",
      });
      await checkedDocker({ ctx, args: ["kill", "--signal=KILL", killedId] });
      refused(
        await interrupted,
        "a killed installer must fail startup rather than wait for a timeout"
      );
      await incomplete(interruptedVolume);
      await runningConsumersComplete(interruptedVolume);
      await read(fixture.root, false);
      ctx.log("killed installer left an incomplete payload no consumer mounts");

      // Negative control: the populated, unready payload is never reused.
      refused(
        await hack(linked, ["up", "--json"]),
        "a populated cache without a ready marker must not count as complete"
      );
      expect({
        that: (await installerVolume(linkedProject)) === interruptedVolume,
        message: "the same generation must address the quarantined volume",
      });
      await incomplete(interruptedVolume);
      await runningConsumersComplete(interruptedVolume);
      ctx.log("same-generation retry refused the incomplete payload");

      // Recovery: the declared installer under a new generation.
      await setInstaller({
        command: ["bun", "install", "--frozen-lockfile"],
        generation: "2",
      });
      await up(linked);
      await installerSaid(linkedProject, "initialized");
      const recovered = await consumerMounts(linkedProject);
      expect({
        that:
          recovered.dependencies !== interruptedVolume &&
          recovered.dependencies !== changed.dependencies &&
          recovered.dependencies !== cold.dependencies,
        message: "a generation bump must select a fresh, complete payload",
      });
      await read(linked, true);
      await read(fixture.root, false);
      ctx.log("generation bump recovered with a complete new payload");
    } catch (failure) {
      try {
        for (const resource of await ownedContainers(owned)) {
          const labels = resource.Config?.Labels ?? {};
          const logs = await docker({
            ctx,
            args: ["logs", "--tail", "40", resource.Id as string],
          });
          ctx.log(
            `${labels["com.docker.compose.project"]}/${labels["com.docker.compose.service"]} exit=${resource.State?.ExitCode}:\n${logs.combined.slice(-3000)}`
          );
        }
      } catch (diagnosticError) {
        ctx.log(`P01 diagnostics unavailable: ${String(diagnosticError)}`);
      }
      throw failure;
    } finally {
      await Promise.allSettled(pending);
      await cleanupPatternFixture({
        ...owned,
        checkouts: [fixture.root, linked],
      });
    }
  },
};
