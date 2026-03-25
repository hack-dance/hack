import { describe, expect, test } from "bun:test";

import { __testOnly } from "../src/control-plane/extensions/github/commands.ts";

describe("github command parsing", () => {
  test("parseStatusArgs accepts --json and --profile in either order", () => {
    const first = __testOnly.parseStatusArgs({
      args: ["--profile", "work", "--json"],
    });
    expect(first).toEqual({
      ok: true,
      value: { profileId: "work", json: true },
    });

    const second = __testOnly.parseStatusArgs({
      args: ["--json", "--profile", "work"],
    });
    expect(second).toEqual({
      ok: true,
      value: { profileId: "work", json: true },
    });
  });

  test("parseProfilesArgs accepts optional --json", () => {
    expect(__testOnly.parseProfilesArgs({ args: [] })).toEqual({
      ok: true,
      value: { json: false },
    });
    expect(__testOnly.parseProfilesArgs({ args: ["--json"] })).toEqual({
      ok: true,
      value: { json: true },
    });
  });
});

describe("github profile payload rendering", () => {
  test("buildGitHubProfilesPayload emits deterministic profile payload", () => {
    const payload = __testOnly.buildGitHubProfilesPayload({
      catalog: {
        selectedProfileId: "work",
        selectedProfileSource: "command_flags",
        defaultProfileId: "work",
        projectProfileOverride: "work",
        selectedProfileMissing: false,
        profiles: [
          {
            id: "work",
            isDefault: true,
            mode: "token",
            authRef: "github.work.token",
            service: "hack-github",
            appId: "app_123",
            installationId: "456",
            accountLogin: "octocat-work",
            accountName: "Octo Cat Work",
            accountId: "999",
          },
        ],
      },
    });

    expect(payload).toMatchObject({
      selectedProfile: "work",
      selectedSource: "command_flags",
      defaultProfile: "work",
      projectOverride: "work",
      selectedMissing: false,
      profiles: [
        {
          id: "work",
          isDefault: true,
          authRef: "github.work.token",
          accountLogin: "octocat-work",
          installationId: "456",
        },
      ],
    });
  });

  test("buildGitHubStatusPayload keeps app profiles unhealthy until installation context is configured", () => {
    const payload = __testOnly.buildGitHubStatusPayload({
      settings: {
        profileId: "work",
        profileSource: "project_routing",
        tokenEnv: "GH_TOKEN",
        authRef: "github.app.work",
        service: "hack-github-work",
        appId: "12345",
        privateKeyEnv: "GH_APP_PRIVATE_KEY",
        apiBaseUrl: "https://api.github.com",
        mode: "app",
      },
      settingsResult: {
        ok: true,
        settings: {
          profileId: "work",
          profileSource: "project_routing",
          tokenEnv: "GH_TOKEN",
          authRef: "github.app.work",
          service: "hack-github-work",
          appId: "12345",
          privateKeyEnv: "GH_APP_PRIVATE_KEY",
          apiBaseUrl: "https://api.github.com",
          mode: "app",
        },
        availableProfileIds: ["work"],
      },
      token: {
        ok: true,
        token: "env-token",
        source: "env",
        tokenEnv: "GH_TOKEN",
        authRef: "github.app.work",
        service: "hack-github-work",
        profileId: "work",
        profileSource: "project_routing",
      },
      defaultProfileId: "work",
      accountSnapshot: {
        accountLogin: "octocat-work",
      },
      controlPlaneConfig: {
        extensions: {
          "dance.hack.github": {
            enabled: true,
            config: {},
          },
        },
      },
    });

    expect(payload).toMatchObject({
      selectedProfile: "work",
      ready: false,
      readiness: "needs_attention",
      installationState: "missing",
    });
    expect(payload.repairIssues).toContain("missing_installation");
  });

  test("buildGitHubStatusPayload surfaces shared scope denial for the active project", () => {
    const payload = __testOnly.buildGitHubStatusPayload({
      settings: {
        profileId: "work",
        profileSource: "project_routing",
        tokenEnv: "GH_TOKEN",
        authRef: "github.app.work",
        service: "hack-github-work",
        apiBaseUrl: "https://api.github.com",
        mode: "token",
      },
      settingsResult: {
        ok: true,
        settings: {
          profileId: "work",
          profileSource: "project_routing",
          tokenEnv: "GH_TOKEN",
          authRef: "github.app.work",
          service: "hack-github-work",
          apiBaseUrl: "https://api.github.com",
          mode: "token",
        },
        availableProfileIds: ["work"],
      },
      token: {
        ok: true,
        token: "env-token",
        source: "env",
        tokenEnv: "GH_TOKEN",
        authRef: "github.app.work",
        service: "hack-github-work",
        profileId: "work",
        profileSource: "project_routing",
      },
      defaultProfileId: "work",
      accountSnapshot: {
        accountLogin: "octocat-work",
      },
      sharedProjectScope: {
        state: "shared_hidden",
        mutable: false,
        summary: "Shared project scope denied for hack-cli.",
        detail:
          "The current org/team context does not expose the shared project registration for this repo.",
        projectSlug: "hack-cli",
        currentAccessRole: null,
        ownerType: "team",
        ownerId: "team_123",
        ownerSlug: "infra",
        ownerName: "Infra",
      },
      controlPlaneConfig: {
        extensions: {
          "dance.hack.github": {
            enabled: true,
            config: {},
          },
        },
      },
    });

    expect(payload.ready).toBe(false);
    expect(payload.readiness).toBe("needs_attention");
    expect(payload.repairIssues).toContain("shared_scope_hidden");
    expect(payload.sharedProjectScope).toEqual({
      state: "shared_hidden",
      mutable: false,
      summary: "Shared project scope denied for hack-cli.",
      detail:
        "The current org/team context does not expose the shared project registration for this repo.",
      projectSlug: "hack-cli",
      currentAccessRole: null,
      ownerType: "team",
      ownerId: "team_123",
      ownerSlug: "infra",
      ownerName: "Infra",
    });
  });
});
