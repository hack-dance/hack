import { expect, test } from "bun:test";

import { __testOnly } from "../src/control-plane/extensions/linear/commands.ts";

test("parseSetupArgs parses project binding flags", () => {
  const parsed = __testOnly.parseSetupArgs({
    args: [
      "--profile",
      "work",
      "--project-id",
      "proj_123",
      "--project-name",
      "Platform",
      "--team-id",
      "team_123",
      "--json",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    profileId: "work",
    projectId: "proj_123",
    projectName: "Platform",
    teamId: "team_123",
    json: true,
  });
});

test("parseConnectArgs parses token connection flags", () => {
  const parsed = __testOnly.parseConnectArgs({
    args: [
      "--profile",
      "work",
      "--token",
      "secret-token",
      "--token-env",
      "CUSTOM_LINEAR_TOKEN",
      "--auth-ref",
      "linear.work.api",
      "--service",
      "hack-linear-work",
      "--api-url",
      "https://api.linear.app/graphql",
      "--refresh-token",
      "refresh-token",
      "--token-expires-at",
      "2026-03-05T12:00:00.000Z",
      "--refresh-token-expires-at",
      "2026-04-05T12:00:00.000Z",
      "--set-default",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    profileId: "work",
    token: "secret-token",
    tokenEnv: "CUSTOM_LINEAR_TOKEN",
    authRef: "linear.work.api",
    service: "hack-linear-work",
    apiUrl: "https://api.linear.app/graphql",
    refreshToken: "refresh-token",
    tokenExpiresAt: "2026-03-05T12:00:00.000Z",
    refreshTokenExpiresAt: "2026-04-05T12:00:00.000Z",
    stdin: false,
    setDefault: true,
  });
});

test("parseSyncIssueArgs rejects invalid direction", () => {
  const parsed = __testOnly.parseSyncIssueArgs({
    args: ["--from", "other"],
  });

  expect(parsed.ok).toBe(false);
  if (parsed.ok) {
    return;
  }
  expect(parsed.error).toContain("Expected linear|hack");
});

test("parseSyncProjectArgs parses owner filter and limits", () => {
  const parsed = __testOnly.parseSyncProjectArgs({
    args: [
      "--from",
      "hack",
      "--owner",
      "both",
      "--project-id",
      "proj_abc",
      "--team-id",
      "team_abc",
      "--limit",
      "25",
      "--sync-labels",
      "--json",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    from: "hack",
    ownerMode: "both",
    projectId: "proj_abc",
    teamId: "team_abc",
    limit: 25,
    syncLabels: true,
    json: true,
  });
});

test("connect falls back to oauth when no token input exists", () => {
  const envKey = "HACK_LINEAR_TEST_TOKEN";
  const previous = process.env[envKey];
  delete process.env[envKey];

  const fallback = __testOnly.shouldFallbackConnectToOAuth({
    parsed: {
      stdin: false,
      setDefault: false,
    },
    tokenEnv: envKey,
  });

  if (previous !== undefined) {
    process.env[envKey] = previous;
  } else {
    delete process.env[envKey];
  }

  expect(fallback).toBe(true);
});

test("connect does not fall back to oauth when token exists in env", () => {
  const envKey = "HACK_LINEAR_TEST_TOKEN";
  const previous = process.env[envKey];
  process.env[envKey] = "token-present";

  const fallback = __testOnly.shouldFallbackConnectToOAuth({
    parsed: {
      stdin: false,
      setDefault: false,
    },
    tokenEnv: envKey,
  });

  if (previous !== undefined) {
    process.env[envKey] = previous;
  } else {
    delete process.env[envKey];
  }

  expect(fallback).toBe(false);
});

test("oauth connect prefers broker flow when no local oauth overrides are provided", () => {
  const useBroker = __testOnly.shouldUseBrokerOAuthFlow({
    parsed: {
      setDefault: false,
      clientSecretStdin: false,
      noOpen: false,
      json: false,
    },
  });

  expect(useBroker).toBe(true);
});

test("oauth connect disables broker flow when local oauth overrides are provided", () => {
  const useBroker = __testOnly.shouldUseBrokerOAuthFlow({
    parsed: {
      setDefault: false,
      clientId: "client-id",
      clientSecretStdin: false,
      noOpen: false,
      json: false,
    },
  });

  expect(useBroker).toBe(false);
});

test("buildOAuthArgsFromConnectArgs maps connect defaults into oauth args", () => {
  const args = __testOnly.buildOAuthArgsFromConnectArgs({
    profileId: "work",
    parsed: {
      stdin: false,
      setDefault: true,
      apiUrl: "https://api.linear.app/graphql",
      tokenEnv: "LINEAR_TOKEN",
      authRef: "linear.api.work",
      service: "hack-linear-auth",
    },
  });

  expect(args).toEqual([
    "--profile",
    "work",
    "--set-default",
    "--api-url",
    "https://api.linear.app/graphql",
    "--token-env",
    "LINEAR_TOKEN",
    "--auth-ref",
    "linear.api.work",
    "--service",
    "hack-linear-auth",
  ]);
});
