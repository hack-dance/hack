import { lstat } from "node:fs/promises";
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
import { readProjectsRegistryStrict } from "./projects-registry.ts";
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

async function runtimeReferences(projectDir: string, name: string) {
  const path = resolveProjectRuntimeStatePath({ projectDir });
  const file = (await exists(path))
    ? await readReplaceablePrivateFile({
        path,
        directories: [dirname(path)],
        maxBytes: 1024 * 1024,
        refusal: () => new Error("Runtime state is unsafe."),
      })
    : null;
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
    if (parsed.entries.some((row) => row.composeProject === name)) {
      return true;
    }
  }
  return (await readLifecycleState({ projectDir, readOnly: true })).some(
    (row) => row.composeProject === name
  );
}

const sameInstance = (base: string, name: string) =>
  name === base || name.startsWith(`${base}--`);

async function registrationReference(
  name: string
): Promise<Detachment["code"] | null> {
  const read = await readProjectsRegistryStrict({
    requireAutostartTrust: true,
  }).catch(() => null);
  if (read?.kind !== "valid" || read.rejected > 0) {
    return "registry_unknown";
  }
  let registered = false;
  for (const project of read.registry.projects) {
    registered ||= sameInstance(project.name, name);
    for (const checkout of listRegistrationCheckouts(project)) {
      const ctx = checkoutContext({ registration: project, checkout });
      try {
        if (!(await exists(checkout.root))) {
          return "registry_unknown";
        }
        if (await runtimeReferences(ctx.projectDir, name)) {
          return "run_reference";
        }
        if (await exists(ctx.composeFile)) {
          const cfg = await readProjectConfigFiles(ctx.projectDir);
          const names = await Promise.all(
            [false, true].map((forBranch) =>
              resolveDesktopComposeProjectName({ project: ctx, cfg, forBranch })
            )
          );
          if (names.some((base) => base && sameInstance(base, name))) {
            registered = true;
          }
          if (names.some((base) => base === null)) {
            return "state_unknown";
          }
        }
      } catch {
        return "state_unknown";
      }
    }
  }
  return registered ? "registry_reference" : null;
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
  receipt: ResourceReceipt
): Promise<Detachment> {
  const history = await readResourceCheckoutHistory(receipt.composeProject);
  const paths = [
    ...new Set(
      [...receipt.checkouts, ...(history ?? [])].map((row) => row.path)
    ),
  ];
  const result = (code: Detachment["code"]): Detachment => ({
    code,
    detached: code === "detached",
    reason: reasons[code],
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
  const registry = await registrationReference(receipt.composeProject);
  if (registry) {
    return result(registry);
  }
  for (const witness of history) {
    const status = await witnessedCheckoutStatus(witness);
    if (status !== "detached") {
      return result(status);
    }
  }
  return result("detached");
}
