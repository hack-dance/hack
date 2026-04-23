import { expect, test } from "bun:test";

import {
  inspectListeningTcpPorts,
  resolveLifecycleSingletonDecision,
} from "../src/lib/project-lifecycle-singleton.ts";

test("lifecycle singleton starts when no configured ports are occupied", () => {
  const decision = resolveLifecycleSingletonDecision({
    singleton: {
      ports: [3306, 9200],
      onConflict: "adopt",
    },
    occupiedPorts: [],
    serviceName: "proxy",
  });

  expect(decision).toEqual({ kind: "start" });
});

test("lifecycle singleton adopts an existing complete listener set", () => {
  const decision = resolveLifecycleSingletonDecision({
    singleton: {
      ports: [3306, 9200],
      onConflict: "adopt",
    },
    occupiedPorts: [9200, 3306],
    serviceName: "proxy",
  });

  expect(decision).toEqual({
    kind: "adopt",
    message:
      'Lifecycle process "proxy" adopted existing listeners on :3306, :9200. Hack will leave them running on down.',
  });
});

test("lifecycle singleton fails on partial listener occupancy", () => {
  const decision = resolveLifecycleSingletonDecision({
    singleton: {
      ports: [3306, 9200],
      onConflict: "adopt",
    },
    occupiedPorts: [3306],
    serviceName: "proxy",
  });

  expect(decision).toEqual({
    kind: "fail",
    message:
      'Lifecycle process "proxy" expected singleton ports :3306, :9200, but only :3306 already have listeners. Resolve the partial conflict before retrying.',
  });
});

test("lifecycle singleton fails when adoption is not enabled", () => {
  const decision = resolveLifecycleSingletonDecision({
    singleton: {
      ports: [3306, 9200],
    },
    occupiedPorts: [3306, 9200],
    serviceName: "proxy",
  });

  expect(decision).toEqual({
    kind: "fail",
    message:
      'Lifecycle process "proxy" cannot start because singleton ports :3306, :9200 already have listeners. Stop the existing process or set lifecycle.singleton.onConflict to "adopt".',
  });
});

test("inspectListeningTcpPorts detects occupied loopback ports without external tools", async () => {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {
        // This listener is only used to occupy a port for the probe.
      },
    },
  });

  try {
    await expect(
      inspectListeningTcpPorts({ ports: [listener.port] })
    ).resolves.toEqual([listener.port]);
  } finally {
    listener.stop();
  }
});

test("inspectListeningTcpPorts surfaces unexpected bind probe failures", async () => {
  await expect(inspectListeningTcpPorts({ ports: [-1] })).rejects.toThrow(
    "Failed to inspect singleton port :-1"
  );
});
