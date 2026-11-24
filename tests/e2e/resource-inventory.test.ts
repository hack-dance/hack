import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseLaunchctlGuard, runCli } from "./harness.ts";

test.skipIf(process.env.HACK_TEST_RESOURCES_DOCKER !== "1")(
  "lists two live projects and confirms detached-volume removal",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-resources-"));
    const hackHome = join(root, "state");
    const names = ["alpha", "beta", "detached"];
    const prefix = `hack-resource-${crypto.randomUUID()}`;
    const project = (tag: string) => `${prefix}-${tag}`;
    const checkout = (tag: string) => join(root, tag);
    const volume = (tag: string) => `${project(tag)}_data`;
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
    const started: string[] = [];
    try {
      await mkdir(hackHome);
      for (const tag of names) {
        const dir = join(checkout(tag), ".hack");
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, "docker-compose.yml"),
          `name: ${project(tag)}\nservices:\n  redis:\n    image: redis:7-alpine\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\n`
        );
        started.push(tag);
        const up = await cli([
          "up",
          "--detach",
          "--json",
          "--path",
          checkout(tag),
        ]);
        expect(up.exitCode).toBe(0);
      }
      expect(
        (await cli(["down", "--path", checkout("detached"), "--json"])).exitCode
      ).toBe(0);
      await rename(checkout("detached"), checkout("moved"));
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
      const selection = [
        "resources",
        "remove",
        `volume:${volume("detached")}`,
        "--json",
      ];
      const preview = await cli([...selection, "--dry-run"]);
      expect(preview.exitCode).toBe(0);
      const { token, message } = JSON.parse(preview.stdout).data;
      expect(message).toContain("cannot be undone");
      const unconfirmed = await cli(selection);
      expect(JSON.parse(unconfirmed.stdout).error.code).toBe(
        "E_INTERACTIVE_REQUIRED"
      );
      const wrong = await cli([...selection, "--confirm", "wrong"]);
      expect(JSON.parse(wrong.stdout).error.code).toBe("E_PLAN_REFUSED");
      const removed = await cli([...selection, "--confirm", token]);
      expect(JSON.parse(removed.stdout).data.removed).toBe(true);
    } finally {
      try {
        for (const tag of started) {
          const moved =
            tag === "detached" &&
            (await Bun.file(
              join(checkout("moved"), ".hack", "docker-compose.yml")
            ).exists());
          const root = moved ? checkout("moved") : checkout(tag);
          await cli(["down", "--path", root, "--json"]);
          const inspect = Bun.spawnSync(
            [
              "docker",
              "volume",
              "inspect",
              volume(tag),
              "--format",
              '{{index .Labels "com.docker.compose.project"}}',
            ],
            { stderr: "pipe" }
          );
          if (
            inspect.exitCode === 0 &&
            inspect.stdout.toString().trim() === project(tag)
          ) {
            const result = Bun.spawnSync(
              ["docker", "volume", "rm", volume(tag)],
              { stderr: "pipe" }
            );
            expect(result.exitCode).toBe(0);
          }
        }
      } finally {
        releaseLaunchctlGuard();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  360_000
);
