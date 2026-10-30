import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveLifecycleComposeProjectName } from "../src/lib/lifecycle-runtime.ts";

const journalDir = mkdtempSync(join(tmpdir(), "hack-e2e-ownership-test-"));
process.env.HACK_E2E_OWNERSHIP_DIR = journalDir;

const {
  branchComposeProject,
  isOwnedComposeProject,
  recordOwnedFixture,
  recoverStaleOwnership,
  sweepOwnedComposeResources,
} = await import("./e2e/docker-ownership.ts");
const { checkScenarioDockerLeaks, describeDockerLeak, runScenarios } =
  await import("./e2e/harness.ts");

import type { DockerRunner } from "./e2e/docker-ownership.ts";

afterAll(async () => {
  await rm(journalDir, { recursive: true, force: true });
});

type Kind = "container" | "network" | "volume";
type FakeResource = { kind: Kind; id: string; name: string; project: string };

/**
 * In-memory docker that understands the ls/ps and rm calls the harness makes.
 * It renders the requested --format template like the real CLI, including
 * rejecting `{{.ID}}` for volumes (volumes have no ID; they are removed by
 * name). `available: false` simulates an unreachable daemon.
 */
function fakeDocker(
  initial: FakeResource[],
  options: { available?: boolean } = {}
): {
  docker: DockerRunner;
  resources: FakeResource[];
  calls: string[][];
} {
  const resources = [...initial];
  const calls: string[][] = [];
  const unavailable = {
    exitCode: 1,
    stdout: "",
    stderr: "Cannot connect to the Docker daemon",
  };
  const list = (kind: Kind, format: string) => {
    if (kind === "volume" && format.includes("{{.ID}}")) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          'template: :1:2: executing "" at <.ID>: can\'t evaluate field ID',
      };
    }
    return {
      exitCode: 0,
      stdout: resources
        .filter((resource) => resource.kind === kind)
        .map((resource) =>
          format
            .replace("{{.ID}}", resource.id)
            .replaceAll(/\{\{\.Names?\}\}/g, resource.name)
            .replace(/\{\{\.Label "[^"]+"\}\}/, resource.project)
        )
        .join("\n"),
      stderr: "",
    };
  };
  const remove = (kind: Kind, ref: string) => {
    const index = resources.findIndex(
      (resource) =>
        resource.kind === kind &&
        (kind === "volume" ? resource.name : resource.id) === ref
    );
    if (index < 0) {
      return { exitCode: 1, stdout: "", stderr: `no such ${kind}` };
    }
    resources.splice(index, 1);
    return { exitCode: 0, stdout: ref, stderr: "" };
  };
  const docker: DockerRunner = async (args) => {
    calls.push([...args]);
    if (options.available === false) {
      return unavailable;
    }
    const format = args[args.indexOf("--format") + 1] ?? "";
    if (args[0] === "ps") {
      return list("container", format);
    }
    if (args[0] === "rm") {
      return remove("container", args.at(-1) ?? "");
    }
    const kind = args[0] as Kind;
    return args[1] === "ls" ? list(kind, format) : remove(kind, args[2] ?? "");
  };
  return { docker, resources, calls };
}

function network(project: string): FakeResource {
  return {
    kind: "network",
    id: `net-${project}`,
    name: `${project}_default`,
    project,
  };
}

