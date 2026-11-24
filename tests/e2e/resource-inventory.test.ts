import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectDockerTransportEnvironment,
  readDockerDaemonIdentity,
} from "../../src/lib/docker-helper-environment.ts";
import {
  removeProjectRuntimeStateEntry,
  upsertProjectRuntimeStateEntry,
} from "../../src/lib/project-runtime-state.ts";
import {
  runDocker,
  sweepComplete,
  sweepOwnedComposeResources,
} from "./docker-ownership.ts";
import { releaseLaunchctlGuard, runCli } from "./harness.ts";

test.skipIf(process.platform !== "linux" || !Bun.which("docker"))(
  "lists two live projects and confirms detached-volume removal",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-resources-"));
    const hackHome = join(root, "state");
    const names = ["alpha", "beta", "detached"];
    const prefix = `hack-resource-${crypto.randomUUID()}`;
    const project = (tag: string) => `${prefix}-${tag}`;
    const checkout = (tag: string) => join(root, tag);
    const compose = (tag: string) =>
      tag === "detached" ? `${project(tag)}--review` : project(tag);
    const volume = (tag: string) => `${compose(tag)}_data`;
    const branchArgs = (tag: string) =>
      tag === "detached" ? ["--branch", "review"] : [];
    const cli = (args: readonly string[]) =>
      runCli({
        hackHome,
        invocation: {
          args,
          cwd: root,
          timeoutMs: 45_000,
          env: { HACK_RUNTIME_BACKEND: "compose", HACK_EXECUTION_MODE: "slim" },
        },
      });
    const docker = (args: readonly string[]) => {
      const result = Bun.spawnSync(["docker", ...args], {
        stderr: "pipe",
        timeout: 10_000,
      });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    const reason = (result: Awaited<ReturnType<typeof cli>>, code: string) => {
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stdout).error.detail.reason).toBe(code);
    };
    try {
      await mkdir(hackHome);
      for (const tag of names) {
        const dir = join(checkout(tag), ".hack");
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, "docker-compose.yml"),
          `name: ${project(tag)}\nservices:\n  redis:\n    image: redis:7-alpine\n    volumes:\n      - data:/data\n${tag === "alpha" ? "  init:\n    image: redis:7-alpine\n    volumes:\n      - data:/data\n" : ""}volumes:\n  data: {}\n`
        );
        if (tag === "detached") {
          await writeFile(
            join(dir, "hack.config.json"),
            JSON.stringify({ dev_host: `${project(tag)}.test` })
          );
        }
        const up = await cli([
          "up",
          "--detach",
          "--json",
          "--path",
          checkout(tag),
          ...branchArgs(tag),
        ]);
        expect(up.exitCode, JSON.parse(up.stdout).error?.message).toBe(0);
      }
      expect(
        (
          await cli([
            "down",
            "--path",
            checkout("detached"),
            "--json",
            ...branchArgs("detached"),
          ])
        ).exitCode
      ).toBe(0);
      await rename(checkout("detached"), checkout("moved"));
      const selection = [
        "resources",
        "remove",
        `volume:${volume("detached")}`,
        "--json",
      ];
      reason(await cli([...selection, "--dry-run"]), "registry_unknown");
      // Register the moved copy through a successful launch, then prove that
      // the original path being absent does not permit deleting its data.
      expect(
        (
          await cli([
            "up",
            "--detach",
            "--json",
            "--path",
            checkout("moved"),
            ...branchArgs("detached"),
          ])
        ).exitCode
      ).toBe(0);
      expect(
        (
          await cli([
            "down",
            "--path",
            checkout("moved"),
            "--json",
            ...branchArgs("detached"),
          ])
        ).exitCode
      ).toBe(0);
      expect((await cli(["projects", "prune", "--json"])).exitCode).toBe(0);
      reason(await cli([...selection, "--dry-run"]), "registry_reference");
      await rm(checkout("moved"), { recursive: true, force: true });
      expect((await cli(["projects", "prune", "--json"])).exitCode).toBe(0);

      // The same runtime key can be retained in a different checkout.
      const branchEntry = {
        composeProject: compose("detached"),
        envName: null,
        updatedAt: new Date().toISOString(),
      };
      const projectDir = join(checkout("beta"), ".hack");
      await upsertProjectRuntimeStateEntry({ projectDir, entry: branchEntry });
      reason(await cli([...selection, "--dry-run"]), "run_reference");
      await removeProjectRuntimeStateEntry({
        projectDir,
        composeProject: branchEntry.composeProject,
      });

      const foreign = volume("forged");
      docker([
        "volume",
        "create",
        "--label",
        `com.docker.compose.project=${project("forged")}`,
        "--label",
        "com.docker.compose.volume=data",
        foreign,
      ]);
      reason(
        await cli([
          "resources",
          "remove",
          `volume:${foreign}`,
          "--dry-run",
          "--json",
        ]),
        "receipt_mismatch"
      );
      const listWithoutProof = await cli(["resources", "list", "--json"]);
      expect(JSON.parse(listWithoutProof.stdout).data.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: foreign,
            refusal: expect.stringContaining("No Hack launch receipt"),
          }),
        ])
      );
      docker(["volume", "rm", foreign]);

      const engine = await readDockerDaemonIdentity({
        cwd: root,
        env: projectDockerTransportEnvironment(),
      });
      if (engine.kind !== "verified") {
        throw new Error("Expected a verified Docker engine");
      }
      const receiptPath = (daemon: string) =>
        join(
          hackHome,
          "resource-receipts",
          `${new Bun.CryptoHasher("sha256").update(JSON.stringify([daemon, "volume", volume("detached")])).digest("hex")}.json`
        );
      await rename(
        receiptPath(engine.id),
        receiptPath("different-fixture-engine")
      );
      reason(await cli([...selection, "--dry-run"]), "receipt_mismatch");
      await rename(
        receiptPath("different-fixture-engine"),
        receiptPath(engine.id)
      );

      const active = docker([
        "container",
        "inspect",
        `${project("alpha")}-redis-1`,
        "--format",
        "{{.Id}}",
      ]);
      docker(["container", "stop", `${project("alpha")}-init-1`]);
      const stopped = docker([
        "container",
        "inspect",
        `${project("alpha")}-init-1`,
        "--format",
        "{{.Id}}",
      ]);
      reason(
        await cli([
          "resources",
          "remove",
          `container:${active}`,
          "--dry-run",
          "--json",
        ]),
        "container_active"
      );
      reason(
        await cli([
          "resources",
          "remove",
          `container:${stopped}`,
          "--dry-run",
          "--json",
        ]),
        "project_not_down"
      );
      const list = await cli(["resources", "list", "--json"]);
      expect(list.exitCode).toBe(0);
      expect(JSON.parse(list.stdout).data.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: `${project("alpha")}-redis-1`,
            state: "running",
          }),
          expect.objectContaining({
            name: `${project("beta")}-redis-1`,
            state: "running",
          }),
          expect.objectContaining({
            id: volume("detached"),
            owners: [expect.objectContaining({ detached: true })],
            bytes: expect.any(Number),
          }),
        ])
      );
      const live = await cli([
        "resources",
        "remove",
        `volume:${volume("alpha")}`,
        "--dry-run",
        "--json",
      ]);
      expect(JSON.parse(live.stdout).error.message).toContain(
        "references this volume"
      );
      const preview = await cli([...selection, "--dry-run"]);
      expect(preview.exitCode).toBe(0);
      const { token, message } = JSON.parse(preview.stdout).data;
      const bridge = process.env.HACK_RESOURCE_CLI_OUTPUT;
      if (bridge) {
        await Bun.write(
          bridge,
          JSON.stringify({
            inventory: JSON.parse(list.stdout),
            preview: JSON.parse(preview.stdout),
          })
        );
      }
      expect(message).toContain("cannot be undone");
      const unconfirmed = await cli(selection);
      expect(JSON.parse(unconfirmed.stdout).error.code).toBe(
        "E_INTERACTIVE_REQUIRED"
      );
      const wrong = await cli([...selection, "--confirm", "wrong"]);
      expect(JSON.parse(wrong.stdout).error.code).toBe("E_PLAN_REFUSED");
      const removed = await cli([...selection, "--confirm", token]);
      expect(JSON.parse(removed.stdout).data.removed).toBe(true);
      docker([
        "volume",
        "create",
        "--label",
        `com.docker.compose.project=${compose("detached")}`,
        "--label",
        "com.docker.compose.volume=data",
        volume("detached"),
      ]);
      reason(await cli([...selection, "--confirm", token]), "receipt_mismatch");
      expect(
        JSON.parse(
          (await cli([...selection, "--dry-run", "--confirm", token])).stdout
        ).error.code
      ).toBe("E_USAGE");
    } finally {
      try {
        const cleanup = await sweepOwnedComposeResources({
          docker: runDocker,
          names: new Set([...names, "forged"].map(project)),
        });
        expect(sweepComplete(cleanup)).toBe(true);
      } finally {
        releaseLaunchctlGuard();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  360_000
);
