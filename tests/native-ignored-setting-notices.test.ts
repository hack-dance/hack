import { expect, test } from "bun:test";
import {
  nativeIgnoredSettingNotices,
  reportNativeIgnoredSettingNotices,
} from "../src/backends/native-ignored-setting-notices.ts";

function warning(code: string, field: string) {
  return { severity: "warning", code, field, message: "runtime text" };
}

const plan = {
  services: {
    web: { active: true },
    api: { active: true },
    idle: { active: false },
  },
  diagnostics: [
    warning("labels_not_applied", "services.web.labels"),
    warning("logging_not_applied", "services.web.logging"),
    warning("mount_host_hint_ignored", "services.api.volumes"),
    // Two hinted mounts on one service are one notice.
    warning("mount_host_hint_ignored", "services.api.volumes"),
    // Inactive services, other codes, errors and malformed entries say nothing.
    warning("labels_not_applied", "services.idle.labels"),
    warning("terminal_not_allocated", "services.web.tty"),
    {
      severity: "error",
      code: "labels_not_applied",
      field: "services.api.labels",
    },
    warning("labels_not_applied", "services.web.labels.extra"),
    warning("labels_not_applied", "services.missing.labels"),
    warning("logging_not_applied", "services.web\nERROR: forged.logging"),
    null,
  ],
};

test("each ignored Compose setting is reported once per active service, without values", () => {
  expect(nativeIgnoredSettingNotices(plan)).toEqual([
    "Service api: host-only mount hints (cached, delegated, consistent, z, Z) are ignored on the native backend.",
    "Service web: labels are not applied to native containers.",
    "Service web: logging configuration is not applied; read container logs with hack logs.",
  ]);
});

test("a malformed plan yields no notice", () => {
  for (const malformed of [
    null,
    "plan",
    {},
    { services: {}, diagnostics: "none" },
    { services: [], diagnostics: [] },
  ]) {
    expect(nativeIgnoredSettingNotices(malformed)).toEqual([]);
  }
});

test("notices go through the caller's warning channel in order", () => {
  const lines: string[] = [];
  reportNativeIgnoredSettingNotices(plan, (line) => lines.push(line));
  expect(lines).toEqual(nativeIgnoredSettingNotices(plan));
  expect(lines).toHaveLength(3);
});
