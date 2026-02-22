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
});
