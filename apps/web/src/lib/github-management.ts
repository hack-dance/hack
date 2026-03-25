import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { BrowserSharedProjectScopeSummary } from "./browser-shared-project-scope";

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
  | "missing_installation"
  | "shared_scope_hidden";

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
  readonly sharedProjectScope?: BrowserSharedProjectScopeSummary | null;
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
  readonly sharedProjectScope?: BrowserSharedProjectScopeSummary | null;
  readonly statusCommand: string;
};

export async function loadGitHubManagementState(input?: {
  readonly browserSharedProjectScope?: BrowserSharedProjectScopeSummary | null;
}): Promise<GitHubManagementState> {
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

  return buildGitHubManagementState({
    status: statusResult.payload,
    profiles: profilesResult.payload,
    browserSharedProjectScope: input?.browserSharedProjectScope ?? null,
  });
}

export function buildGitHubManagementState(input: {
  readonly status: GitHubStatusCommandPayload;
  readonly profiles?: GitHubProfilesCommandPayload | null;
  readonly browserSharedProjectScope?: BrowserSharedProjectScopeSummary | null;
}): GitHubManagementState {
  const effectiveSharedProjectScope =
    input.browserSharedProjectScope ?? input.status.sharedProjectScope ?? null;
  const readinessState = buildGitHubReadinessState({
    status: input.status,
    sharedProjectScope: effectiveSharedProjectScope,
  });

  return {
    extensionEnabled: readinessState.extensionEnabled,
    selectedProfile: input.status.selectedProfile,
    selectedSource: input.status.selectedSource,
    defaultProfile: input.status.defaultProfile,
    ...(input.profiles?.projectOverride
      ? { projectOverride: input.profiles.projectOverride }
      : {}),
    selectedMissing: input.profiles?.selectedMissing ?? false,
    mode: input.status.mode,
    authRef: input.status.authRef,
    service: input.status.service,
    tokenEnvFallback: input.status.tokenEnvFallback,
    apiBaseUrl: input.status.apiBaseUrl,
    ...pickGitHubIdentityFields({ status: input.status }),
    ...pickGitHubTokenFields({ status: input.status }),
    ...pickGitHubErrorFields({ status: input.status }),
    profiles: input.profiles?.profiles ?? [],
    readiness: readinessState.readiness,
    ...(effectiveSharedProjectScope
      ? { sharedProjectScope: effectiveSharedProjectScope }
      : {}),
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

function resolveGitHubInstallationState(input: {
  readonly status: GitHubStatusCommandPayload;
}): GitHubReadinessSummary["installation"]["state"] {
  if (input.status.mode !== "app") {
    return "not_required";
  }
  return input.status.installationId ? "configured" : "missing";
}

function buildGitHubReadinessState(input: {
  readonly status: GitHubStatusCommandPayload;
  readonly sharedProjectScope: BrowserSharedProjectScopeSummary | null;
}): {
  readonly extensionEnabled: boolean;
  readonly readiness: GitHubReadinessSummary;
} {
  const providerIssues: GitHubRepairIssue[] = input.status.repairIssues.filter(
    (issue): issue is GitHubRepairIssue => {
      return issue !== "shared_scope_hidden";
    }
  );
  const providerGuidance: GitHubReadinessSummary["repairGuidance"] =
    input.status.repairGuidance.filter((guidance) => {
      return guidance.issue !== "shared_scope_hidden";
    });
  const installationState = resolveGitHubInstallationState({
    status: input.status,
  });
  const sharedScopeHidden = input.sharedProjectScope?.state === "shared_hidden";
  const issues: GitHubRepairIssue[] = sharedScopeHidden
    ? [...providerIssues, "shared_scope_hidden"]
    : [...providerIssues];
  const ready = issues.length === 0;
  const repairGuidance: GitHubReadinessSummary["repairGuidance"] =
    sharedScopeHidden
      ? [...providerGuidance, createSharedScopeRepairGuidance()]
      : providerGuidance;
  let detail = describePrimaryGitHubIssue({
    issue: issues[0] ?? "missing_token",
    status: input.status,
  });
  let summary = "GitHub needs repair before this repo can rely on it.";

  if (sharedScopeHidden && input.sharedProjectScope) {
    summary = input.sharedProjectScope.summary;
    detail = input.sharedProjectScope.detail;
  } else if (ready) {
    summary = "Ready for project GitHub workflows.";
    detail = describeReadyGitHubDetail({
      status: input.status,
    });
  }

  return {
    extensionEnabled: !providerIssues.includes("extension_disabled"),
    readiness: {
      ready,
      state: ready ? "ready" : "needs_attention",
      summary,
      detail,
      issues,
      installation: {
        required: installationState !== "not_required",
        state: installationState,
        ...(input.status.installationId
          ? { selectedInstallationId: input.status.installationId }
          : {}),
      },
      repairGuidance,
    },
  };
}

function pickGitHubIdentityFields(input: {
  readonly status: GitHubStatusCommandPayload;
}): Pick<
  GitHubManagementState,
  "accountId" | "accountLogin" | "accountName" | "installationId"
> {
  return {
    ...(input.status.accountLogin
      ? { accountLogin: input.status.accountLogin }
      : {}),
    ...(input.status.accountName
      ? { accountName: input.status.accountName }
      : {}),
    ...(input.status.accountId ? { accountId: input.status.accountId } : {}),
    ...(input.status.installationId
      ? { installationId: input.status.installationId }
      : {}),
  };
}

function pickGitHubTokenFields(input: {
  readonly status: GitHubStatusCommandPayload;
}): Pick<
  GitHubManagementState,
  "tokenExpiresAt" | "tokenResolved" | "tokenSource"
> {
  return {
    tokenResolved: input.status.tokenResolved,
    ...(input.status.tokenSource
      ? { tokenSource: input.status.tokenSource }
      : {}),
    ...(input.status.tokenExpiresAt
      ? { tokenExpiresAt: input.status.tokenExpiresAt }
      : {}),
  };
}

function pickGitHubErrorFields(input: {
  readonly status: GitHubStatusCommandPayload;
}): Pick<GitHubManagementState, "error" | "profileError"> {
  return {
    ...(input.status.profileError
      ? { profileError: input.status.profileError }
      : {}),
    ...(input.status.error ? { error: input.status.error } : {}),
  };
}

function describeReadyGitHubDetail(input: {
  readonly status: GitHubStatusCommandPayload;
}): string {
  if (input.status.mode === "app") {
    return `Project routing resolves the "${input.status.selectedProfile}" profile with a usable token and installation ${input.status.installationId ?? "<installation-id>"}.`;
  }
  return `Project routing resolves the "${input.status.selectedProfile}" profile with usable token access.`;
}

function describePrimaryGitHubIssue(input: {
  readonly issue: GitHubRepairIssue;
  readonly status: GitHubStatusCommandPayload;
}): string {
  if (input.issue === "extension_disabled") {
    return "The repo has not enabled the GitHub extension yet, so project-bound status cannot rely on the real GitHub auth path.";
  }
  if (input.issue === "missing_profile") {
    return (
      input.status.profileError ??
      `The selected GitHub profile "${input.status.selectedProfile}" is unavailable.`
    );
  }
  if (input.issue === "missing_installation") {
    return `The "${input.status.selectedProfile}" profile is in app mode, but no installation is configured for the current project routing context.`;
  }
  if (input.issue === "shared_scope_hidden") {
    return (
      input.status.sharedProjectScope?.detail ??
      "The current org/team context does not expose the shared project registration for this repo."
    );
  }
  return (
    input.status.error ??
    `The "${input.status.selectedProfile}" profile does not currently resolve usable GitHub access.`
  );
}

function createSharedScopeRepairGuidance(): GitHubReadinessSummary["repairGuidance"][number] {
  return {
    issue: "shared_scope_hidden",
    title: "Refresh the shared project scope",
    action:
      "Switch back to a visible shared org/team context, then run `hack auth login` so repo-bound GitHub status can confirm the active shared project scope.",
  };
}
