import { expect, test } from "bun:test";

import {
  buildDockerStatusProbe,
  detectDockerBackend,
  formatDockerConnectionGuidance,
} from "../src/lib/runtime-guidance.ts";

test("detectDockerBackend identifies Docker Desktop on macOS", async () => {
  const backend = await detectDockerBackend({
    isMac: true,
    pathExists: async (path) => path === "/Applications/Docker.app",
    findExecutableInPath: () => null,
  });

  expect(backend).toBeDefined();
  expect(backend?.name).toBe("Docker Desktop");
  expect(backend?.startCommand).toEqual(["open", "-a", "Docker"]);
});

test("detectDockerBackend prefers Docker Desktop when both macOS backends are installed", async () => {
  const backend = await detectDockerBackend({
    isMac: true,
    pathExists: async (path) =>
      path === "/Applications/Docker.app" ||
      path === "/Applications/OrbStack.app",
    findExecutableInPath: (name) =>
      name === "orbctl" ? "/usr/local/bin/orbctl" : null,
  });

  expect(backend).toBeDefined();
  expect(backend?.name).toBe("Docker Desktop");
  expect(backend?.startCommand).toEqual(["open", "-a", "Docker"]);
});

test("formatDockerConnectionGuidance preserves docker failure text and Desktop repair step", () => {
  const message = formatDockerConnectionGuidance({
    backend: {
      id: "docker-desktop",
      name: "Docker Desktop",
      startCommand: ["open", "-a", "Docker"],
    },
    failureText:
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
  });

  expect(message).toContain("Cannot connect to the Docker daemon");
  expect(message).toContain("Docker Desktop");
  expect(message).toContain("hack doctor");
});

test("formatDockerConnectionGuidance avoids macOS-only install text on Linux", async () => {
  const backend = await detectDockerBackend({
    isMac: false,
    findExecutableInPath: (name) =>
      name === "docker" ? "/usr/bin/docker" : null,
    pathExists: async () => false,
  });

  const message = formatDockerConnectionGuidance({
    backend,
    failureText: "Cannot connect to the Docker daemon",
  });

  expect(backend).toBeNull();
  expect(message).toContain("Install or start Docker");
  expect(message).not.toContain("Docker Desktop");
  expect(message).not.toContain("OrbStack");
});

test("buildDockerStatusProbe reports unreachable when docker is not installed", async () => {
  const result = await buildDockerStatusProbe({
    exec: async () => {
      throw new Error("should not execute");
    },
    findExecutableInPath: () => null,
  });

  expect(result.reachable).toBe(false);
});
