import { readdir, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { nativeAuthoredProjectPs } from "../backends/native-authored-project-observe.ts";
import { nativeProjectPs } from "../backends/native-project-observe.ts";
import { isNativeForeignHomeRefusal } from "../backends/native-project-run.ts";
import { resolveNativeRuntimeSelection } from "../backends/native-runtime-client.ts";
import { HACK_PROJECT_DIR_PRIMARY } from "../constants.ts";
import {
  type BranchInstanceCheckout,
  checkoutContext,
  listNativeCopyInstances,
  listRegistrationCheckouts,
} from "../lib/branch-instance-identity.ts";
import { readBranchUsage } from "../lib/branch-usage.ts";
import { emitCliResult, HackCliError, okResult } from "../lib/cli-result.ts";
import { resolveComposeProjectName } from "../lib/compose-project-name.ts";
import { resolveGitCurrentBranch } from "../lib/git-worktree.ts";
import { isRecord } from "../lib/guards.ts";
import { expectedNativeComposeProject } from "../lib/native-compose-generation.ts";
import { jsonPrivate } from "../lib/native-compose-private-state.ts";
import { selectNativeComposeProject } from "../lib/native-compose-selection.ts";
import { scopedHackCommand } from "../lib/printed-shell-command.ts";
import {
  defaultProjectSlugFromPath,
  type ProjectContext,
  readProjectConfig,
  resolveWorktreeAutoBranch,
  sanitizeBranchSlug,
} from "../lib/project.ts";
import { inspectProjectInputsAtRoot } from "../lib/project-input-selection.ts";
import { readProjectsRegistry } from "../lib/projects-registry.ts";
import {
  type RuntimeProject,
  readRuntimeProjects,
} from "../lib/runtime-projects.ts";
import { psServiceState } from "../ui/ps-output.ts";
import { createTextOutput } from "../ui/text-output.ts";

type Copy = {
  readonly branch: string | null;
  readonly checkout: BranchInstanceCheckout & { readonly name: string };
  readonly instance: string | null;
  readonly backend: "compose" | "native";
  readonly state: string;
  readonly address: string | null;
};

type Observation = {
  readonly states: ReadonlyMap<string, string>;
  readonly state: string;
  readonly recovery?: string;
};

function copyState(values: readonly string[]): string {
  for (const state of [
    "port-down",
    "unhealthy",
    "starting",
    "running",
    "healthy",
    "restarting",
  ]) {
    if (values.includes(state)) {
      return state;
    }
  }
  return values.find((state) => state !== "unknown") ?? "unknown";
}

const RELEASE_SELECTION = /^[a-f0-9]{64}$/;

function nativeRecovery(
  error: unknown,
  instance: string | null
): string | undefined {
  if (!(isNativeForeignHomeRefusal(error) && error instanceof HackCliError)) {
    return undefined;
  }
  const detail = error.detail;
  const selection = isRecord(detail) ? detail.selectionSha256 : null;
  const release =
    typeof selection === "string" && RELEASE_SELECTION.test(selection);
  return scopedHackCommand("doctor", {}, [
    "--native-run-mapping",
    release ? "release" : "inspect",
    ...(release ? ["--expect-selection", selection] : []),
    ...(instance === null ? [] : [`--branch=${instance}`]),
  ]);
}

const emptyStates = new Map<string, string>();
const unknownCopy: Observation = { states: emptyStates, state: "unknown" };

async function readNativeCopy(
  runtime: NonNullable<ReturnType<typeof resolveNativeRuntimeSelection>>,
  scope: Parameters<typeof nativeProjectPs>[0]["scope"],
  authored: boolean
): Promise<Observation> {
  try {
    const ps = authored ? nativeAuthoredProjectPs : nativeProjectPs;
    const result = await ps({ runtime, scope });
    if (result.status === "pending") {
      return { ...unknownCopy, state: "starting" };
    }
    if (
      result.status === "not_started" ||
      result.status === "runtime_not_running"
    ) {
      return { ...unknownCopy, state: "stopped" };
    }
    if (result.status !== "observed") {
      return unknownCopy;
    }
    const states = new Map(
      result.items.map((item) => [item.service, psServiceState(item)])
    );
    if ("ports" in result) {
      for (const port of result.ports ?? []) {
        if (port.state === "down") {
          states.set(port.service, "port-down");
        }
      }
    }
    return { states, state: copyState([...states.values()]) };
  } catch (error) {
    return { ...unknownCopy, recovery: nativeRecovery(error, scope.branch) };
  }
}

function readComposeCopy(
  runtime: RuntimeProject | undefined,
  available: boolean
): Observation {
  if (!runtime) {
    return { ...unknownCopy, state: available ? "stopped" : "unknown" };
  }
  const states = new Map(
    [...runtime.services.values()].map(({ service, containers }) => [
      service,
      copyState(containers.map(psServiceState)),
    ])
  );
  return { states, state: copyState([...states.values()]) };
}

const LIVE_STATES = new Set([
  "running",
  "healthy",
  "unhealthy",
  "starting",
  "port-down",
]);

function renderCopies(
  rows: readonly Copy[],
  recoveries: readonly string[]
): void {
  const output = createTextOutput();
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  }
  output.table({
    columns: ["branch", "checkout", "state", "address"],
    rows: rows.map((row) => [
      row.branch ? { text: row.branch, role: "identity" } : null,
      row.checkout.name,
      row.state,
      row.address
        ? { text: row.address, role: "identity" }
        : { text: "no address", role: "faint" },
    ]),
    count: [
      `${rows.length} ${rows.length === 1 ? "copy" : "copies"}`,
      ...[...counts].map(([state, count]) => `${count} ${state}`),
    ].join(" · "),
  });
  for (const recovery of recoveries) {
    output.line(recovery, "faint");
  }
}

