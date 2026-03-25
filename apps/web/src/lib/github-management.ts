import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const REPO_ROOT = resolve(process.cwd(), "../..");
const STATUS_COMMAND = "./dist/hack x github status --json";
const RUNTIME_STATUS_ARGS = [
  "index.ts",
  "x",
  "github",
  "status",
  "--json",
] as const;
const RUNTIME_PROFILES_ARGS = [
  "index.ts",
  "x",
  "github",
  "profiles",
  "--json",
] as const;
const execFileAsync = promisify(execFile);

type GitHubRepairIssue =
  | "extension_disabled"
  | "missing_profile"
  | "missing_token"
  | "missing_installation";

type GitHubReadinessSummary = {
  readonly ready: boolean;
  readonly state: "ready" | "needs_attention";
  readonly summary: string;
  readonly detail: string;
  readonly issues: readonly GitHubRepairIssue[];
  readonly installation: {
    readonly required: boolean;
    readonly state: "configured" | "missing" | "not_required";
    readonly selectedInstallationId?: string;
  };
  readonly repairGuidance: readonly {
    readonly issue: GitHubRepairIssue;
    readonly title: string;
    readonly action: string;
  }[];
};

type GitHubStatusCommandPayload = {
  readonly extensionId: string;
  readonly selectedProfile: string;
  readonly selectedSource: string;
  readonly defaultProfile: string;
  readonly authRef: string;
  readonly service: string;
  readonly tokenEnvFallback: string;
  readonly mode: string;
  readonly apiBaseUrl: string;
  readonly accountLogin?: string;
  readonly accountName?: string;
  readonly accountId?: string;
  readonly installationId?: string;
  readonly tokenResolved: boolean;
  readonly tokenSource?: string;
  readonly tokenExpiresAt?: string;
  readonly ready: boolean;
  readonly readiness: "ready" | "needs_attention";
  readonly readinessSummary: string;
  readonly readinessDetail: string;
  readonly repairIssues: readonly GitHubRepairIssue[];
  readonly installationState: "configured" | "missing" | "not_required";
  readonly repairGuidance: readonly {
    readonly issue: GitHubRepairIssue;
    readonly title: string;
    readonly action: string;
  }[];
  readonly profileError?: string;
  readonly error?: string;
};

type GitHubProfilesCommandPayload = {
  readonly projectOverride?: string;
  readonly selectedMissing: boolean;
  readonly profiles: readonly {
    readonly id: string;
    readonly isDefault: boolean;
    readonly mode: string;
    readonly authRef: string;
    readonly service: string;
    readonly appId?: string;
    readonly installationId?: string;
    readonly accountLogin?: string;
    readonly accountName?: string;
    readonly accountId?: string;
  }[];
};

export type GitHubManagementState = {
  readonly extensionEnabled: boolean;
  readonly selectedProfile: string;
  readonly selectedSource: string;
  readonly defaultProfile: string;
  readonly projectOverride?: string;
  readonly selectedMissing: boolean;
  readonly mode: string;
  readonly authRef: string;
  readonly service: string;
  readonly tokenEnvFallback: string;
  readonly apiBaseUrl: string;
  readonly accountLogin?: string;
  readonly accountName?: string;
  readonly accountId?: string;
  readonly installationId?: string;
  readonly tokenResolved: boolean;
  readonly tokenSource?: string;
  readonly tokenExpiresAt?: string;
  readonly profileError?: string;
  readonly error?: string;
  readonly profiles: readonly {
    readonly id: string;
    readonly isDefault: boolean;
    readonly mode: string;
    readonly authRef: string;
    readonly service: string;
    readonly appId?: string;
    readonly installationId?: string;
    readonly accountLogin?: string;
    readonly accountName?: string;
    readonly accountId?: string;
  }[];
  readonly readiness: GitHubReadinessSummary;
  readonly statusCommand: string;
};

