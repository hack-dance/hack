import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { type ReactElement, type ReactNode, Suspense } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

import * as accountPageModule from "../src/app/account/page";
import AccountShellLoading from "../src/components/account-shell-loading";
import ControlPlaneShell from "../src/components/control-plane-shell";
import type { AccountShellContext } from "../src/lib/account-shell";
import type { EnvManagementState } from "../src/lib/env-management";
import type { GitHubManagementState } from "../src/lib/github-management";
import {
  findDescriptionListViolations,
  routedAccountPopulatedLinearManagement,
} from "./linear-audit-fixtures";

type TimeoutHandle = ReturnType<typeof setTimeout>;

const authenticatedAccount = {
  authenticated: true,
  accessControlMode: "better_auth_team_owned",
  user: {
    id: "user_123",
    email: "hack@example.com",
    name: "Hack User",
  },
  activeOrganization: {
    id: "org_123",
    name: "Hack Org",
  },
  activeTeam: {
    id: "team_123",
    name: "Infra",
  },
  shellPath: "/auth",
  accountPath: "/auth/account",
  requestedOrganizationKey: "hack-org",
  selectedOrganizationVisible: true,
  requestedTeamKey: "infra",
  selectedTeamVisible: true,
  requestedProjectKey: "hack-cli",
  selectedProjectVisible: true,
  organizations: [],
  selectedOrganization: null,
  selectedOrganizationMemberships: [],
  teams: [],
  selectedTeam: null,
  selectedTeamMemberships: [],
  incomingInvitations: [],
  projects: [],
  selectedProject: null,
  selectedProjectAccess: [],
} as const satisfies AccountShellContext;

const envManagement = {
  ready: true,
  envSelectionLabel: "base (.hack/.env only)",
  missingRequired: [],
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
      portability: "Not portable by default",
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
    status: "backend_bundle",
    message:
      "Plaintext and secret env values are bundled in the encrypted backend.",
    classification: {
      trustModel: "encrypted_backend_bundle",
      custody: "portable_encrypted_bundle",
      portability: "portable_encrypted_bundle",
      sharedState: "portable_bundle",
    },
  },
  compatibilityMode: {
    plaintextTarget: "/repo/.hack/.env",
    secretBackend: "encrypted_file",
    plaintextMirroredToBackend: true,
    summary:
      "Plaintext values are bundled in the configured backend and materialize to .hack/.env for compatibility.",
  },
  variables: [],
  statusCommand: "./dist/hack env list --json",
  backendCommand: "./dist/hack env backend status --json",
} as const satisfies EnvManagementState;

const githubManagement = {
  extensionEnabled: true,
  selectedProfile: "work",
  selectedSource: "project_routing",
  defaultProfile: "work",
  projectOverride: "work",
  selectedMissing: false,
  mode: "app",
  authRef: "github.app.work",
  service: "hack-github-work",
  tokenEnvFallback: "HACK_GITHUB_APP_TOKEN",
  apiBaseUrl: "https://api.github.com",
  accountLogin: "hack-dance",
  accountName: "Hack Dance",
  tokenResolved: true,
  tokenSource: "keychain",
  installationId: "12345",
  profiles: [
    {
      id: "work",
      isDefault: true,
      mode: "app",
      authRef: "github.app.work",
      service: "hack-github-work",
      appId: "app_12345",
      installationId: "12345",
      accountLogin: "hack-dance",
      accountName: "Hack Dance",
    },
  ],
  readiness: {
    ready: true,
    state: "ready",
    summary: "Ready for project GitHub workflows.",
    detail:
      "Project routing resolves a usable profile, token, and installation context.",
    issues: [],
    installation: {
      required: true,
      state: "configured",
    },
    repairGuidance: [],
  },
  statusCommand: "./dist/hack x github status --json",
} as const satisfies GitHubManagementState;

test("account page forces a fresh server render for cold authenticated bootstraps", () => {
  expect(accountPageModule.dynamic).toBe("force-dynamic");
  expect(accountPageModule.fetchCache).toBe("force-no-store");
});