async function canonical(path: string): Promise<string> {
  return await realpath(path).catch(() => resolve(path));
}

type CopiesOptions = {
  readonly cwd: string;
  readonly path?: string;
  readonly project?: string;
  readonly json: boolean;
  readonly legacyContext: () => Promise<ProjectContext>;
  readonly addresses: (
    project: ProjectContext,
    branch: string | null,
    native: boolean
  ) => Promise<ReadonlyMap<string, readonly string[]>>;
};

async function selectCopies(opts: CopiesOptions) {
  const authored = await selectNativeComposeProject(opts);
  const legacy = authored ? null : await opts.legacyContext();
  const root = await canonical(
    authored?.projectRoot ?? legacy?.projectRoot ?? opts.cwd
  );
  const registry = await readProjectsRegistry();
  const registration = registry.projects.find((item) =>
    listRegistrationCheckouts(item).some(
      ({ root: checkout }) => resolve(checkout) === root
    )
  );
  const projectDirName =
    registration?.projectDirName ??
    legacy?.projectDirName ??
    HACK_PROJECT_DIR_PRIMARY;
  const primary: BranchInstanceCheckout = {
    root,
    projectDir: resolve(root, projectDirName),
    kind: "primary",
  };
  return {
    registration,
    projectDirName,
    checkouts: registration
      ? listRegistrationCheckouts(registration)
      : [primary],
    project: registration?.name ?? defaultProjectSlugFromPath(root),
  };
}

async function composeIndex(inventory: readonly RuntimeProject[]) {
  const byDir = new Map<string, RuntimeProject[]>();
  for (const entry of inventory) {
    if (!entry.workingDir) {
      continue;
    }
    const dir = await canonical(entry.workingDir);
    const list = byDir.get(dir) ?? [];
    list.push(entry);
    byDir.set(dir, list);
  }
  return byDir;
}

function composeInstances(base: string, entries: readonly RuntimeProject[]) {
  const instances = new Map<string | null, RuntimeProject>();
  for (const entry of entries) {
    if (entry.project === base) {
      instances.set(null, entry);
    } else if (
      entry.project.startsWith(`${base}--`) &&
      entry.project.length > base.length + 2
    ) {
      instances.set(entry.project.slice(base.length + 2), entry);
    }
  }
  return instances;
}

const INSTANCE_DIGEST = /^[a-f0-9]{64}$/;
const GENERATION_DIR = /^generations\/[a-f0-9]+$/;

async function authoredComposeInstances(
  checkout: BranchInstanceCheckout,
  inventory: readonly RuntimeProject[]
): Promise<Map<string | null, RuntimeProject>> {
  const store = resolve(checkout.projectDir, ".internal/native-compose");
  const directories = await readdir(store, { withFileTypes: true }).catch(
    () => []
  );
  const instances = new Map<string | null, RuntimeProject>();
  for (const directory of directories) {
    if (!(directory.isDirectory() && INSTANCE_DIGEST.test(directory.name))) {
      continue;
    }
    const root = resolve(store, directory.name);
    const receipt = await jsonPrivate(resolve(root, "receipt.json")).catch(
      () => null
    );
    const identity = isRecord(receipt) ? receipt.identity : null;
    if (!isRecord(identity)) {
      continue;
    }
    const instance = identity.instance;
    if (instance !== null && typeof instance !== "string") {
      continue;
    }
    const expected = await expectedNativeComposeProject({
      projectRoot: checkout.root,
      instance,
    }).catch(() => null);
    if (
      expected !== `hack-nc-${directory.name.slice(0, 32)}` ||
      expected !== identity.composeProject ||
      identity.checkoutRoot !== checkout.root
    ) {
      continue;
    }
    const entry = inventory.find(
      (item) =>
        item.project === expected &&
        item.workingDir !== null &&
        GENERATION_DIR.test(relative(root, item.workingDir))
    );
    if (entry) {
      instances.set(instance, entry);
    }
  }
  return instances;
}

