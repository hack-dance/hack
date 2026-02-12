import { expect, test } from "bun:test";
import type {
  RuntimeContainer,
  RuntimeProject,
  RuntimeService,
} from "../src/lib/runtime-projects.ts";
import {
  countRunningServices,
  filterRuntimeProjects,
  serializeRuntimeProject,
} from "../src/lib/runtime-projects.ts";

function makeContainer(opts: {
  readonly project: string;
  readonly service: string;
  readonly name: string;
  readonly state: string;
  readonly status: string;
  readonly ports?: string;
}): RuntimeContainer {
  return {
    id: `${opts.project}-${opts.service}-${opts.name}`,
    project: opts.project,
    service: opts.service,
    state: opts.state,
    status: opts.status,
    name: opts.name,
    ports: opts.ports ?? "",
    image: null,
    ip: null,
    mounts: [],
    labels: {},
    workingDir: `/tmp/${opts.project}/.hack`,
    image: "imbios/bun-node:latest",
    labels: {
      "com.docker.compose.project": opts.project,
      "com.docker.compose.service": opts.service,
    },
    mounts: [
      {
        type: "bind",
        source: `/tmp/${opts.project}`,
        destination: "/app",
        mode: "",
        rw: true,
      },
    ],
    networks: [
      {
        name: "default",
        ipAddress: "172.30.0.10",
        gateway: "172.30.0.1",
        aliases: [opts.service],
      },
    ],
  };
}

function makeRuntimeProject(opts: {
  readonly name: string;
  readonly isGlobal: boolean;
  readonly containersByService: Record<string, RuntimeContainer[]>;
}): RuntimeProject {
  const services = new Map<string, RuntimeService>();
  for (const [service, containers] of Object.entries(
    opts.containersByService
  )) {
    services.set(service, { service, containers });
  }
  return {
    project: opts.name,
    workingDir: `/tmp/${opts.name}/.hack`,
    services,
    isGlobal: opts.isGlobal,
  };
}

test("countRunningServices counts services with running containers", () => {
  const running = makeContainer({
    project: "alpha",
    service: "api",
    name: "alpha-api-1",
    state: "running",
    status: "Up 10s",
  });
  const stopped = makeContainer({
    project: "alpha",
    service: "worker",
    name: "alpha-worker-1",
    state: "exited",
    status: "Exited (0)",
  });
  const runtime = makeRuntimeProject({
    name: "alpha",
    isGlobal: false,
    containersByService: {
      api: [running],
      worker: [stopped],
    },
  });

  expect(countRunningServices(runtime)).toBe(1);
});

test("filterRuntimeProjects excludes global projects when disabled", () => {
  const local = makeRuntimeProject({
    name: "alpha",
    isGlobal: false,
    containersByService: {},
  });
  const global = makeRuntimeProject({
    name: "hack-logging",
    isGlobal: true,
    containersByService: {},
  });

  const filtered = filterRuntimeProjects({
    runtime: [local, global],
    includeGlobal: false,
  });

  expect(filtered).toEqual([local]);
});

test("serializeRuntimeProject includes container ports", () => {
  const runtime = makeRuntimeProject({
    name: "alpha",
    isGlobal: false,
    containersByService: {
      api: [
        makeContainer({
          project: "alpha",
          service: "api",
          name: "alpha-api-1",
          state: "running",
          status: "Up 10s",
          ports: "8080/tcp",
        }),
      ],
    },
  });

  const serialized = serializeRuntimeProject(runtime);
  const services = serialized.services as Record<string, unknown>[];
  expect(services[0]?.service).toBe("api");
  const containers = services[0]?.containers as Record<string, unknown>[];
  expect(containers[0]?.ports).toBe("8080/tcp");
  expect(containers[0]?.image).toBe("imbios/bun-node:latest");
  expect(containers[0]?.labels).toEqual({
    "com.docker.compose.project": "alpha",
    "com.docker.compose.service": "api",
  });
  expect(containers[0]?.mounts).toEqual([
    {
      type: "bind",
      source: "/tmp/alpha",
      destination: "/app",
      mode: "",
      rw: true,
    },
  ]);
  expect(containers[0]?.networks).toEqual([
    {
      name: "default",
      ip_address: "172.30.0.10",
      gateway: "172.30.0.1",
      aliases: ["api"],
    },
  ]);
});
