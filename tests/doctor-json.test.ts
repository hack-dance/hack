import { expect, test } from "bun:test";

import { buildDoctorJsonData } from "../src/commands/doctor.ts";

test("buildDoctorJsonData maps checks to id/status/detail and counts", () => {
  const data = buildDoctorJsonData({
    results: [
      {
        name: "docker",
        status: "ok",
        message: "/usr/local/bin/docker",
        durationMs: 5,
      },
      {
        name: "docker daemon",
        status: "error",
        message: "Not running",
        durationMs: 12,
      },
      {
        name: "gum (optional)",
        status: "warn",
        message: "Not found (optional)",
        durationMs: 1,
      },
    ],
  });

  expect(data.checks).toEqual([
    {
      id: "docker",
      status: "ok",
      detail: "/usr/local/bin/docker",
      durationMs: 5,
    },
    {
      id: "docker daemon",
      status: "error",
      detail: "Not running",
      durationMs: 12,
    },
    {
      id: "gum (optional)",
      status: "warn",
      detail: "Not found (optional)",
      durationMs: 1,
    },
  ]);
  expect(data.counts).toEqual({ ok: 1, warn: 1, error: 1 });
  expect(Array.isArray(data.summary)).toBe(true);
});

test("buildDoctorJsonData handles an all-ok run", () => {
  const data = buildDoctorJsonData({
    results: [
      { name: "bun", status: "ok", message: "/usr/bin/bun", durationMs: 2 },
    ],
  });
  expect(data.counts).toEqual({ ok: 1, warn: 0, error: 0 });
  expect(data.checks[0]?.id).toBe("bun");
});

test("buildDoctorJsonData adds only superseded-root counts and fingerprints", () => {
  const supersededRoots = {
    count: 2,
    expired: 1,
    notYetValid: 0,
    sha256: ["A".repeat(64), "B".repeat(64)],
  };
  const data = buildDoctorJsonData({
    results: [
      {
        name: "superseded caddy roots",
        status: "warn",
        message: "2 superseded Caddy roots remain",
        durationMs: 3,
        supersededRoots,
      },
      { name: "bun", status: "ok", message: "/usr/bin/bun", durationMs: 2 },
    ],
  });
  expect(data.checks[0]).toStrictEqual({
    id: "superseded caddy roots",
    status: "warn",
    detail: "2 superseded Caddy roots remain",
    durationMs: 3,
    supersededRoots,
  });
  expect(Object.keys(data.checks[1] ?? {})).toEqual([
    "id",
    "status",
    "detail",
    "durationMs",
  ]);
  expect(data.counts).toEqual({ ok: 1, warn: 1, error: 0 });
});