test("account page route keeps the page-level loading fallback around the async shell bootstrap", () => {
  const routeElement = accountPageModule.default({
    searchParams: new Promise<Record<string, string | string[] | undefined>>(
      (_resolve) => void _resolve
    ),
  }) as ReactElement<{ readonly fallback: ReactNode }>;
  const routeMarkup = renderToString(routeElement);

  expect(routeElement.type).toBe(Suspense);
  expect(renderToString(routeElement.props.fallback)).toContain(
    "Loading account context"
  );
  expect(routeMarkup).toContain("Loading account context");
  expect(routeMarkup).toContain('href="#main-content"');
  expect(routeMarkup).toContain('id="main-content"');
  expect(routeMarkup).not.toContain("Mission closeout audit");
});

test("account shell loading fallback keeps a focusable main region", () => {
  const markup = renderToString(<AccountShellLoading />);

  expect(markup).toContain('href="#main-content"');
  expect(markup).toContain('id="main-content"');
  expect(markup).toContain("Loading account context");
  expect(findDescriptionListViolations({ markup })).toEqual([]);
});

test("account shell cold authenticated markup hydrates without mismatches", async () => {
  const element = (
    <ControlPlaneShell
      account={authenticatedAccount}
      envManagement={envManagement}
      githubManagement={githubManagement}
      linearManagement={routedAccountPopulatedLinearManagement}
      returnToPath="/account"
      signInHref="/auth?redirect=%2Faccount"
    />
  );
  const serverMarkup = renderToString(element);
  const restoreDom = installDomGlobals();
  const consoleErrors: string[] = [];
  const originalConsoleError = console.error;

  try {
    const root = document.getElementById("root");
    if (!root) {
      throw new Error("Expected hydration root.");
    }

    root.innerHTML = serverMarkup;
    console.error = (...args: readonly unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };

    const hydratedRoot = hydrateRoot(root, element);
    await waitForHydration();
    hydratedRoot.unmount();
    await waitForHydration();
  } finally {
    console.error = originalConsoleError;
    restoreDom();
  }

  expect(findDescriptionListViolations({ markup: serverMarkup })).toEqual([]);
  expect(serverMarkup).toContain("Mission closeout audit");
  expect(serverMarkup).toContain("Latest delivery reconciliation");
  expect(serverMarkup).toContain("13/13");
  expect(consoleErrors).toEqual([]);
});

function installDomGlobals(): () => void {
  const { window } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  const previousValues = new Map<string, unknown>([
    ["window", Reflect.get(globalThis, "window")],
    ["document", Reflect.get(globalThis, "document")],
    ["navigator", Reflect.get(globalThis, "navigator")],
    ["HTMLElement", Reflect.get(globalThis, "HTMLElement")],
    ["SVGElement", Reflect.get(globalThis, "SVGElement")],
    ["Element", Reflect.get(globalThis, "Element")],
    ["Node", Reflect.get(globalThis, "Node")],
    ["Text", Reflect.get(globalThis, "Text")],
    ["Comment", Reflect.get(globalThis, "Comment")],
    ["MutationObserver", Reflect.get(globalThis, "MutationObserver")],
    ["requestAnimationFrame", Reflect.get(globalThis, "requestAnimationFrame")],
    ["cancelAnimationFrame", Reflect.get(globalThis, "cancelAnimationFrame")],
  ]);
  const requestAnimationFrame = (callback: (timestamp: number) => void) => {
    return setTimeout(() => callback(Date.now()), 0);
  };
  const cancelAnimationFrame = (handle: TimeoutHandle) => {
    clearTimeout(handle);
  };

  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", window.document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "SVGElement", window.SVGElement);
  Reflect.set(globalThis, "Element", window.Element);
  Reflect.set(globalThis, "Node", window.Node);
  Reflect.set(globalThis, "Text", window.Text);
  Reflect.set(globalThis, "Comment", window.Comment);
  Reflect.set(globalThis, "MutationObserver", window.MutationObserver);
  Reflect.set(globalThis, "requestAnimationFrame", requestAnimationFrame);
  Reflect.set(globalThis, "cancelAnimationFrame", cancelAnimationFrame);

  return () => {
    for (const [key, value] of previousValues.entries()) {
      if (value === undefined) {
        Reflect.deleteProperty(globalThis, key);
        continue;
      }
      Reflect.set(globalThis, key, value);
    }
  };
}

async function waitForHydration() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 50));
}
