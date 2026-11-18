import { expect, test } from "bun:test";
import {
  nativeManagedRestartNotices,
  nativePrivatelyDeliveredServices,
  nativeRestartPolicyNotices,
} from "../src/backends/native-restart-policy-notices.ts";

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

test("HACK-2324: only active, privately delivered services with an automatic policy are named", () => {
  // Mirrors the runtime's managed-environment set: non-empty values only.
  // A file-only recipient keeps its restart policy, so it is not named.
  const delivered = nativePrivatelyDeliveredServices({
    managedEnvironment: { web: { TOKEN: "x" }, empty: {} },
    shellEnvironment: { shell: { VALUE: "x" }, blank: {} },
  });
  expect([...delivered].sort()).toEqual(["shell", "web"]);
  const restart = (policy: string) => ({ image: "x", restart: policy });
  const notices = nativeManagedRestartNotices({
    compose: {
      services: {
        web: restart("unless-stopped"),
        adc: restart("on-failure:3"),
        shell: restart("on-failure:3"),
        none: restart("no"),
        worker: restart("always"),
        inactive: restart("always"),
        "bad name!": restart("always"),
      },
    },
    plan: {
      services: {
        web: { active: true },
        adc: { active: true },
        shell: { active: true },
        none: { active: true },
        worker: { active: true },
        inactive: { active: false },
        "bad name!": { active: true },
      },
    },
    delivered: new Set([...delivered, "none", "inactive", "bad name!"]),
  });
  expect(notices.map((notice) => notice.service)).toEqual(["shell", "web"]);
  expect(notices[0]?.line).toContain("restart: on-failure:3 is not applied");
  expect(notices[0]?.line).toContain(
    "run hack restart, which restarts the whole project"
  );
});
