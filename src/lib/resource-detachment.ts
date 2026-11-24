import { lstat, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  checkoutContext,
  listRegistrationCheckouts,
} from "./branch-instance-identity.ts";
import { resolveDesktopComposeProjectName } from "./compose-project-name.ts";
import { isRecord } from "./guards.ts";
import { readLifecycleState } from "./lifecycle-runtime.ts";
import { readReplaceablePrivateFile } from "./private-file.ts";
import { readProjectConfigFiles } from "./project.ts";
import { resolveProjectRuntimeStatePath } from "./project-runtime-state.ts";
import {
  readProjectsRegistryStrict,
  resolveProjectsRegistryPath,
} from "./projects-registry.ts";
import {
  type CheckoutWitness,
  type ResourceReceipt,
  readResourceCheckoutHistory,
} from "./resource-receipts.ts";

export type Detachment = {
  readonly detached: boolean;
  readonly code:
    | "checkout_present"
    | "checkout_unknown"
    | "registry_reference"
    | "registry_unknown"
    | "run_reference"
    | "state_unknown"
    | "history_unknown"
    | "detached";
  readonly reason: string;
  readonly paths: readonly string[];
};

function missing(error: unknown) {
  return isRecord(error) && error.code === "ENOENT";
}

async function exists(path: string) {
  return await lstat(path).then(
    () => true,
    (error: unknown) => {
      if (missing(error)) {
        return false;
      }
      throw error;
    }
  );
}

export async function witnessedCheckoutStatus(witness: CheckoutWitness) {
  try {
    if (await exists(witness.path)) {
      return "checkout_present";
    }
    const parent = await lstat(dirname(witness.path));
    return parent.isDirectory() &&
      parent.dev === witness.parentDevice &&
      parent.ino === witness.parentInode &&
      !(await exists(witness.path))
      ? "detached"
      : "checkout_unknown";
  } catch {
    return "checkout_unknown";
  }
}

async function runtimeNames(projectDir: string) {
  const path = resolveProjectRuntimeStatePath({ projectDir });
  const file = (await exists(path))
    ? await readReplaceablePrivateFile({
        path,
        directories: [dirname(path)],
        maxBytes: 1024 * 1024,
        refusal: () => new Error("Runtime state is unsafe."),
      })
    : null;
  const names: string[] = [];
  const text = file?.text ?? null;
  if (text !== null) {
    const parsed: unknown = JSON.parse(text);
    if (
      !(
        isRecord(parsed) &&
        Array.isArray(parsed.entries) &&
        parsed.entries.every(
          (row: unknown) =>
            isRecord(row) && typeof row.composeProject === "string"
        )
      )
    ) {
      throw new Error("Runtime state is invalid.");
    }
    names.push(...parsed.entries.map((row) => row.composeProject));
  }
  const lifecycle = await readLifecycleState({ projectDir, readOnly: true });
  return [...names, ...lifecycle.map((row) => row.composeProject)];
}

type Reference = { code: Detachment["code"]; reason?: string };
const pruneHelp =
  "Run hack projects prune for a deleted checkout, or remount its drive.";

async function checkoutReferences(
  ctx: ReturnType<typeof checkoutContext>,
  bases: Set<string>,
  runs: Set<string>
): Promise<Reference | null> {
  const path = JSON.stringify(ctx.projectRoot);
  try {
    const checkout = await stat(ctx.projectRoot).catch((error: unknown) => {
      if (missing(error)) {
        return null;
      }
      throw error;
    });
    if (!checkout?.isDirectory()) {
      return {
        code: "registry_unknown",
        reason: `The registered checkout ${path} is unavailable. ${pruneHelp}`,
      };
    }
    if (!(await stat(ctx.projectDir)).isDirectory()) {
      throw new Error("Project directory is unavailable.");
    }
    for (const name of await runtimeNames(ctx.projectDir)) {
      runs.add(name);
    }
    if (!(await exists(ctx.composeFile))) {
      return null;
    }
    const cfg = await readProjectConfigFiles(ctx.projectDir);
    const names = await Promise.all(
      [false, true].map((forBranch) =>
        resolveDesktopComposeProjectName({ project: ctx, cfg, forBranch })
      )
    );
    for (const name of names) {
      if (!name) {
        throw new Error("Compose project name is unavailable.");
      }
      bases.add(name);
    }
    return null;
  } catch {
    return {
      code: "state_unknown",
      reason: `Could not verify configuration or run state at ${path}. ${pruneHelp}`,
    };
  }
}

