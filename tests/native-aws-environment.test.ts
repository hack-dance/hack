import { expect, test } from "bun:test";
import {
  adaptNativeAwsEnvironment,
  type NativeAwsExportSource,
} from "../src/backends/native-aws-environment.ts";
import type { NativeProjectInput } from "../src/backends/native-project-input.ts";

const now = Date.parse("2026-09-20T12:00:00Z");
const exported = {
  Version: 1,
  AccessKeyId: "synthetic-access",
  SecretAccessKey: "synthetic-secret",
  SessionToken: "synthetic-session",
  Expiration: "2026-09-20T13:00:00Z",
};
const source: NativeAwsExportSource = async () => ({
  credentials: exported,
  region: "us-east-1",
});
function input(
  volumes: unknown[] = ["${HOME}/.aws:/root/.aws:ro", "../src:/app:ro"]
): NativeProjectInput {
  return {
    originalSha256: "a".repeat(64),
    normalizedComposeJson: JSON.stringify({
      services: {
        app: {
          image: "sha256:pinned",
          volumes,
          environment: {
            AWS_CONFIG_FILE: "/root/.aws/config.container",
            AWS_PROFILE: "original",
            AWS_DEFAULT_PROFILE: "old",
            AWS_ACCESS_KEY_ID: "obsolete",
            KEEP: "public",
            AWS_REGION: "us-west-2",
          },
        },
        other: {
          image: "other",
          environment: { AWS_PROFILE: "untouched" },
          volumes: ["../:/other:ro"],
        },
      },
    }),
    managedEnvironment: {
      app: {
        APP_SECRET: "app-private",
        AWS_PROFILE: "private-old",
        AWS_SECRET_ACCESS_KEY: "stale",
        AWS_REGION: "us-west-2",
      },
      other: { OTHER_SECRET: "other-private" },
    },
    lifecycleHostEnvironment: { HOST_SECRET: "host-private" },
    effectiveEnvName: "qa",
    environmentFiles: [],
    serviceNames: ["app", "other"],
  };
}

test("explicit profile replaces only declared read-only AWS mount and scopes credentials privately", async () => {
  const original = input();
  const before = JSON.stringify(original);
  const result = await adaptNativeAwsEnvironment({
    input: original,
    profile: "livenation_qa",
    exportSource: source,
    now,
  });
  const compose = JSON.parse(result.input.normalizedComposeJson);
  expect(compose.services.app.volumes).toEqual(["../src:/app:ro"]);
  expect(compose.services.other).toEqual(
    JSON.parse(original.normalizedComposeJson).services.other
  );
  expect(compose.services.app.environment).toEqual({
    KEEP: "public",
    AWS_ACCESS_KEY_ID: null,
    AWS_SECRET_ACCESS_KEY: null,
    AWS_SESSION_TOKEN: null,
    AWS_REGION: "us-east-1",
    AWS_DEFAULT_REGION: "us-east-1",
  });
  expect(result.input.managedEnvironment.app).toEqual({
    APP_SECRET: "app-private",
    AWS_ACCESS_KEY_ID: exported.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: exported.SecretAccessKey,
    AWS_SESSION_TOKEN: exported.SessionToken,
  });
  expect(result.input.managedEnvironment.other).toEqual(
    original.managedEnvironment.other
  );
  expect(result.input.lifecycleHostEnvironment).toEqual(
    original.lifecycleHostEnvironment
  );
  expect(result.input.originalSha256).toBe(original.originalSha256);
  expect(JSON.stringify(original)).toBe(before);
  expect(result.receipt).toEqual({
    profile: "livenation_qa",
    expiry: exported.Expiration.replace("Z", ".000Z"),
    services: ["app"],
  });
  for (const value of Object.values(exported).filter(
    (v) => typeof v === "string" && v.startsWith("synthetic")
  )) {
    expect(result.input.normalizedComposeJson).not.toContain(value);
    expect(JSON.stringify(result.receipt)).not.toContain(value);
  }
});

