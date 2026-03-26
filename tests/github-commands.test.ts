import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { __testOnly } from "../src/control-plane/extensions/github/commands.ts";
import { createDefaultControlPlaneConfig } from "../src/control-plane/sdk/config.ts";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createGitHubRepoConfig(input: {
  readonly mode: "token" | "app";
  readonly installationId?: string;
}) {
  return {
    name: "github-status-fixture",
    controlPlane: {
      extensions: {
        "dance.hack.github": {
          enabled: true,
          config: {
            defaultProfile: "default",
            profiles: {
              default: {
                tokenEnv: "HACK_GITHUB_APP_TOKEN",
                authRef: "github.default",
                service: "hack-github",
                apiBaseUrl: "https://api.github.com",
                mode: input.mode,
                accountLogin: "octocat",
                ...(input.mode === "app" ? { appId: "12345" } : {}),
                ...(input.installationId
                  ? { installationId: input.installationId }
                  : {}),
              },
            },
          },
        },
      },
    },
  };
}

function createGitHubStatusControlPlaneConfig() {
  const defaults = createDefaultControlPlaneConfig();
  return {
    ...defaults,
    extensions: {
      ...defaults.extensions,
      "dance.hack.github": {
        enabled: true,
        config: {},
      },
    },
  };
}

function extractJsonPayload(stdout: string): string {
  const trimmed = stdout.trim();
  const objectStart = trimmed.indexOf("{");
  if (objectStart === -1) {
    throw new Error(`Expected JSON payload in stdout, got: ${stdout}`);
  }
  return trimmed.slice(objectStart);
}

async function runGitHubStatusCommand(input: {
  readonly repoConfig: ReturnType<typeof createGitHubRepoConfig>;
}) {
  const tempDir = await mkdtemp(join(tmpdir(), "hack-github-status-"));
  const repoRoot = join(tempDir, "repo");
  try {
    await writeJson(
      join(repoRoot, ".hack", "hack.config.json"),
      input.repoConfig
    );
    await writeFile(
      join(repoRoot, ".hack", "docker-compose.yml"),
      "services: {}\n"
    );
    await writeFile(join(repoRoot, ".hack", ".env"), "");
    const proc = Bun.spawn(
      [
        "bun",
        resolve(import.meta.dir, "../index.ts"),
        "x",
        "github",
        "status",
        "--json",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: "1",
          FORCE_COLOR: "0",
          HACK_GITHUB_APP_TOKEN: "env-github-smoke-token",
          HACK_GITHUB_PREFER_ENV_TOKEN_ONLY: "true",
          HACK_SETUP_SYNC_MODE: "off",
          HOME: tempDir,
          NO_COLOR: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return {
      exitCode,
      stderr,
      payload: JSON.parse(extractJsonPayload(stdout)) as {
        readonly ready: boolean;
        readonly installationState: "configured" | "missing" | "not_required";
        readonly repairIssues: readonly string[];
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

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
      controlPlaneConfig: createGitHubStatusControlPlaneConfig(),
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
        privateKeyEnv: "GH_APP_PRIVATE_KEY",
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
          privateKeyEnv: "GH_APP_PRIVATE_KEY",
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
      controlPlaneConfig: createGitHubStatusControlPlaneConfig(),
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

describe("github status exit semantics", () => {
  test("repo-bound github status exits non-zero when the readiness payload is unhealthy", async () => {
    const result = await runGitHubStatusCommand({
      repoConfig: createGitHubRepoConfig({
        mode: "app",
      }),
    });

    expect(result.payload.ready).toBe(false);
    expect(result.payload.installationState).toBe("missing");
    expect(result.payload.repairIssues).toContain("missing_installation");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("Missing GitHub token");
  });

  test("repo-bound github status exits zero when the readiness payload is ready", async () => {
    const result = await runGitHubStatusCommand({
      repoConfig: createGitHubRepoConfig({
        mode: "app",
        installationId: "98765",
      }),
    });

    expect(result.payload.ready).toBe(true);
    expect(result.payload.installationState).toBe("configured");
    expect(result.exitCode).toBe(0);
  });
});