export async function readResourceReferences() {
  const bases = new Set<string>();
  const runs = new Set<string>();
  const read = await readProjectsRegistryStrict({
    requireAutostartTrust: true,
  }).catch(() => null);
  let unknown: Reference | null = null;
  if (read?.kind !== "valid" || read.rejected > 0) {
    unknown = {
      code: "registry_unknown",
      reason: `The projects registry at ${JSON.stringify(resolveProjectsRegistryPath())} could not be verified. ${pruneHelp}`,
    };
  } else {
    for (const registration of read.registry.projects) {
      bases.add(registration.name);
      for (const checkout of listRegistrationCheckouts(registration)) {
        const ctx = checkoutContext({ registration, checkout });
        unknown = await checkoutReferences(ctx, bases, runs);
        if (unknown) {
          break;
        }
      }
      if (unknown) {
        break;
      }
    }
  }
  return {
    registry: read?.kind === "valid" ? read.registry : null,
    lookup(name: string): Reference | null {
      if (unknown) {
        return unknown;
      }
      if (runs.has(name)) {
        return { code: "run_reference" };
      }
      return registeredInstance(bases, name)
        ? { code: "registry_reference" }
        : null;
    },
  };
}

function registeredInstance(bases: ReadonlySet<string>, name: string) {
  if (bases.has(name)) {
    return true;
  }
  for (let at = name.indexOf("--"); at >= 0; at = name.indexOf("--", at + 1)) {
    if (bases.has(name.slice(0, at))) {
      return true;
    }
  }
  return false;
}

const reasons: Record<Detachment["code"], string> = {
  checkout_present: "A launching checkout still exists.",
  checkout_unknown:
    "A launching checkout's parent is missing or changed; its absence cannot be verified.",
  registry_reference:
    "A registered checkout or worktree still maps to this Compose project.",
  registry_unknown:
    "The project registry or a registered checkout could not be verified.",
  run_reference:
    "A runtime or lifecycle record still references this Compose project.",
  state_unknown:
    "A registered checkout's configuration or run state could not be verified.",
  history_unknown:
    "The Compose project's launch history could not be verified.",
  detached:
    "No registered checkout, runtime or lifecycle mapping refers to this Compose project, and each launching checkout is verified missing.",
};

export async function verifyResourceDetachment(
  receipt: ResourceReceipt,
  references?: Awaited<ReturnType<typeof readResourceReferences>>
): Promise<Detachment> {
  const history = await readResourceCheckoutHistory(receipt.composeProject);
  const paths = [
    ...new Set(
      [...receipt.checkouts, ...(history ?? [])].map((row) => row.path)
    ),
  ];
  const result = (
    code: Detachment["code"],
    reason = reasons[code]
  ): Detachment => ({
    code,
    detached: code === "detached",
    reason,
    paths,
  });
  if (
    !(
      history &&
      receipt.checkouts.every((row) =>
        history.some((entry) => entry.path === row.path)
      )
    )
  ) {
    return result("history_unknown");
  }
  const registry = (references ?? (await readResourceReferences())).lookup(
    receipt.composeProject
  );
  if (registry) {
    return result(registry.code, registry.reason);
  }
  for (const witness of history) {
    const status = await witnessedCheckoutStatus(witness);
    if (status !== "detached") {
      return result(status);
    }
  }
  return result("detached");
}
