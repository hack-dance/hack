import { expect, test } from "bun:test";

import {
  parseTailscaleOauthConnectArgs,
  parseTailscaleOauthDisconnectArgs,
  parseTailscaleOauthStatusArgs,
} from "../src/control-plane/extensions/tailscale/commands.ts";

test("parseTailscaleOauthStatusArgs supports json + validate", () => {
  const result = parseTailscaleOauthStatusArgs({
    args: ["--json", "--validate"],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.value.json).toBe(true);
  expect(result.value.validate).toBe(true);
});

test("parseTailscaleOauthStatusArgs rejects unknown flags", () => {
  const result = parseTailscaleOauthStatusArgs({ args: ["--wat"] });
  expect(result.ok).toBe(false);
});

test("parseTailscaleOauthConnectArgs parses explicit values", () => {
  const result = parseTailscaleOauthConnectArgs({
    args: [
      "--json",
      "--client-id",
      "client-id-1",
      "--client-secret",
      "secret-1",
      "--auth-ref",
      "tailscale.oauth.team",
      "--tailnet",
      "example",
      "--key-expiry-seconds",
      "1800",
    ],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.value.clientId).toBe("client-id-1");
  expect(result.value.clientSecret).toBe("secret-1");
  expect(result.value.clientSecretStdin).toBe(false);
  expect(result.value.authRef).toBe("tailscale.oauth.team");
  expect(result.value.tailnet).toBe("example");
  expect(result.value.keyExpirySeconds).toBe(1800);
});

test("parseTailscaleOauthConnectArgs supports stdin secret mode", () => {
  const result = parseTailscaleOauthConnectArgs({
    args: ["--client-id", "client-id-1", "--client-secret-stdin"],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.value.clientSecretStdin).toBe(true);
  expect(result.value.clientSecret).toBe("");
});

test("parseTailscaleOauthConnectArgs rejects invalid expiry", () => {
  const result = parseTailscaleOauthConnectArgs({
    args: ["--client-id", "x", "--key-expiry-seconds", "0"],
  });
  expect(result.ok).toBe(false);
});

test("parseTailscaleOauthDisconnectArgs parses auth ref", () => {
  const result = parseTailscaleOauthDisconnectArgs({
    args: ["--json", "--auth-ref", "tailscale.oauth.default"],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.value.json).toBe(true);
  expect(result.value.authRef).toBe("tailscale.oauth.default");
});