describe("e2e docker ownership", () => {
  test("branch instances use the CLI's compose project naming", () => {
    expect(branchComposeProject({ name: "e2e-abc", branch: "feat" })).toBe(
      resolveLifecycleComposeProjectName({
        projectName: "e2e-abc",
        branch: "feat",
      })
    );
  });

  test("owns recorded names and their branches only", () => {
    const names = new Set(["e2e-abc1"]);
    expect(isOwnedComposeProject({ project: "e2e-abc1", names })).toBe(true);
    expect(isOwnedComposeProject({ project: "e2e-abc1--feat", names })).toBe(
      true
    );
    expect(isOwnedComposeProject({ project: "e2e-abc12", names })).toBe(false);
    expect(isOwnedComposeProject({ project: "e2e-abc12--x", names })).toBe(
      false
    );
    expect(isOwnedComposeProject({ project: "e2e-ffff", names })).toBe(false);
    expect(isOwnedComposeProject({ project: "mhof_default", names })).toBe(
      false
    );
  });

  test("sweep removes owned containers, networks and volumes only", async () => {
    const fake = fakeDocker([
      {
        kind: "container",
        id: "c1",
        name: "e2e-abc1-web-1",
        project: "e2e-abc1",
      },
      network("e2e-abc1"),
      network("e2e-abc1--feat"),
      { kind: "volume", id: "v1", name: "e2e-abc1_data", project: "e2e-abc1" },
      network("e2e-other"),
      network("mhof"),
    ]);
    const result = await sweepOwnedComposeResources({
      docker: fake.docker,
      names: new Set(["e2e-abc1"]),
    });
    expect(result.failed).toEqual([]);
    expect(result.unlisted).toEqual([]);
    expect(result.removed.map((resource) => resource.id)).toEqual([
      "c1",
      "net-e2e-abc1",
      "net-e2e-abc1--feat",
      "e2e-abc1_data",
    ]);
    expect(fake.resources.map((resource) => resource.project)).toEqual([
      "e2e-other",
      "mhof",
    ]);
    expect(fake.calls.some((call) => call.includes("prune"))).toBe(false);
  });

  test("leak check reports owned leftovers and verifies the sweep", async () => {
    const fake = fakeDocker([network("e2e-abc1--feat"), network("e2e-other")]);
    const check = await checkScenarioDockerLeaks({
      docker: fake.docker,
      names: new Set(["e2e-abc1"]),
    });
    expect(check?.leaked.map((resource) => resource.project)).toEqual([
      "e2e-abc1--feat",
    ]);
    expect(check?.remaining).toEqual([]);
    expect(check && describeDockerLeak(check)).toContain(
      "scenario left 1 Docker network(s)"
    );
    expect(fake.resources.map((resource) => resource.project)).toEqual([
      "e2e-other",
    ]);
  });

  test("a clean scenario passes the leak check", async () => {
    const fake = fakeDocker([network("e2e-other")]);
    const check = await checkScenarioDockerLeaks({
      docker: fake.docker,
      names: new Set(["e2e-abc1"]),
    });
    expect(check && describeDockerLeak(check)).toBeNull();
  });

  test("runScenarios fails a docker scenario that leaves a network", async () => {
    const fake = fakeDocker([network("mhof")]);
    const outcomes = await runScenarios({
      dockerEnabled: true,
      docker: fake.docker,
      scenarios: [
        {
          name: "leaky",
          tier: "docker",
          summary: "creates a network and forgets it",
          run: async () => {
            recordOwnedFixture({ name: "e2e-1eaced" });
            fake.resources.push(network("e2e-1eaced--feat"));
          },
        },
        {
          name: "tidy",
          tier: "docker",
          summary: "creates and removes its network",
          run: async () => {
            recordOwnedFixture({ name: "e2e-71d1" });
            fake.resources.push(network("e2e-71d1"));
            fake.resources.pop();
          },
        },
      ],
    });
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fail", "pass"]);
    expect(outcomes[0]?.reason).toContain("e2e-1eaced--feat_default");
    expect(fake.resources.map((resource) => resource.project)).toEqual([
      "mhof",
    ]);
  });

  test("reclaims a dead run's journal and leaves live runs alone", async () => {
    const dir = join(journalDir, "recover");
    process.env.HACK_E2E_OWNERSHIP_DIR = dir;
    try {
      await Bun.write(
        join(dir, "111.json"),
        JSON.stringify({ pid: 111, names: ["e2e-dead"] })
      );
      await Bun.write(
        join(dir, "222.json"),
        JSON.stringify({ pid: 222, names: ["e2e-live"] })
      );
      const fake = fakeDocker([network("e2e-dead"), network("e2e-live")]);
      await recoverStaleOwnership({
        docker: fake.docker,
        isAlive: (pid) => pid === 222,
      });
      expect(fake.resources.map((resource) => resource.project)).toEqual([
        "e2e-live",
      ]);
      expect((await readdir(dir)).sort()).toEqual(["222.json"]);
    } finally {
      process.env.HACK_E2E_OWNERSHIP_DIR = journalDir;
    }
  });

  test("keeps a dead run's journal when docker cannot be listed", async () => {
    const dir = join(journalDir, "unavailable");
    process.env.HACK_E2E_OWNERSHIP_DIR = dir;
    try {
      await Bun.write(
        join(dir, "333.json"),
        JSON.stringify({ pid: 333, names: ["e2e-dead"] })
      );
      const { recovered } = await recoverStaleOwnership({
        docker: fakeDocker([], { available: false }).docker,
        isAlive: () => false,
      });
      expect(recovered[0]?.unlisted).toEqual([
        "container",
        "network",
        "volume",
      ]);
      expect(await readdir(dir)).toEqual(["333.json"]);
    } finally {
      process.env.HACK_E2E_OWNERSHIP_DIR = journalDir;
    }
  });
});
