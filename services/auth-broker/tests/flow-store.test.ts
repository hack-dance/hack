import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FlowStore, hashDeviceCode } from "../src/flow-store.ts";
import type { GitHubOAuthFlow } from "../src/types.ts";

function createFlow(input: {
  readonly id: string;
  readonly nowMs: number;
}): GitHubOAuthFlow {
  return {
    id: input.id,
    provider: "github",
    state: `${input.id}-state`,
    profileId: "default",
    setDefault: true,
    deviceCodeHash: hashDeviceCode("device-code"),
    authorizeUrl: "https://github.com/login/oauth/authorize?state=test",
    appSlug: "hack-dance",
    appInstallUrl: "https://github.com/apps/hack-dance/installations/new",
    createdAtMs: input.nowMs,
    expiresAtMs: input.nowMs + 60_000,
    redirectUri: "https://auth.hack.broker/gh/callback",
    status: "pending",
  };
}

describe("FlowStore persistence", () => {
  test("persists flow state across process restarts", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "auth-broker-flow-store-"));
    const filePath = join(tempRoot, "flows.json");
    const nowMs = Date.now();

    try {
      const store = new FlowStore({ filePath });
      store.createFlow(
        createFlow({
          id: "flow-1",
          nowMs,
        })
      );
      store.markComplete({
        flowId: "flow-1",
        account: {
          login: "roodboi",
          installationIds: ["123"],
        },
        token: "gho_test",
        tokenExpiresAt: new Date(nowMs + 3_600_000).toISOString(),
        refreshToken: "ghr_refresh_test",
        refreshTokenExpiresAt: new Date(nowMs + 7_200_000).toISOString(),
        installationId: "123",
      });

      const reloaded = new FlowStore({ filePath });
      const flow = reloaded.getById("flow-1");
      expect(flow).not.toBeNull();
      expect(flow?.status).toBe("complete");
      expect(flow?.token).toBe("gho_test");
      expect(flow?.refreshToken).toBe("ghr_refresh_test");
      expect(flow?.refreshTokenExpiresAt).toBe(
        new Date(nowMs + 7_200_000).toISOString()
      );
      expect(flow?.account?.login).toBe("roodboi");

      const claimed = reloaded.getStatus({
        flowId: "flow-1",
        deviceCode: "device-code",
        claimToken: true,
        requireInstallation: true,
      });
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) {
        return;
      }
      expect(claimed.status.status).toBe("claimed");
      expect(claimed.status.token).toBe("gho_test");
      expect(claimed.status.refreshToken).toBe("ghr_refresh_test");
      expect(claimed.status.refreshTokenExpiresAt).toBe(
        new Date(nowMs + 7_200_000).toISOString()
      );

      const afterClaimReload = new FlowStore({ filePath });
      const claimedFlow = afterClaimReload.getById("flow-1");
      expect(claimedFlow?.status).toBe("claimed");
      expect(claimedFlow?.token).toBeUndefined();
      expect(claimedFlow?.refreshToken).toBeUndefined();
      expect(claimedFlow?.refreshTokenExpiresAt).toBeUndefined();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("pruneExpired removes persisted stale flows", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "auth-broker-flow-store-"));
    const filePath = join(tempRoot, "flows.json");
    const nowMs = Date.now();

    try {
      const store = new FlowStore({ filePath });
      store.createFlow({
        ...createFlow({
          id: "flow-expired",
          nowMs: nowMs - 10_000,
        }),
        expiresAtMs: nowMs - 1000,
      });
      store.pruneExpired({ nowMs });

      const reloaded = new FlowStore({ filePath });
      expect(reloaded.getById("flow-expired")).toBeNull();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
