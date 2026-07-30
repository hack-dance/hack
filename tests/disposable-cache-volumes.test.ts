import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findMountedNamedVolumeCandidates,
  removeDisposableCacheVolumes,
  verifyDisposableCacheVolumes,
} from "../src/lib/disposable-cache-volumes.ts";
import type {
  RuntimeContainer,
  RuntimeProject,
} from "../src/lib/runtime-projects.ts";
import { serializeRuntimeProject } from "../src/lib/runtime-projects.ts";

let tempDir: string | null = null;
let originalPath: string | undefined;

beforeEach(async () => {
  originalPath = process.env.PATH;
  tempDir = await mkdtemp(join(tmpdir(), "hack-disposable-cache-"));
});

afterEach(async () => {
  process.env.PATH = originalPath;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("mounted-volume discovery requires exact checkout, project, and Compose labels", () => {
  const owned = buildRuntimeProject({
    project: "demo--feature",
    workingDir: "/repo/.hack",
    containers: [
      buildContainer({
        project: "demo--feature",
        service: "web",
        mounts: [
          {
            type: "volume",
            name: "demo-feature-web-next",
            source: "/var/lib/docker/volumes/demo-feature-web-next/_data",
            destination: "/app/apps/web/.next",
            mode: "rw",
            rw: true,
          },
          {
            type: "volume",
            source: "demo-feature-db",
            destination: "/var/lib/postgresql/data",
            mode: "rw",
            rw: true,
          },
          {
            type: "bind",
            source: "/repo",
            destination: "/app",
            mode: "rw",
            rw: true,
          },
        ],
      }),
    ],
  });
  const otherCheckout = buildRuntimeProject({
    project: "demo--feature",
    workingDir: "/other/.hack",
    containers: [
      buildContainer({
        project: "demo--feature",
        service: "web",
        mounts: [
          {
            type: "volume",
            source: "other-next",
            destination: "/app/.next",
            mode: "rw",
            rw: true,
          },
        ],
      }),
    ],
  });
  const otherProject = buildRuntimeProject({
    project: "demo--other",
    workingDir: "/repo/.hack",
    containers: [
      buildContainer({
        project: "demo--other",
        service: "web",
        mounts: [
          {
            type: "volume",
            source: "other-project-next",
            destination: "/app/.next",
            mode: "rw",
            rw: true,
          },
        ],
      }),
    ],
  });

  expect(
    findMountedNamedVolumeCandidates({
      composeProject: "demo--feature",
      currentProjectDir: "/repo/.hack",
      runtime: [owned, otherCheckout, otherProject],
    })
  ).toEqual([
    {
      name: "demo-feature-db",
      destinations: ["/var/lib/postgresql/data"],
      services: ["web"],
    },
    {
      name: "demo-feature-web-next",
      destinations: ["/app/apps/web/.next"],
      services: ["web"],
    },
  ]);
  const serialized = serializeRuntimeProject(owned) as {
    services: Array<{
      containers: Array<{
        mounts: Array<{ name?: string | null; source: string }>;
      }>;
    }>;
  };
  expect(serialized.services[0]?.containers[0]?.mounts[0]).toMatchObject({
    name: "demo-feature-web-next",
    source: "/var/lib/docker/volumes/demo-feature-web-next/_data",
  });
});

test("mounted-volume discovery rejects a mount without matching container ownership labels", () => {
  const runtime = buildRuntimeProject({
    project: "demo--feature",
    workingDir: "/repo/.hack",
    containers: [
      {
        ...buildContainer({
          project: "demo--feature",
          service: "web",
          mounts: [
            {
              type: "volume",
              source: "unproven-next",
              destination: "/app/.next",
              mode: "rw",
              rw: true,
            },
          ],
        }),
        labels: { "com.docker.compose.project": "demo--feature" },
      },
    ],
  });

  expect(
    findMountedNamedVolumeCandidates({
      composeProject: "demo--feature",
      currentProjectDir: "/repo/.hack",
      runtime: [runtime],
    })
  ).toEqual([]);
});

test("verification accepts .next or explicit disposable labels and protects data volumes", async () => {
  const dockerLogPath = await installDockerStub();
  const candidates = [
    { name: "owned-next", destinations: ["/app/.next"], services: ["web"] },
    {
      name: "owned-turbo",
      destinations: ["/app/.turbo"],
      services: ["web"],
    },
    {
      name: "owned-rust-target",
      destinations: ["/app/target"],
      services: ["worker"],
    },
    {
      name: "owned-database",
      destinations: ["/var/lib/postgresql/data"],
      services: ["database"],
    },
    {
      name: "unlabeled-turbo",
      destinations: ["/app/.turbo"],
      services: ["web"],
    },
    { name: "foreign-next", destinations: ["/app/.next"], services: ["web"] },
  ];

  const verified = await verifyDisposableCacheVolumes({
    composeProject: "demo--feature",
    candidates,
  });
  expect(
    verified.map((candidate) => ({
      name: candidate.name,
      reason: candidate.reason,
    }))
  ).toEqual([
    { name: "owned-next", reason: "next-destination" },
    { name: "owned-turbo", reason: "explicit-label" },
    { name: "owned-rust-target", reason: "explicit-label" },
  ]);

  const removal = await removeDisposableCacheVolumes({
    candidates: verified,
  });
  expect(removal).toEqual({
    removed: ["owned-next", "owned-turbo", "owned-rust-target"],
    failed: [],
  });
  const dockerLog = await Bun.file(dockerLogPath).text();
  expect(dockerLog).toContain("volume rm owned-next");
  expect(dockerLog).toContain("volume rm owned-turbo");
  expect(dockerLog).toContain("volume rm owned-rust-target");
  expect(dockerLog).not.toContain("volume rm owned-database");
  expect(dockerLog).not.toContain("volume rm unlabeled-turbo");
});

async function installDockerStub(): Promise<string> {
  if (!tempDir) {
    throw new Error("tempDir not set");
  }
  const binDir = join(tempDir, "bin");
  const dockerLogPath = join(tempDir, "docker.log");
  await mkdir(binDir, { recursive: true });
  const dockerPath = join(binDir, "docker");
  await writeFile(
    dockerPath,
    [
      "#!/bin/sh",
      `echo "$@" >> "${dockerLogPath}"`,
      'if [ "$1 $2 $3" = "volume inspect owned-next" ]; then',
      '  printf \'[{"Name":"owned-next","Labels":{"com.docker.compose.project":"demo--feature","com.docker.compose.volume":"next"}}]\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3" = "volume inspect owned-turbo" ]; then',
      '  printf \'[{"Name":"owned-turbo","Labels":{"com.docker.compose.project":"demo--feature","com.docker.compose.volume":"turbo","hack.cache.disposable":"true"}}]\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3" = "volume inspect owned-rust-target" ]; then',
      '  printf \'[{"Name":"owned-rust-target","Labels":{"com.docker.compose.project":"demo--feature","com.docker.compose.volume":"rust-target","hack.cache.disposable":"true"}}]\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3" = "volume inspect owned-database" ]; then',
      '  printf \'[{"Name":"owned-database","Labels":{"com.docker.compose.project":"demo--feature","com.docker.compose.volume":"database"}}]\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3" = "volume inspect unlabeled-turbo" ]; then',
      '  printf \'[{"Name":"unlabeled-turbo","Labels":{"com.docker.compose.project":"demo--feature","com.docker.compose.volume":"turbo"}}]\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3" = "volume inspect foreign-next" ]; then',
      '  printf \'[{"Name":"foreign-next","Labels":{"com.docker.compose.project":"other","com.docker.compose.volume":"next"}}]\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3" = "volume rm owned-next" ]; then',
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3" = "volume rm owned-turbo" ]; then',
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3" = "volume rm owned-rust-target" ]; then',
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n")
  );
  await chmod(dockerPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  return dockerLogPath;
}

function buildRuntimeProject(opts: {
  readonly project: string;
  readonly workingDir: string;
  readonly containers: readonly RuntimeContainer[];
}): RuntimeProject {
  return {
    project: opts.project,
    workingDir: opts.workingDir,
    isGlobal: false,
    services: new Map([
      ["web", { service: "web", containers: opts.containers }],
    ]),
  };
}

function buildContainer(opts: {
  readonly project: string;
  readonly service: string;
  readonly mounts: RuntimeContainer["mounts"];
}): RuntimeContainer {
  return {
    id: `${opts.project}-${opts.service}`,
    project: opts.project,
    service: opts.service,
    state: "exited",
    status: "Exited (0)",
    name: `${opts.project}-${opts.service}-1`,
    ports: "",
    workingDir: "/repo/.hack",
    image: "imbios/bun-node:latest",
    labels: {
      "com.docker.compose.project": opts.project,
      "com.docker.compose.service": opts.service,
    },
    mounts: opts.mounts,
    networks: [],
  };
}
