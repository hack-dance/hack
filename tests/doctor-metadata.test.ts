import { expect, test } from "bun:test";
import { buildDoctorJsonData } from "../src/commands/doctor.ts";
import { okResult } from "../src/lib/cli-result.ts";
import { doctorMetadata } from "../src/lib/doctor-metadata.ts";

test("doctor metadata distinguishes machine and project findings", () => {
  for (const id of [
    "docker",
    "network:hack-dev subnet",
    "resolver:hack",
    "daemon service",
  ]) {
    expect(doctorMetadata({ id }).scope).toBe("machine");
  }
  for (const id of [
    "project",
    "env key",
    "hack gitignore",
    "native settings",
    "lifecycle hygiene",
  ]) {
    expect(doctorMetadata({ id }).scope).toBe("project");
  }
  expect(doctorMetadata({ id: "local ca trust" })).toMatchObject({
    area: "certificates",
    scope: "machine",
    fix: { kind: "admin", args: ["global", "trust"] },
  });
  expect(
    doctorMetadata({ id: "secrets hygiene", scope: "machine" }).scope
  ).toBe("machine");
});

test("unknown checks and inherited object names offer no executable repair", () => {
  for (const id of [
    "new future check",
    "__proto__",
    "constructor",
    "toString",
  ]) {
    expect(doctorMetadata({ id })).toMatchObject({
      area: "other",
      scope: "project",
      fix: { kind: "manual", args: [] },
    });
  }
});

test("versioned doctor audit keeps schema inside data and never parses repair instructions", () => {
  const data = buildDoctorJsonData({
    results: [
      {
        name: "env key",
        status: "error",
        message: "run: sudo injected-command",
        durationMs: 0,
      },
    ],
  });
  expect(data).toMatchObject({
    schema: 1,
    counts: { error: 1 },
    checks: [
      {
        area: "env_secrets",
        scope: "project",
        fix: { kind: "manual", args: [] },
      },
    ],
  });
  const envelope = okResult({ data });
  expect(Object.keys(envelope)).toEqual(["ok", "data"]);
  expect(envelope.data.schema).toBe(1);
});
