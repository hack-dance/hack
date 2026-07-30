import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findDisposableNextCacheVolumes,
  removeDisposableCacheVolumes,
  verifyComposeOwnedCacheVolumes,
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

test("cache discovery requires exact checkout, project, Compose labels, and .next destination", () => {
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
    findDisposableNextCacheVolumes({
      composeProject: "demo--feature",
      currentProjectDir: "/repo/.hack",
      runtime: [owned, otherCheckout, otherProject],
    })
  ).toEqual([
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

test("cache discovery rejects a .next mount without matching container ownership labels", () => {
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
    findDisposableNextCacheVolumes({
      composeProject: "demo--feature",
      currentProjectDir: "/repo/.hack",
      runtime: [runtime],
    })
  ).toEqual([]);
});

test("volume verification and removal require independent Compose volume labels", async () => {
  const dockerLogPath = await installDockerStub();
  const candidates = [
    { name: "owned-next", destinations: ["/app/.next"], services: ["web"] },
    { name: "foreign-next", destinations: ["/app/.next"], services: ["web"] },
  ];

  const verified = await verifyComposeOwnedCacheVolumes({
    composeProject: "demo--feature",
    candidates,
  });
  expect(verified.map((candidate) => candidate.name)).toEqual(["owned-next"]);

  const removal = await removeDisposableCacheVolumes({
    candidates: verified,
  });
  expect(removal).toEqual({ removed: ["owned-next"], failed: [] });
  expect(await Bun.file(dockerLogPath).text()).toContain(
    "volume rm owned-next"
  );
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
      'if [ "$1 $2 $3" = "volume inspect foreign-next" ]; then',
      '  printf \'[{"Name":"foreign-next","Labels":{"com.docker.compose.project":"other","com.docker.compose.volume":"next"}}]\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3" = "volume rm owned-next" ]; then',
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
