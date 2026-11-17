import { expect, test } from "bun:test";
import { gatewayProjectsPayload } from "../src/daemon/gateway-projects-payload.ts";

test("gateway projection omits registry-wide login activity and disabled project rows", () => {
  const hidden = "hidden-project-id";
  const payload = {
    generated_at: "fixture-time",
    include_unregistered: true,
    projects: [
      { project_id: "visible", name: "visible-project" },
      { project_id: hidden, name: "hidden-project" },
      { name: "unregistered" },
    ],
    autostart_global: {
      paused: false,
      login_run: {
        pending: [hidden],
        started: [hidden],
        failed: [hidden],
        in_progress: true,
      },
    },
  };
  for (const enabledProjectIds of [new Set(["visible"]), new Set<string>()]) {
    const projected = gatewayProjectsPayload({ payload, enabledProjectIds });
    const encoded = JSON.stringify(projected);
    expect(encoded).not.toContain(hidden);
    expect(encoded).not.toContain("autostart_global");
    expect(projected.projects).toHaveLength(enabledProjectIds.size);
    expect(projected.generated_at).toBe("fixture-time");
    expect(projected.include_unregistered).toBe(false);
  }
  expect(payload.autostart_global.login_run.pending).toEqual([hidden]);
  expect(payload.projects).toHaveLength(3);
});
