import { expect, test } from "bun:test";
import { nativeRestartPolicyNotices } from "../src/backends/native-restart-policy-notices.ts";

const warning = (field: string) => ({
  severity: "warning",
  code: "restart_policy_not_applied",
  field,
  message: "fixed",
});

test("each warned active service is named once with its reviewed policy", () => {
  const notices = nativeRestartPolicyNotices({
    services: {
      web: { active: true, restart: "unless-stopped" },
      api: { active: true, restart: "on-failure:3" },
      worker: { active: true, restart: "always" },
    },
    diagnostics: [
      warning("services.web.restart"),
      warning("services.web.restart"),
      warning("services.api.restart"),
      { ...warning("services.worker.restart"), severity: "error" },
      { ...warning("services.worker.restart"), code: "other" },
    ],
  });
  expect(notices).toEqual([
    "Service api: restart: on-failure:3 is not applied. Restart policies are not applied yet to services with published ports or routes (HACK-1935); the service starts without automatic restarts.",
    "Service web: restart: unless-stopped is not applied. Restart policies are not applied yet to services with published ports or routes (HACK-1935); the service starts without automatic restarts.",
  ]);
});

test("unreviewed names, policies outside the grammar and inactive services are never echoed", () => {
  for (const [service, value] of [
    ["../web", { active: true, restart: "always" }],
    ["web", { active: true, restart: "always; secret" }],
    ["web", { active: true, restart: "on-failure:0" }],
    ["web", { active: true, restart: "no" }],
    ["web", { active: false, restart: "always" }],
    ["web", { restart: "always" }],
  ] as const) {
    expect(
      nativeRestartPolicyNotices({
        services: { [service]: value },
        diagnostics: [warning(`services.${service}.restart`)],
      })
    ).toEqual([]);
  }
  for (const plan of [
    undefined,
    {},
    { services: {}, diagnostics: "x" },
    { services: [], diagnostics: [] },
  ]) {
    expect(nativeRestartPolicyNotices(plan)).toEqual([]);
  }
});