export async function loadGitHubManagementState(): Promise<GitHubManagementState> {
  const [statusResult, profilesResult] = await Promise.all([
    runGitHubJsonCommand<GitHubStatusCommandPayload>({
      args: RUNTIME_STATUS_ARGS,
    }),
    runGitHubJsonCommand<GitHubProfilesCommandPayload>({
      args: RUNTIME_PROFILES_ARGS,
    }),
  ]);

  if (!statusResult.payload) {
    return createFallbackGitHubManagementState({
      output: statusResult.output,
    });
  }

  return {
    extensionEnabled: statusResult.payload.extensionId === "dance.hack.github",
    selectedProfile: statusResult.payload.selectedProfile,
    selectedSource: statusResult.payload.selectedSource,
    defaultProfile: statusResult.payload.defaultProfile,
    ...(profilesResult.payload?.projectOverride
      ? { projectOverride: profilesResult.payload.projectOverride }
      : {}),
    selectedMissing: profilesResult.payload?.selectedMissing ?? false,
    mode: statusResult.payload.mode,
    authRef: statusResult.payload.authRef,
    service: statusResult.payload.service,
    tokenEnvFallback: statusResult.payload.tokenEnvFallback,
    apiBaseUrl: statusResult.payload.apiBaseUrl,
    ...(statusResult.payload.accountLogin
      ? { accountLogin: statusResult.payload.accountLogin }
      : {}),
    ...(statusResult.payload.accountName
      ? { accountName: statusResult.payload.accountName }
      : {}),
    ...(statusResult.payload.accountId
      ? { accountId: statusResult.payload.accountId }
      : {}),
    ...(statusResult.payload.installationId
      ? { installationId: statusResult.payload.installationId }
      : {}),
    tokenResolved: statusResult.payload.tokenResolved,
    ...(statusResult.payload.tokenSource
      ? { tokenSource: statusResult.payload.tokenSource }
      : {}),
    ...(statusResult.payload.tokenExpiresAt
      ? { tokenExpiresAt: statusResult.payload.tokenExpiresAt }
      : {}),
    ...(statusResult.payload.profileError
      ? { profileError: statusResult.payload.profileError }
      : {}),
    ...(statusResult.payload.error
      ? { error: statusResult.payload.error }
      : {}),
    profiles: profilesResult.payload?.profiles ?? [],
    readiness: {
      ready: statusResult.payload.ready,
      state: statusResult.payload.readiness,
      summary: statusResult.payload.readinessSummary,
      detail: statusResult.payload.readinessDetail,
      issues: statusResult.payload.repairIssues,
      installation: {
        required: statusResult.payload.installationState !== "not_required",
        state: statusResult.payload.installationState,
        ...(statusResult.payload.installationId
          ? { selectedInstallationId: statusResult.payload.installationId }
          : {}),
      },
      repairGuidance: statusResult.payload.repairGuidance,
    },
    statusCommand: STATUS_COMMAND,
  };
}

async function runGitHubJsonCommand<TPayload>(input: {
  readonly args: readonly string[];
}): Promise<{
  readonly payload: TPayload | null;
  readonly output: string;
}> {
  try {
    const result = await execFileAsync("bun", input.args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HACK_GITHUB_PREFER_ENV_TOKEN_ONLY:
          process.env.HACK_GITHUB_PREFER_ENV_TOKEN_ONLY ?? "true",
      },
    });
    const output = result.stdout.trim();
    return {
      payload: parseJsonPayload<TPayload>({ output }),
      output,
    };
  } catch (error) {
    return {
      payload: parseJsonPayload<TPayload>({
        output: readCommandOutput({ error }),
      }),
      output: readCommandOutput({ error }),
    };
  }
}

function parseJsonPayload<TPayload>(input: {
  readonly output: string;
}): TPayload | null {
  const output = input.output.trim();
  if (!output.startsWith("{")) {
    return null;
  }

  try {
    return JSON.parse(output) as TPayload;
  } catch {
    return null;
  }
}

function readCommandOutput(input: { readonly error: unknown }): string {
  if (
    input.error &&
    typeof input.error === "object" &&
    "stdout" in input.error &&
    typeof input.error.stdout === "string"
  ) {
    return input.error.stdout.trim();
  }
  if (input.error instanceof Error) {
    return input.error.message;
  }
  return "";
}

function createFallbackGitHubManagementState(input: {
  readonly output: string;
}): GitHubManagementState {
  return {
    extensionEnabled: false,
    selectedProfile: "default",
    selectedSource: "implicit_default",
    defaultProfile: "default",
    selectedMissing: false,
    mode: "token",
    authRef: "github.app.default",
    service: "hack-github-auth",
    tokenEnvFallback: "HACK_GITHUB_APP_TOKEN",
    apiBaseUrl: "https://api.github.com",
    tokenResolved: false,
    profiles: [],
    readiness: {
      ready: false,
      state: "needs_attention",
      summary: "GitHub needs repair before this repo can rely on it.",
      detail:
        input.output ||
        'Set `controlPlane.extensions["dance.hack.github"].enabled` to `true` in `.hack/hack.config.json` so repo-bound GitHub status can load.',
      issues: ["extension_disabled"],
      installation: {
        required: false,
        state: "not_required",
      },
      repairGuidance: [
        {
          issue: "extension_disabled",
          title: "Enable the project GitHub extension",
          action:
            'Set `controlPlane.extensions["dance.hack.github"].enabled` to `true` in `.hack/hack.config.json`, rebuild `./dist/hack`, and reload this page.',
        },
      ],
    },
    error: input.output || "GitHub status command did not return JSON.",
    statusCommand: STATUS_COMMAND,
  };
}
