import { constants } from "node:fs";
import { access, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { nativeAuthoredProjectPs } from "../backends/native-authored-project-observe.ts";
import { NATIVE_BETA_DOCS_URL } from "../backends/native-beta.ts";
import { nativeProjectPs } from "../backends/native-project-observe.ts";
import { isNativeForeignHomeRefusal } from "../backends/native-project-run.ts";
import { resolveNativeRuntimeSelection } from "../backends/native-runtime-client.ts";
import { parseProjectSelectorOption } from "../cli/project-selector.ts";
import { HACK_PROJECT_DIR_PRIMARY } from "../constants.ts";
import {
  type BranchInstanceCheckout,
  checkoutContext,
  listNativeCopyInstances,
  listRegistrationCheckouts,
} from "../lib/branch-instance-identity.ts";
import { readBranchUsage } from "../lib/branch-usage.ts";
import { autoWorktreeBranch } from "../lib/branches.ts";
import {
  currentCandidateLauncher,
  homeRelativeLauncher,
  homeRelativeLauncherCommand,
} from "../lib/candidate-launcher.ts";
import { emitCliResult, HackCliError, okResult } from "../lib/cli-result.ts";
import { resolveComposeProjectName } from "../lib/compose-project-name.ts";
import { listGitWorktrees } from "../lib/git-worktree.ts";
import { isRecord } from "../lib/guards.ts";
import { resolveUserHomeDir } from "../lib/home-dir.ts";
import { expectedNativeComposeProject } from "../lib/native-compose-generation.ts";
import { jsonPrivate } from "../lib/native-compose-private-state.ts";
import { selectNativeComposeProject } from "../lib/native-compose-selection.ts";
import {
  defaultProjectSlugFromPath,
  type ProjectContext,
  readProjectConfig,
  resolveWorktreeAutoBranch,
} from "../lib/project.ts";
import { inspectProjectInputsAtRoot } from "../lib/project-input-selection.ts";
import {
  readProjectsRegistry,
  selectRegisteredProjectByName,
} from "../lib/projects-registry.ts";
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
  readonly authored: boolean;
};

type Observation = {
  readonly states: ReadonlyMap<string, string>;
  readonly state: string;
  readonly recovery?: string;
};

