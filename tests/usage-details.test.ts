import { expect, test } from "bun:test";
import { __testOnlyUsage } from "../src/commands/usage.ts";
import type {
  RuntimeContainer,
  RuntimeProject,
} from "../src/lib/runtime-projects.ts";

function container(
  id: string,
  state: string,
  lifecycle = false
): RuntimeContainer {
  return {
    id,
    state,
    project: "fixture--branch",
    service: "web",
    name: id,
    status: state,
    ports: "",
    workingDir: "/fixture/.hack",
    image: "fixture",
    labels: lifecycle ? { "hack.lifecycle.process": "true" } : {},
    mounts: [
      {
        type: "volume",
        source: "/volume",
        destination: "/app/node_modules",
        mode: "rw",
        rw: true,
      },
    ],
    networks: [],
  };
}

test("usage samples only running Docker containers and retains service/mount attribution", () => {
  const project: RuntimeProject = {
    project: "fixture--branch",
    workingDir: "/fixture/.hack",
    isGlobal: false,
    services: new Map([
      [
        "web",
        {
          service: "web",
          containers: [
            container("running", "running"),
            container("stopped", "exited"),
            container("created", "created"),
            container("host", "running", true),
          ],
        },
      ],
    ]),
  };
  const index = __testOnlyUsage.buildContainerIndex({ projects: [project] });
  expect(index.containerIds).toEqual(["running"]);
  const report = __testOnlyUsage.buildUsageReport({
    projects: [project],
    index,
    samples: [
      {
        containerId: "running",
        cpuPercent: 12,
        memUsedBytes: 1024,
        memLimitBytes: 4096,
        memPercent: 25,
        netInputBytes: 0,
        netOutputBytes: 0,
        blockInputBytes: 0,
        blockOutputBytes: 0,
        pids: 4,
      },
    ],
  });
  expect(report.projects[0]?.containers).toBe(1);
  expect(report.containerDetails?.[0]).toMatchObject({
    project: "fixture--branch",
    service: "web",
    name: "running",
    memUsedBytes: 1024,
    mounts: [{ type: "volume", destination: "/app/node_modules" }],
  });
});
