import { expect, test } from "bun:test";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRetainedBuildFixtureEvidence,
  qualifyRetainedBuildFixtureBuilder,
  qualifyRetainedBuildFixtureCopy,
  RETAINED_BUILD_BOOTSTRAP_ENV,
  RETAINED_BUILD_BUILDER_FORMAT,
} from "./e2e/scenarios/native-compose-adoption-build-evidence.ts";
import { retainedBuildFixtureCopiedFiles } from "./e2e/scenarios/native-compose-adoption-build-inputs.ts";

const host = "unix:///synthetic-owned/docker.sock";
const env = { ...RETAINED_BUILD_BOOTSTRAP_ENV, DOCKER_HOST: host };
const version = `github.com/docker/buildx v0.28.0 ${"a".repeat(40)}\n`;
const builder = {
  name: "default",
  driver: "docker",
  nodes: [{ name: "default", endpoint: "default" }],
};

test("retained builder qualification uses fixed read-only Buildx queries and the default Docker driver", async () => {
  const calls: (readonly string[])[] = [];
  const stages: string[] = [];
  await qualifyRetainedBuildFixtureBuilder({
    mode: "root-specific",
    env,
    record: async (_mode, stage) => {
      stages.push(stage);
    },
    read: async (args) => {
      calls.push(args);
      return args[1] === "version" ? version : `\n${JSON.stringify(builder)}\n`;
    },
  });
  expect(calls).toEqual([
    ["buildx", "version"],
    [
      "buildx",
      "ls",
      "--timeout",
      "10s",
      "--format",
      RETAINED_BUILD_BUILDER_FORMAT,
    ],
  ]);
  expect(stages).toEqual(["builder-begin", "builder-qualified"]);
  expect(
    calls
      .flat()
      .some((arg) => ["create", "use", "build", "--bootstrap"].includes(arg))
  ).toBe(false);
});

for (const [name, changed] of [
  ["disabled BuildKit", { ...env, DOCKER_BUILDKIT: "0" }],
  ["foreign builder", { ...env, BUILDX_BUILDER: "foreign" }],
  ["foreign context", { ...env, DOCKER_CONTEXT: "foreign" }],
  ["remote socket", { ...env, DOCKER_HOST: "tcp://foreign:2375" }],
] as const) {
  test(`retained builder refuses unqualified transport ${name}`, async () => {
    let reads = 0;
    await expect(
      qualifyRetainedBuildFixtureBuilder({
        mode: "hack-default",
        env: changed,
        record: async () => {},
        read: async () => {
          reads += 1;
          return version;
        },
      })
    ).rejects.toThrow("values omitted");
    expect(reads).toBe(0);
  });
}

test.each([
  { ...builder, driver: "docker-container" },
  { ...builder, name: "foreign" },
  { ...builder, nodes: [{ name: "default", endpoint: "ssh://foreign" }] },
  { ...builder, nodes: [...builder.nodes, ...builder.nodes] },
  { ...builder, nodes: [] },
])("retained builder refuses remote/custom/multiple-node facts before qualification", async (row) => {
  const stages: string[] = [];
  await expect(
    qualifyRetainedBuildFixtureBuilder({
      mode: "root-specific",
      env,
      record: async (_mode, stage) => {
        stages.push(stage);
      },
      read: async (args) =>
        args[1] === "version" ? version : JSON.stringify(row),
    })
  ).rejects.toThrow("values omitted");
  expect(stages).toEqual(["builder-begin"]);
});

for (const mode of ["root-specific", "hack-default"] as const) {
  test(`complete ${mode} COPY bytes are retained before an unchanged oracle refusal`, async () => {
    const root = await mkdtemp(join(tmpdir(), "retained-copy-evidence-"));
    try {
      const record = createRetainedBuildFixtureEvidence({ tempRoot: root });
      const text = `wrong-marker ${"a".repeat(64)}\n\n`;
      await expect(
        qualifyRetainedBuildFixtureCopy({
          mode,
          record,
          read: async () => text,
        })
      ).rejects.toThrow("values omitted");
      const directory = join(root, "retained-build-stages");
      const paths = (await readdir(directory)).sort();
      expect(paths).toHaveLength(2);
      const row = JSON.parse(
        await readFile(join(directory, paths[1] ?? ""), "utf8")
      );
      expect(row.stage).toBe("copy-captured");
      expect(row.byteLength).toBe(Buffer.byteLength(text));
      expect(Buffer.from(row.copyBase64, "base64").toString()).toBe(text);
      expect((await lstat(join(directory, paths[1] ?? ""))).mode & 0o777).toBe(
        0o600
      );
      const valid = `${retainedBuildFixtureCopiedFiles(mode)
        .map((item) => `${item.path} ${item.hash}`)
        .join("\n")}\n`;
      await qualifyRetainedBuildFixtureCopy({
        mode,
        record,
        read: async () => valid,
      });
      const final = JSON.parse(
        await readFile(join(directory, "0005.json"), "utf8")
      );
      expect(final.stage).toBe("copy-qualified");
      const captured = JSON.parse(
        await readFile(join(directory, "0004.json"), "utf8")
      );
      expect(Buffer.from(captured.copyBase64, "base64").toString()).toBe(valid);
      expect(JSON.stringify(final)).not.toContain(valid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
