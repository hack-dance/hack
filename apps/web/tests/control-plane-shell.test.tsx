import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import ControlPlaneShell from "../src/components/control-plane-shell";
import {
  appMetadata,
  shellNavigationItems,
  shellPrinciples,
} from "../src/lib/control-plane-shell";

const githubManagement = {
  extensionEnabled: true,
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
    detail: "Missing GitHub token for the selected profile.",
    issues: ["missing_token"],
    installation: {
      required: false,
      state: "not_required",
    },
    repairGuidance: [
      {
        issue: "missing_token",
        title: "Restore usable GitHub auth",
        action: "Run hack x github connect --profile default.",
      },
    ],
  },
  statusCommand: "./dist/hack x github status --json",
} as const;

const linearManagement = {
  extensionEnabled: true,
  selectedProfile: "work",
  selectedSource: "project_routing",
  defaultProfile: "work",
  projectOverride: "work",
  selectedMissing: false,
  authRef: "linear.api.work",
  service: "hack-linear-work",
  tokenEnvFallback: "HACK_LINEAR_API_TOKEN",
  apiUrl: "https://api.linear.app/graphql",
  accountName: "Hack User",
  accountEmail: "hack@example.com",
  tokenResolved: false,
  profiles: [
    {
      id: "work",
      isDefault: true,
      authRef: "linear.api.work",
      service: "hack-linear-work",
      tokenEnv: "HACK_LINEAR_API_TOKEN",
      apiUrl: "https://api.linear.app/graphql",
      accountName: "Hack User",
    },
  ],
  projectBinding: {
    profileId: "work",
    defaultProject: {
      projectId: "proj_default",
      projectName: "Default",
      teamId: "team_default",
      label: "Default (proj_default) in team team_default",
    },
    additionalProjects: [],
  },
  summary: {
    activeProfile: "work",
    connected: false,
    connectionLabel: "Not connected",
    routingSummary:
      "This repo routes Linear sync to Default (proj_default) in team team_default.",
    linkedProjectsLabel: null,
    capabilities: ["Repair local Linear access for the active profile"],
    repair: {
      reason: "Local Linear access is missing for the active profile.",
      command: "hack linear connect --profile work",
    },
    nextSteps: ["Run `hack linear connect --profile work`."],
  },
  hackConnection: {
    inspectable: true,
    loaded: true,
    connected: true,
    localAccessAvailable: true,
    accessibleConnectionCount: 1,
    ownerLabel: "team:team_123",
    accountLabel: "Hack User",
    summary: 'Hack has a broker-owned Linear connection for profile "work".',
    detail:
      "Protected local access is stored on Hack and can be reseeded onto this machine if needed.",
  },
  localAccess: {
    ready: false,
    summary: "Local Linear access needs repair on this machine.",
    detail: "Local Linear access is missing for the active profile.",
  },
  repair: {
    title: "Seed local access from Hack",
    reason:
      "Hack already has protected local access for this profile; reseed it on this machine instead of reconnecting.",
    command: "hack linear seed-local-access --profile work",
  },
  accessControlMode: "better_auth_team_owned",
  audit: null,
  statusCommand: "./dist/hack linear status --json",
  profilesCommand: "./dist/hack linear profiles --json",
  connectionsCommand: "./dist/hack linear connections --json",
} as const;