async function addressFor(
  opts: CopiesOptions,
  context: ProjectContext,
  instance: string | null,
  native: boolean,
  observation: Observation
) {
  const routes = await opts
    .addresses(context, instance, native)
    .catch(() => null);
  for (const [service, urls] of routes ?? []) {
    const state = observation.states.get(service) ?? "";
    if (urls[0] && state !== "port-down" && LIVE_STATES.has(state)) {
      return urls[0];
    }
  }
  return null;
}

export async function runProjectCopies(opts: CopiesOptions): Promise<number> {
  const { registration, projectDirName, checkouts, project } =
    await selectCopies(opts);
  const native = process.env.HACK_RUNTIME_BACKEND === "native";
  const runtime = await Promise.resolve()
    .then(() => resolveNativeRuntimeSelection())
    .catch(() => null);
  const inventory = native
    ? null
    : await readRuntimeProjects({ includeGlobal: false, inventoryOnly: true });
  const byDir = await composeIndex(inventory?.runtime ?? []);
  const rows: Copy[] = [];
  const recoveries: string[] = [];
  const names = new Map<string, number>();

  for (const checkout of checkouts) {
    const registeredBranch =
      registration?.worktrees?.find((item) => item.path === checkout.root)
        ?.branch ?? null;
    const label =
      checkout.kind === "primary"
        ? "primary"
        : (registeredBranch ?? "worktree");
    const count = (names.get(label) ?? 0) + 1;
    names.set(label, count);
    const name = count === 1 ? label : `${label} (${count})`;
    const context = checkoutContext({
      registration: { projectDirName },
      checkout,
    });
    const family = await inspectProjectInputsAtRoot({
      projectRoot: checkout.root,
    }).catch(() => null);
    const authored = family?.kind === "native";
    const cfg = await readProjectConfig(context).catch(() => undefined);
    const automatic =
      registeredBranch && !authored && resolveWorktreeAutoBranch(cfg)
        ? sanitizeBranchSlug(registeredBranch)
        : null;
    const usage = await readBranchUsage({
      projectDir: checkout.projectDir,
    }).catch(() => new Map());
    const root = await canonical(checkout.root);
    const dir = await canonical(checkout.projectDir);
    const base = native
      ? ""
      : await resolveComposeProjectName({ project: context, cfg });
    const containers =
      authored && inventory
        ? await authoredComposeInstances(
            { ...checkout, root, projectDir: dir },
            inventory.runtime
          )
        : composeInstances(base, [
            ...(byDir.get(root) ?? []),
            ...(byDir.get(dir) ?? []),
          ]);
    const saved = native
      ? await listNativeCopyInstances({
          checkout,
          store: authored ? "authored" : "runtime",
        })
      : [];
    const instances = [...new Set([automatic, ...containers.keys(), ...saved])];
    const gitBranch =
      checkout.kind === "primary"
        ? await resolveGitCurrentBranch({ repoRoot: root }).catch(() => null)
        : registeredBranch;

    const observe = async (branch: string | null) => {
      if (!family || family.kind === "none" || family.kind === "conflict") {
        return unknownCopy;
      }
      if (!native) {
        return readComposeCopy(containers.get(branch), inventory?.ok === true);
      }
      return runtime
        ? await readNativeCopy(
            runtime,
            {
              projectRoot: root,
              projectDir: dir,
              nativeHome: runtime.home,
              branch,
            },
            authored
          )
        : unknownCopy;
    };
    for (let i = 0; i < instances.length; i += 4) {
      const batch = await Promise.all(
        instances.slice(i, i + 4).map(async (instance) => {
          const observed = await observe(instance);
          const address =
            !authored && LIVE_STATES.has(observed.state)
              ? await addressFor(opts, context, instance, native, observed)
              : null;
          const branch =
            instance === null
              ? gitBranch
              : (usage.get(instance)?.name ??
                (instance === automatic ? registeredBranch : null) ??
                instance);
          const row: Copy = {
            branch,
            checkout: { ...checkout, name },
            instance,
            backend: native ? "native" : "compose",
            state: observed.state,
            address,
          };
          return { row, recovery: observed.recovery };
        })
      );
      for (const { row, recovery } of batch) {
        rows.push(row);
        if (recovery && (row.instance !== null || automatic === null)) {
          recoveries.push(`from ${name}, run: ${recovery}`);
        }
      }
    }
  }

  if (opts.json) {
    emitCliResult({ result: okResult({ data: { project, copies: rows } }) });
  } else {
    renderCopies(rows, recoveries);
  }
  return 0;
}