test("long syntax and explicit region are supported without changing unrelated mounts", async () => {
  const result = await adaptNativeAwsEnvironment({
    input: input([
      {
        type: "bind",
        source: "/fixture/home/.aws",
        target: "/root/.aws",
        read_only: true,
      },
      "cache:/cache",
    ]),
    profile: "qa",
    homeDirectory: "/fixture/home",
    region: "eu-west-1",
    exportSource: source,
    now,
  });
  const app = JSON.parse(result.input.normalizedComposeJson).services.app;
  expect(app.volumes).toEqual(["cache:/cache"]);
  expect(app.environment.AWS_REGION).toBe("eu-west-1");
});

test("ambiguous/custom/writable AWS mounts refuse before exporting", async () => {
  let calls = 0;
  const exportSource: NativeAwsExportSource = async () => {
    calls++;
    return source({ profile: "qa" });
  };
  for (const volumes of [
    ["${HOME}/.aws:/root/.aws:rw"],
    ["/custom/.aws:/root/.aws:ro"],
    ["${HOME}/.aws:/home/app/.aws:ro"],
    ["${HOME}/.aws:/root/.aws:ro", "${HOME}/.aws:/root/.aws:ro"],
    [
      {
        type: "bind",
        source: "${HOME}/.aws",
        target: "/root/.aws",
        read_only: true,
        bind: { propagation: "shared" },
      },
    ],
    ["../:/app:ro"],
  ]) {
    await expect(
      adaptNativeAwsEnvironment({
        input: input(volumes),
        profile: "qa",
        exportSource,
        now,
      })
    ).rejects.toThrow("values omitted");
  }
  expect(calls).toBe(0);
});

test("expired/incomplete/malformed credentials and region refuse without leaking details", async () => {
  for (const credentials of [
    { ...exported, Expiration: "2026-09-20T12:00:30Z" },
    { ...exported, SessionToken: undefined },
    { ...exported, Version: 2 },
    { ...exported, SecretAccessKey: "" },
  ]) {
    await expect(
      adaptNativeAwsEnvironment({
        input: input(),
        profile: "qa",
        now,
        exportSource: async () => ({ credentials, region: "us-east-1" }),
      })
    ).rejects.toThrow("values omitted");
  }
  await expect(
    adaptNativeAwsEnvironment({
      input: input(),
      profile: "qa",
      now,
      exportSource: async () => ({
        credentials: exported,
        region: "bad region",
      }),
    })
  ).rejects.toThrow("values omitted");
  try {
    await adaptNativeAwsEnvironment({
      input: input(),
      profile: "qa",
      now,
      exportSource: async () => {
        throw new Error("synthetic-secret");
      },
    });
    throw new Error("expected refusal");
  } catch (error) {
    expect(String(error)).not.toContain("synthetic-secret");
  }
});

test("custom credential file selector refuses before export while list env strips selectors", async () => {
  const original = input();
  const compose = JSON.parse(original.normalizedComposeJson);
  compose.services.app.environment = [
    "AWS_PROFILE=old",
    "AWS_CONFIG_FILE=/root/.aws/config",
    "KEEP=yes",
  ];
  const result = await adaptNativeAwsEnvironment({
    input: { ...original, normalizedComposeJson: JSON.stringify(compose) },
    profile: "qa",
    now,
    exportSource: source,
  });
  expect(
    JSON.parse(result.input.normalizedComposeJson).services.app.environment
      .AWS_PROFILE
  ).toBeUndefined();
  compose.services.app.environment = { AWS_CONFIG_FILE: "/custom/config" };
  let called = false;
  await expect(
    adaptNativeAwsEnvironment({
      input: { ...original, normalizedComposeJson: JSON.stringify(compose) },
      profile: "qa",
      now,
      exportSource: async () => {
        called = true;
        return source({ profile: "qa" });
      },
    })
  ).rejects.toThrow("values omitted");
  expect(called).toBe(false);
});