const envManagement = {
  ready: false,
  envSelectionLabel: "base (.hack/.env only)",
  missingRequired: ["DATABASE_URL"],
  status: {
    trustModel: "local_only",
    custody: "machine_local",
    portability: "local_only",
    sharedState: "plaintext_compatible",
    summary: "Local-only env with plaintext compatibility",
    detail:
      "Hack still materializes plain env values to .hack/.env for compatibility, and this repo is not using broker-managed shared env custody.",
  },
  backend: {
    name: "encrypted_file",
    classification: {
      trustModel: "local_secret_backend",
      custody: "local_secret_backend",
      portability: "local_only",
      sharedState: "plaintext_compatible",
    },
    status: {
      storageMode: "Encrypted local file storage",
      trustModel: "Machine-local secret custody",
      portability:
        "Not portable by default; copy and key-sharing are explicit user actions",
      plaintextCompatibility:
        "Secret keys use this backend, while non-secret .env-compatible values still live in .hack/.env.",
    },
  },
  localPlaintext: {
    path: "/repo/.hack/.env",
    exists: true,
    classification: {
      trustModel: "unenforced_plaintext_file",
      custody: "local_plaintext_file",
      portability: "local_only",
      sharedState: "plaintext_compatible",
    },
  },
  localSecrets: {
    backend: "encrypted_file",
    location: "~/.hack/secrets.enc.json",
    mode: "native",
    provider: null,
    classification: {
      trustModel: "local_secret_backend",
      custody: "local_secret_backend",
      portability: "local_only",
      sharedState: "local_only",
    },
  },
  portableState: {
    status: "not_configured",
    message: "Portable encrypted bundles are not configured yet.",
    classification: {
      trustModel: "local_only",
      custody: "machine_local",
      portability: "local_only",
      sharedState: "plaintext_compatible",
    },
  },
  compatibilityMode: {
    plaintextTarget: "/repo/.hack/.env",
    secretBackend: "encrypted_file",
    plaintextMirroredToBackend: false,
    summary:
      "Plaintext values materialize to .hack/.env and secret values materialize to the configured secret backend.",
  },
  variables: [
    {
      key: "PUBLIC_URL",
      required: true,
      source: "plain_env",
      resolvedSource: "dotenv",
      services: ["web"],
      storage: {
        kind: "plaintext",
        backend: "dotenv",
        location: "/repo/.hack/.env",
        mode: "file",
        trustModel: "unenforced_plaintext_file",
        classification: {
          trustModel: "unenforced_plaintext_file",
          custody: "local_plaintext_file",
          portability: "local_only",
          sharedState: "plaintext_compatible",
        },
      },
    },
    {
      key: "API_KEY",
      required: false,
      source: "keychain",
      resolvedSource: "keychain",
      services: ["auth"],
      storage: {
        kind: "secret",
        backend: "encrypted_file",
        location: "~/.hack/secrets.enc.json",
        mode: "native",
        trustModel: "local_secret_backend",
        classification: {
          trustModel: "local_secret_backend",
          custody: "local_secret_backend",
          portability: "local_only",
          sharedState: "local_only",
        },
      },
    },
  ],
  statusCommand: "./dist/hack env list --json",
  backendCommand: "./dist/hack env backend status --json",
} as const;

test("control plane shell metadata describes the accessible foundation", () => {
  expect(appMetadata.title).toBe("Hack control plane");
  expect(appMetadata.description).toContain("signed-in browser shell");
  expect(shellNavigationItems.map(({ href }) => href)).toEqual([
    "#account-context",
    "#organizations",
    "#teams",
    "#projects",
    "#env",
    "#github",
    "#linear",
    "#invitations",
    "#foundations",
    "#guardrails",
  ]);
  expect(shellPrinciples.map(({ title }) => title)).toEqual([
    "Keyboard ready",
    "Reduced motion safe",
    "CLI first",
  ]);
});

test("control plane shell renders landmarks and keyboard navigation affordances", () => {
  const markup = renderToStaticMarkup(
    <ControlPlaneShell
      envManagement={envManagement}
      githubManagement={githubManagement}
      linearManagement={linearManagement}
      returnToPath="/"
    />
  );

  expect(markup).toContain("Skip to main content");
  expect(markup).toContain('href="#main-content"');
  expect(markup).toContain('aria-label="Control plane sections"');
  expect(markup).toContain('id="main-content"');
  expect(markup).toContain("<aside");
  expect(markup).toContain("Keyboard ready");
  expect(markup).toContain("Sign in to load your Hack account context");
  expect(markup).toContain("Organizations");
  expect(markup).toContain("Teams");
  expect(markup).toContain("Projects");
  expect(markup).toContain("Env");
  expect(markup).toContain("Key-level status");
  expect(markup).toContain("PUBLIC_URL");
  expect(markup).toContain("API_KEY");
  expect(markup).toContain("GitHub");
  expect(markup).toContain("Linear");
  expect(markup).toContain("Invitations");
});

test("control plane shell keeps visible focus and reduced-motion contracts explicit", async () => {
  const markup = renderToStaticMarkup(
    <ControlPlaneShell
      envManagement={envManagement}
      githubManagement={githubManagement}
      linearManagement={linearManagement}
      returnToPath="/"
    />
  );
  const globalCss = await Bun.file(
    new URL("../src/styles/globals.css", import.meta.url)
  ).text();

  expect(markup).toContain("focus-visible:outline");
  expect(markup).toContain("motion-reduce:transition-none");
  expect(globalCss).toContain("prefers-reduced-motion: reduce");
  expect(globalCss).toContain("scroll-behavior: auto");
});

test("root route keeps the marketing home page separate from the account shell", async () => {
  const pageSource = await Bun.file(
    new URL("../src/app/page.tsx", import.meta.url)
  ).text();

  expect(pageSource).toContain("MarketingChrome");
  expect(pageSource).toContain("Logo");
  expect(pageSource).not.toContain("AccountShellPage");
});
