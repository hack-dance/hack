import { expect, test } from "bun:test";
import { resourceFingerprint } from "../src/lib/resource-receipts.ts";
import {
  COMPOSE_DIRECTORY,
  COMPOSE_PROJECT,
  COMPOSE_SERVICE,
  COMPOSE_VOLUME,
  dockerDiskBytes,
  dockerNames,
  RESOURCE_NAME,
} from "../src/lib/resources-docker.ts";

test("volume receipts bind the creation observation and refuse opaque backing stores", () => {
  const row = {
    id: "example_data",
    labels: { [COMPOSE_PROJECT]: "example", [COMPOSE_VOLUME]: "data" },
    driver: "local",
    scope: "local",
    options: null,
    created: "2026-11-24T00:00:00Z",
  };
  const fingerprint = resourceFingerprint("volume", row);
  expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(
    resourceFingerprint("volume", { ...row, created: "2026-11-25T00:00:00Z" })
  ).not.toBe(fingerprint);
  expect(resourceFingerprint("volume", { ...row, id: "foreign" })).toBeNull();
  expect(
    resourceFingerprint("volume", { ...row, options: { type: "nfs" } })
  ).toBeNull();
});

test("container ownership evidence binds the full ID, service, and checkout", () => {
  const row = {
    id: "a".repeat(64),
    labels: {
      [COMPOSE_PROJECT]: "example",
      [COMPOSE_DIRECTORY]: "/work/example/.hack",
      [COMPOSE_SERVICE]: "web",
    },
  };
  expect(resourceFingerprint("container", row)).not.toBe(
    resourceFingerprint("container", { ...row, id: "b".repeat(64) })
  );
  expect(
    resourceFingerprint("container", {
      ...row,
      labels: { [COMPOSE_PROJECT]: "example" },
    })
  ).toBeNull();
});

test("Docker disk estimates preserve unknown sizes and reject malformed IDs", () => {
  expect(dockerDiskBytes("1.25GB")).toBe(1_250_000_000);
  expect(dockerDiskBytes("0B")).toBe(0);
  expect(dockerDiskBytes("N/A")).toBeNull();
  expect(dockerNames("known\n--force", RESOURCE_NAME)).toBeNull();
});
