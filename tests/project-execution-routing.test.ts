import { expect, test } from "bun:test";
import { createDefaultControlPlaneConfig } from "../src/control-plane/sdk/config.ts";
import {
  normalizeProjectExecutionMode,
  resolveProjectExecutionTarget,
} from "../src/lib/project-execution.ts";

test("normalizeProjectExecutionMode falls back to local for unknown values", () => {
  expect(normalizeProjectExecutionMode({ raw: undefined })).toBe("local");
  expect(normalizeProjectExecutionMode({ raw: "invalid" })).toBe("local");
  expect(normalizeProjectExecutionMode({ raw: "local_edit_remote_run" })).toBe(
    "local_edit_remote_run"
  );
  expect(normalizeProjectExecutionMode({ raw: "remote_devcontainer" })).toBe(
    "remote_devcontainer"
  );
});

test("auto defaults to local when no remote mode or node affinity exists", () => {
  const controlPlane = createDefaultControlPlaneConfig();
  const resolved = resolveProjectExecutionTarget({
    requestedTarget: undefined,
    controlPlane,
    defaultNodeId: undefined,
  });
  expect(resolved.resolvedTarget).toBe("local");
  expect(resolved.reason).toBe("auto_local_mode");
});

test("auto resolves remote when local_edit_remote_run mode is enabled", () => {
  const controlPlane = {
    ...createDefaultControlPlaneConfig(),
    execution: {
      ...createDefaultControlPlaneConfig().execution,
      mode: "local_edit_remote_run" as const,
    },
  };
  const resolved = resolveProjectExecutionTarget({
    requestedTarget: "auto",
    controlPlane,
    defaultNodeId: "default-node",
  });
  expect(resolved.resolvedTarget).toBe("remote");
  expect(resolved.nodeId).toBe("default-node");
  expect(resolved.nodeSelector).toBe("default");
});

test("auto resolves remote when project node affinity is configured", () => {
  const controlPlane = {
    ...createDefaultControlPlaneConfig(),
    nodeId: "project-node",
  };
  const resolved = resolveProjectExecutionTarget({
    requestedTarget: "auto",
    controlPlane,
    defaultNodeId: "default-node",
  });
  expect(resolved.resolvedTarget).toBe("remote");
  expect(resolved.nodeId).toBe("project-node");
  expect(resolved.nodeSelector).toBe("project-node");
  expect(resolved.reason).toBe("auto_project_node");
});

test("execution.nodeId overrides legacy controlPlane.nodeId", () => {
  const controlPlane = {
    ...createDefaultControlPlaneConfig(),
    nodeId: "legacy-node",
    execution: {
      ...createDefaultControlPlaneConfig().execution,
      nodeId: "execution-node",
    },
  };
  const resolved = resolveProjectExecutionTarget({
    requestedTarget: "remote",
    controlPlane,
    defaultNodeId: "default-node",
  });
  expect(resolved.nodeId).toBe("execution-node");
  expect(resolved.nodeSelector).toBe("execution-node");
});

test("remote target requires a selected or default node", () => {
  const controlPlane = createDefaultControlPlaneConfig();
  expect(() =>
    resolveProjectExecutionTarget({
      requestedTarget: "remote",
      controlPlane,
      defaultNodeId: undefined,
    })
  ).toThrow("Remote execution requires a project node");
});

test("auto remote mode requires a selected or default node", () => {
  const controlPlane = {
    ...createDefaultControlPlaneConfig(),
    execution: {
      ...createDefaultControlPlaneConfig().execution,
      mode: "remote_devcontainer" as const,
    },
  };
  expect(() =>
    resolveProjectExecutionTarget({
      requestedTarget: "auto",
      controlPlane,
      defaultNodeId: undefined,
    })
  ).toThrow("Remote execution requires a project node");
});

test("invalid target values throw usage errors", () => {
  const controlPlane = createDefaultControlPlaneConfig();
  expect(() =>
    resolveProjectExecutionTarget({
      requestedTarget: "somewhere",
      controlPlane,
      defaultNodeId: "node-1",
    })
  ).toThrow("Invalid --target value");
});