function copyState(values: readonly string[]): string {
  const failed = values.find(
    (state) => state.startsWith("exited (") && state !== "exited (0)"
  );
  if (failed) {
    return failed;
  }
  for (const state of [
    "port-down",
    "unhealthy",
    "restarting",
    "starting",
    "running",
    "healthy",
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
  instance: string | null,
  path: string
): string | undefined {
  if (!(isNativeForeignHomeRefusal(error) && error instanceof HackCliError)) {
    return undefined;
  }
  const detail = error.detail;
  const selection = isRecord(detail) ? detail.selectionSha256 : null;
  const release =
    typeof selection === "string" && RELEASE_SELECTION.test(selection);
  const expandHome = path.startsWith("~/");
  const command = homeRelativeLauncherCommand({
    launcher: currentCandidateLauncher(),
    args: [
      "doctor",
      ...(expandHome ? [] : [`--path=${path}`]),
      "--native-run-mapping",
      release ? "release" : "inspect",
      ...(release ? ["--expect-selection", selection] : []),
      ...(instance === null ? [] : [`--branch=${instance}`]),
    ],
  });
  return expandHome ? `${command} --path ${path}` : command;
}

const emptyStates = new Map<string, string>();
const unknownCopy: Observation = { states: emptyStates, state: "unknown" };

async function readNativeCopy(
  runtime: NonNullable<ReturnType<typeof resolveNativeRuntimeSelection>>,
  scope: Parameters<typeof nativeProjectPs>[0]["scope"],
  authored: boolean,
  signal: AbortSignal,
  path: string
): Promise<Observation> {
  try {
    const ps = authored ? nativeAuthoredProjectPs : nativeProjectPs;
    const result = await ps({ runtime, scope, signal });
    if (result.status === "pending") {
      return { ...unknownCopy, state: "starting" };
    }
    if (result.status !== "observed") {
      const portDown =
        result.status === "runtime_degraded" &&
        "ports" in result &&
        result.ports?.some((port) => port.state === "down");
      return portDown ? { ...unknownCopy, state: "port-down" } : unknownCopy;
    }
    const states = new Map<string, string>();
    for (const item of result.items) {
      const previous = states.get(item.service);
      const state = psServiceState(item);
      states.set(item.service, previous ? copyState([previous, state]) : state);
    }
    if ("ports" in result) {
      for (const port of result.ports ?? []) {
        if (port.state === "down") {
          states.set(port.service, "port-down");
        }
      }
    }
    return { states, state: copyState([...states.values()]) };
  } catch (error) {
    return {
      ...unknownCopy,
      recovery: nativeRecovery(error, scope.branch, path),
    };
  }
}

// Docker's inventory appends the health status to the uptime display.
const INVENTORY_EXIT = /^Exited \((\d+)\)/;
const INVENTORY_HEALTH = /\((?:health: )?(healthy|unhealthy|starting)\)$/;

function readComposeCopy(runtime: RuntimeProject | undefined): Observation {
  if (!runtime) {
    return unknownCopy;
  }
  const states = new Map(
    [...runtime.services.values()].map(({ service, containers }) => [
      service,
      copyState(
        containers.map(({ state, status }) => {
          const exit = INVENTORY_EXIT.exec(status)?.[1];
          return psServiceState({
            state,
            health: INVENTORY_HEALTH.exec(status.trim())?.[1],
            exitCode: exit === undefined ? undefined : Number(exit),
          });
        })
      ),
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
  recoveries: readonly string[],
  backend: "native" | "compose"
): void {
  const output = createTextOutput();
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  }
  const keys = rows.map(({ branch, checkout }) =>
    JSON.stringify([branch, checkout.name])
  );
  const duplicates = new Set(
    keys.filter((key, index) => keys.indexOf(key) !== index)
  );
  output.table({
    columns: ["branch", "checkout", "state", "address"],
    rows: rows.map((row, index) => [
      row.branch ? { text: row.branch, role: "identity" } : null,
      duplicates.has(keys[index] ?? "")
        ? `${row.checkout.name} (${row.instance ?? "default instance"})`
        : row.checkout.name,
      row.state,
      row.address
        ? { text: row.address, role: "identity" }
        : { text: row.authored ? "" : "no address", role: "faint" },
    ]),
    count: [
      `${rows.length} ${rows.length === 1 ? "copy" : "copies"} on ${backend}`,
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

function containsRoot(top: string, root: string): boolean {
  const subpath = relative(top, root);
  return subpath !== ".." && !subpath.startsWith("../") && !isAbsolute(subpath);
}

async function selectCopies(opts: CopiesOptions) {
  const authored = await selectNativeComposeProject(opts);
  const legacy = authored ? null : await opts.legacyContext();
  const root = await canonical(
    authored?.projectRoot ?? legacy?.projectRoot ?? opts.cwd
  );
  const listed = await listGitWorktrees({ repoRoot: root, timeoutMs: 10_000 });
  const worktrees = await Promise.all(
    (listed ?? []).map(async (item) => ({
      ...item,
      path: await canonical(item.path),
    }))
  );
  const containingTree = (path: string) =>
    worktrees
      .filter((item) => containsRoot(item.path, path))
      .reduce<(typeof worktrees)[number] | undefined>(
        (best, item) =>
          !best || item.path.length > best.path.length ? item : best,
        undefined
      );
  const selectedTree = containingTree(root);
  const peers = new Set(
    worktrees.map(({ path }) =>
      resolve(path, selectedTree ? relative(selectedTree.path, root) : "")
    )
  );
  const gitFor = (path: string) =>
    peers.has(path) ? containingTree(path) : undefined;
  const configured = legacy
    ? await readProjectConfig(legacy).catch(() => undefined)
    : await Bun.file(resolve(root, ".hack/hack.project.json"))
        .json()
        .catch(() => null);
  const configuredName =
    isRecord(configured) && typeof configured.name === "string"
      ? configured.name
      : undefined;
  const { projects } = await readProjectsRegistry();
  const entries = await Promise.all(
    projects.map(async (project) => ({
      project,
      root: await canonical(project.repoRoot),
    }))
  );
  const exact = entries.find((entry) => entry.root === root)?.project;
  const registered =
    opts.project !== undefined
      ? selectRegisteredProjectByName({
          projects,
          name: parseProjectSelectorOption({ projectOpt: opts.project }).name,
        })
      : (exact ??
        entries.find(({ project }) =>
          project.worktrees?.some((item) => resolve(item.path) === root)
        )?.project ??
        entries.find(
          ({ root: peer, project }) =>
            peers.has(peer) && project.name === configuredName
        )?.project ??
        entries.find((entry) => peers.has(entry.root))?.project);
  const projectDirName =
    registered?.projectDirName ??
    legacy?.projectDirName ??
    HACK_PROJECT_DIR_PRIMARY;
  const selected: BranchInstanceCheckout = {
    root,
    projectDir: resolve(root, projectDirName),
    kind: "primary",
  };
  const checkouts = new Map<string, BranchInstanceCheckout>();
  const foreign = new Set(
    entries
      .filter(({ project }) => project !== registered)
      .map((entry) => entry.root)
  );
  const candidates = registered
    ? [...listRegistrationCheckouts(registered), selected]
    : [selected];
  for (const candidate of candidates) {
    const canonicalRoot = await canonical(candidate.root);
    if (
      checkouts.has(canonicalRoot) ||
      (registered &&
        candidate.kind === "worktree" &&
        foreign.has(canonicalRoot))
    ) {
      continue;
    }
    const tree = gitFor(canonicalRoot);
    const gitKind = tree === worktrees[0] ? "primary" : "worktree";
    const kind = tree ? gitKind : candidate.kind;
    checkouts.set(canonicalRoot, { ...candidate, root: canonicalRoot, kind });
  }
  return {
    registration: registered,
    projectDirName,
    checkouts: [...checkouts.values()],
    project: registered?.name ?? defaultProjectSlugFromPath(root),
    gitFor,
    worktrees,
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

function composeInstances(
  base: string | null,
  entries: readonly RuntimeProject[]
) {
  const instances = new Map<string | null, RuntimeProject>();
  if (base === null) {
    return instances;
  }
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
    const matches = inventory.filter(
      (item) =>
        item.project === expected &&
        item.workingDir !== null &&
        GENERATION_DIR.test(relative(root, item.workingDir))
    );
    const first = matches[0];
    if (first) {
      const services = new Map(first.services);
      for (const entry of matches.slice(1)) {
        for (const [name, service] of entry.services) {
          services.set(name, {
            service: name,
            containers: [
              ...(services.get(name)?.containers ?? []),
              ...service.containers,
            ],
          });
        }
      }
      instances.set(instance, { ...first, services });
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
  const {
    registration,
    projectDirName,
    checkouts,
    project,
    gitFor,
    worktrees,
  } = await selectCopies(opts);
  const native = process.env.HACK_RUNTIME_BACKEND === "native";
  const runtime = await Promise.resolve()
    .then(async () => {
      const selected = resolveNativeRuntimeSelection();
      if (selected) {
        await access(selected.binary, constants.X_OK);
      }
      return selected;
    })
    .catch(() => null);
  const inventory = native
    ? null
    : await readRuntimeProjects({ includeGlobal: false, inventoryOnly: true });
  const byDir = await composeIndex(inventory?.runtime ?? []);
  const rows: Copy[] = [];
  const recoveries: string[] = [];
  const names = new Map<string, number>();

  const jobs: ((
    signal: AbortSignal
  ) => Promise<{ row: Copy; recovery?: string }>)[] = [];
  const cwd = await canonical(opts.cwd);
  const home = await canonical(resolveUserHomeDir());
  for (const checkout of checkouts) {
    const root = await canonical(checkout.root);
    const registeredBranch =
      registration?.worktrees?.find((item) => item.path === checkout.root)
        ?.branch ?? null;
    const current = gitFor(root);
    const localTarget = root === cwd ? "." : `./${relative(cwd, root)}`;
    const target = containsRoot(cwd, root)
      ? localTarget
      : homeRelativeLauncher(root, home);

    const gitBranch = current ? current.branch : registeredBranch;
    const label =
      checkout.kind === "primary" ? "primary" : (gitBranch ?? "worktree");
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
    const autoBranch =
      checkout.kind === "worktree" &&
      !authored &&
      resolveWorktreeAutoBranch(cfg);
    const automatic =
      autoBranch && gitBranch ? autoWorktreeBranch(gitBranch, worktrees) : null;
    const usage = await readBranchUsage({
      projectDir: checkout.projectDir,
    }).catch(() => null);
    const dir = await canonical(checkout.projectDir);
    const base = native
      ? ""
      : await resolveComposeProjectName({ project: context, cfg }).catch(
          () => null
        );
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
    const saved = await listNativeCopyInstances({
      checkout,
      store: authored ? "authored" : "runtime",
      includePending: true,
    });
    const instances = [...new Set([automatic, ...containers.keys(), ...saved])];
    const authoredConfigOk =
      !authored ||
      (await Bun.file(family.nativeFile)
        .json()
        .then(isRecord)
        .catch(() => false));
    const observe = async (branch: string | null, signal: AbortSignal) => {
      if (
        !family ||
        family.kind === "none" ||
        family.kind === "conflict" ||
        !usage ||
        !authoredConfigOk ||
        signal.aborted ||
        (!authored && (!cfg || cfg.parseError))
      ) {
        return unknownCopy;
      }
      if (!native) {
        return readComposeCopy(containers.get(branch));
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
            authored,
            signal,
            target ?? "."
          )
        : unknownCopy;
    };
    for (const instance of instances) {
      jobs.push(async (signal) => {
        const observed = await observe(instance, signal);
        const address =
          !authored && LIVE_STATES.has(observed.state)
            ? await addressFor(opts, context, instance, native, observed)
            : null;
        const branch =
          instance === null
            ? gitBranch
            : (usage?.get(instance)?.name ??
              (instance === automatic ? gitBranch : null) ??
              instance);
        const row: Copy = {
          branch,
          checkout: { ...checkout, name },
          instance,
          backend: native ? "native" : "compose",
          state: observed.state,
          address,
          authored,
        };
        const recovery = observed.recovery;
        return {
          row,
          recovery:
            recovery &&
            (instance !== null ||
              (automatic === null && !(autoBranch && current?.detached)))
              ? `${target === undefined ? "from" : "for"} ${name} (${instance ?? "base"}), run: ${recovery}`
              : undefined,
        };
      });
    }
  }
  const signal = AbortSignal.timeout(45_000);
  let next = 0;
  const observations: Awaited<ReturnType<(typeof jobs)[number]>>[] = [];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let index = next++; index < jobs.length; index = next++) {
        const job = jobs[index];
        if (job) {
          observations[index] = await job(signal);
        }
      }
    })
  );
  for (const { row, recovery } of observations) {
    rows.push(row);
    if (recovery) {
      recoveries.push(recovery);
    }
  }
  let code: string | null = null;
  if (native && !runtime) {
    code = "E_NATIVE_SETUP_REQUIRED";
  } else if (signal.aborted) {
    code = "E_TIMEOUT";
  } else if (!(native || inventory?.ok)) {
    code = inventory?.code ?? "E_DOCKER_UNAVAILABLE";
  }
  if (code) {
    const hint =
      code === "E_NATIVE_SETUP_REQUIRED"
        ? `native runtime unavailable · install the hack-next candidate ${NATIVE_BETA_DOCS_URL}`
        : `${native ? "native" : "compose"} status could not be fully observed`;
    recoveries.unshift(hint);
  }

  if (opts.json) {
    emitCliResult({
      result: okResult({
        data: {
          project,
          copies: rows,
          observation: { ok: code === null, code },
        },
      }),
    });
  } else {
    renderCopies(rows, recoveries, native ? "native" : "compose");
  }
  return 0;
}
