import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { nativeAuthoredProjectPs } from "../backends/native-authored-project-observe.ts";
import { readNativeDiskUsage } from "../backends/native-disk-usage.ts";
import { nativeProjectPs } from "../backends/native-project-observe.ts";
import { readNativeResourceRuns } from "../backends/native-resource-runs.ts";
import {
  invokeNativeRuntime,
  resolveNativeSetupSelection,
} from "../backends/native-runtime-client.ts";
import { PROJECT_COMPOSE_FILENAME } from "../constants.ts";
import { resolveComposeProjectName } from "./compose-project-name.ts";
import {
  projectDockerTransportEnvironment,
  readDockerDaemonIdentity,
} from "./docker-helper-environment.ts";
import { getString, isRecord } from "./guards.ts";
import { readProjectConfigFiles } from "./project.ts";
import { readProjectRuntimeStateEntry } from "./project-runtime-state.ts";
import {
  readResourceReferences,
  verifyResourceDetachment,
} from "./resource-detachment.ts";
import {
  type RemovableKind,
  readResourceReceipt,
  resourceFingerprint,
} from "./resource-receipts.ts";
import {
  COMPOSE_DIRECTORY,
  COMPOSE_PROJECT,
  COMPOSE_SERVICE,
  COMPOSE_VOLUME,
  CONTAINER_ID,
  composeLabel,
  dockerDiskBytes,
  dockerNames,
  dockerResourceReader,
  inspectDockerResource,
  RESOURCE_NAME,
  readObject,
} from "./resources-docker.ts";
import {
  type RuntimeContainer,
  readRuntimeProjects,
} from "./runtime-projects.ts";

export type ResourceOwner = {
  readonly project: string;
  readonly checkout: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
};

export type ResourceRow = {
  readonly id: string;
  readonly name: string;
  readonly kind: "container" | "volume" | "image" | "network" | "disk";
  readonly backend: "compose" | "native";
  readonly owners: readonly ResourceOwner[];
  readonly bytes: number | null;
  readonly state: string | null;
  readonly labels?: Readonly<Record<string, string | null>>;
  readonly mounts?: readonly {
    readonly name: string | null;
    readonly destination: string;
    readonly type: string;
  }[];
  readonly ports?: string;
  readonly refusal: string | null;
};

async function receiptOwner(
  receipt: import("./resource-receipts.ts").ResourceReceipt,
  references: Awaited<ReturnType<typeof readResourceReferences>>
): Promise<ResourceOwner> {
  const { project, checkout, branch } = receipt;
  return {
    project,
    checkout,
    branch,
    detached: (await verifyResourceDetachment(receipt, references)).detached,
  };
}

function ownerKey(owner: ResourceOwner) {
  return JSON.stringify([owner.project, owner.branch, owner.checkout]);
}

function groupedResources(rows: readonly ResourceRow[]) {
  const unique = new Map<string, ResourceRow>();
  for (const row of rows) {
    const key = `${row.backend}:${row.kind}:${row.id}`;
    const prior = unique.get(key);
    const owners = new Map(
      [...(prior?.owners ?? []), ...row.owners].map((owner) => [
        ownerKey(owner),
        owner,
      ])
    );
    unique.set(key, {
      ...row,
      owners: [...owners.values()],
      refusal: prior?.refusal ?? row.refusal,
    });
  }
  return [...unique.values()];
}

function attachment(
  container: ResourceRow,
  kind: "image" | "volume" | "network",
  name: string
): ResourceRow {
  return {
    id: name,
    name,
    kind,
    backend: "compose",
    owners: container.owners,
    bytes: null,
    state: null,
    refusal: "Referenced by an observed container.",
  };
}

function composeLabels(container: RuntimeContainer) {
  return Object.fromEntries(
    [COMPOSE_PROJECT, COMPOSE_SERVICE, COMPOSE_DIRECTORY].map((key) => [
      key,
      container.labels?.[key] ?? null,
    ])
  );
}

async function fromContainer(
  container: RuntimeContainer,
  owner: ResourceOwner,
  daemon: string | null,
  projectDown: boolean,
  references: Awaited<ReturnType<typeof readResourceReferences>>
) {
  const receipt =
    daemon && CONTAINER_ID.test(container.id)
      ? await readResourceReceipt({
          daemon,
          kind: "container",
          id: container.id,
        })
      : null;
  const fingerprint = resourceFingerprint("container", {
    id: container.id,
    labels: container.labels,
  });
  const verified = receipt && receipt.fingerprint === fingerprint;
  const removableState = ["exited", "dead"].includes(container.state);
  let stoppedRefusal: string | null = null;
  if (!verified) {
    stoppedRefusal = "No matching Hack launch receipt.";
  } else if (!projectDown) {
    stoppedRefusal =
      "The Compose project has another active container or unverified state.";
  }
  const row: ResourceRow = {
    id: container.id,
    kind: "container",
    backend: "compose",
    name: container.name || container.service,
    state: container.state,
    owners: verified ? [await receiptOwner(receipt, references)] : [owner],
    bytes: null,
    ports: container.ports,
    labels: composeLabels(container),
    mounts: container.mounts.map(({ name, destination, type }) => ({
      name: name ?? null,
      destination,
      type,
    })),
    refusal: removableState
      ? stoppedRefusal
      : "The container is running or its stopped state is unverified.",
  };
  return [
    row,
    ...container.mounts.flatMap((mount) =>
      mount.type === "volume" && mount.name
        ? [attachment(row, "volume", mount.name)]
        : []
    ),
    ...container.networks.map((network) =>
      attachment(row, "network", network.name)
    ),
    ...(container.image ? [attachment(row, "image", container.image)] : []),
  ];
}

export function resourceDocker(cwd: string) {
  const env = projectDockerTransportEnvironment();
  return {
    read: dockerResourceReader({ cwd, env }),
    daemon: async () => {
      const engine = await readDockerDaemonIdentity({ cwd, env });
      return engine.kind === "verified" ? engine.id : null;
    },
  };
}

function knownCheckout(dir: string, checkouts: ReadonlyMap<string, string>) {
  return checkouts.has(dir) ? dir : dirname(dir);
}

async function composeInventory(cwd: string) {
  const { read, daemon } = resourceDocker(cwd);
  const [runtime, engine, diskTable, volumes, references] = await Promise.all([
    readRuntimeProjects({ includeGlobal: true, readOnlyLifecycle: true }),
    daemon(),
    read([
      "system",
      "df",
      "-v",
      "--format",
      '{"Volumes":{{json .Volumes}},"Images":{{json .Images}}}',
    ]),
    read([
      "volume",
      "ls",
      "--filter",
      `label=${COMPOSE_PROJECT}`,
      "--format",
      "{{.Name}}",
    ]),
    readResourceReferences(),
  ]);
  const checkouts = new Map(
    (references.registry?.projects ?? []).flatMap((project) => [
      [project.repoRoot, project.name] as const,
      ...(project.worktrees ?? []).map(
        (checkout) => [checkout.path, project.name] as const
      ),
    ])
  );
  const rows: ResourceRow[] = [];
  let missingProof = false;
  const disk = readObject(diskTable);
  for (const project of runtime.runtime) {
    const containers = [...project.services.values()].flatMap(
      (service) => service.containers
    );
    for (const container of containers) {
      const dir = container.workingDir;
      const root =
        dir && isAbsolute(dir) ? knownCheckout(dir, checkouts) : null;
      const projectName = root && checkouts.get(root);
      const receipt = engine
        ? await readResourceReceipt({
            daemon: engine,
            kind: "container",
            id: container.id,
          })
        : null;
      const verified =
        receipt &&
        resourceFingerprint("container", {
          id: container.id,
          labels: container.labels,
        }) === receipt.fingerprint;
      if (!(project.isGlobal || projectName || verified)) {
        continue;
      }
      const record =
        projectName && dir
          ? await readProjectRuntimeStateEntry({
              projectDir: dir,
              composeProject: project.project,
            })
          : null;
      const owner = {
        project: projectName || project.project,
        checkout: root,
        branch: record?.launchBranch ?? null,
        detached: false,
      };
      rows.push(
        ...(await fromContainer(
          container,
          owner,
          engine,
          containers.every((item) => ["exited", "dead"].includes(item.state)),
          references
        ))
      );
    }
  }
  const volumeRows = Array.isArray(disk?.Volumes)
    ? disk.Volumes.filter(isRecord)
    : [];
  const sizes = new Map(
    volumeRows.map((row) => [
      getString(row, "Name"),
      dockerDiskBytes(getString(row, "Size")),
    ])
  );
  const images = new Map(
    (Array.isArray(disk?.Images) ? disk.Images.filter(isRecord) : []).map(
      (row) => [
        `${getString(row, "Repository")}:${getString(row, "Tag")}`,
        dockerDiskBytes(getString(row, "Size")),
      ]
    )
  );
  for (const id of dockerNames(volumes, RESOURCE_NAME) ?? []) {
    const receipt = engine
      ? await readResourceReceipt({ daemon: engine, kind: "volume", id })
      : null;
    const volume = await inspectDockerResource(read, "volume", id);
    if (!volume) {
      missingProof = true;
      continue;
    }
    const verified =
      receipt && resourceFingerprint("volume", volume) === receipt.fingerprint;
    const linked = volumeRows.find((row) => row.Name === id);
    const detachment = verified
      ? await verifyResourceDetachment(receipt, references)
      : null;
    if (!verified) {
      missingProof = true;
    }
    const locationRefusal = detachment?.detached
      ? null
      : (detachment?.reason ??
        "No Hack launch receipt. Use hack down from the owning project to stop it and review its retained volumes.");
    rows.push({
      id,
      name: id,
      kind: "volume",
      backend: "compose",
      owners: verified
        ? [
            {
              project: receipt.project,
              checkout: receipt.checkout,
              branch: receipt.branch,
              detached: detachment?.detached ?? false,
            },
          ]
        : [],
      bytes: sizes.get(id) ?? null,
      state: null,
      labels: {
        [COMPOSE_PROJECT]: composeLabel(volume, COMPOSE_PROJECT),
        [COMPOSE_VOLUME]: composeLabel(volume, COMPOSE_VOLUME),
      },
      refusal:
        verified && linked?.Links !== "0"
          ? "Referenced by a container or reference count is unavailable."
          : locationRefusal,
    });
  }
  return {
    rows: groupedResources(
      rows.map((row) => {
        if (row.kind === "volume") {
          return { ...row, bytes: row.bytes ?? sizes.get(row.id) ?? null };
        }
        if (row.kind === "image") {
          const tag = row.id.includes(":") ? row.id : `${row.id}:latest`;
          return { ...row, bytes: row.bytes ?? images.get(tag) ?? null };
        }
        return row;
      })
    ),
    complete: runtime.ok && volumes !== null && disk !== null && !missingProof,
  };
}

type NativeRun = Awaited<
  ReturnType<typeof readNativeResourceRuns>
>["runs"][number];

async function nativeProjectName({ scope, store }: NativeRun) {
  if (
    (await realpath(scope.projectRoot)) !== scope.projectRoot ||
    (await realpath(scope.projectDir)) !== scope.projectDir
  ) {
    return null;
  }
  if (store === "authored") {
    const config: unknown = await Bun.file(
      join(scope.projectDir, "hack.project.json")
    ).json();
    return isRecord(config) ? (getString(config, "name") ?? null) : null;
  }
  const cfg = await readProjectConfigFiles(scope.projectDir);
  if (cfg.parseError) {
    return null;
  }
  const composeFile = join(scope.projectDir, PROJECT_COMPOSE_FILENAME);
  if (!(await Bun.file(composeFile).exists())) {
    return null;
  }
  return await resolveComposeProjectName({
    project: { projectRoot: scope.projectRoot, composeFile },
    cfg,
  });
}

const nativeReaders = {
  select: resolveNativeSetupSelection,
  disk: readNativeDiskUsage,
  invoke: invokeNativeRuntime,
  compose: nativeProjectPs,
  authored: nativeAuthoredProjectPs,
};

async function nativeProjectRows(cwd: string, readers: typeof nativeReaders) {
  const runtime = await Promise.resolve()
    .then(() => readers.select())
    .catch(() => null);
  const rows: ResourceRow[] = [];
  const owners = new Map<string, ResourceOwner>();
  const issues = new Set<string>();
  if (!runtime) {
    issues.add("Native runtime selection is unavailable.");
    return { rows, owners, issues };
  }
  const scan = await readNativeResourceRuns(runtime.home);
  if (scan.missing) {
    issues.add(
      `${scan.missing} native run(s) have a missing or unverifiable checkout receipt.`
    );
  }
  if (scan.incomplete) {
    issues.add("The native run directories could not be fully scanned.");
  }
  const work = scan.runs;
  const signal = AbortSignal.timeout(12_000);

  for (let index = 0; index < work.length && !signal.aborted; index += 4) {
    await Promise.all(
      work.slice(index, index + 4).map(async (entry) => {
        const { store, scope, run } = entry;
        const name = await nativeProjectName(entry).catch(() => null);
        if (!name) {
          issues.add(
            "A native run’s checkout or project name could not be read."
          );
          return;
        }
        const owner = {
          project: name,
          checkout: scope.projectRoot,
          branch: scope.branch,
          detached: false,
        };
        owners.set(run, owner);
        const observe =
          store === "runtime" ? readers.compose : readers.authored;
        const result = await observe({ runtime, scope, signal }).catch(
          () => null
        );
        if (!result || result.run !== run) {
          issues.add("One or more native runs could not be observed.");
          return;
        }
        if (result.status !== "observed") {
          issues.add("One or more native runs could not be fully observed.");
        }
        for (const item of result.items) {
          if (item.container) {
            rows.push({
              id: item.container,
              name: item.service,
              kind: "container",
              backend: "native",
              owners: [owner],
              bytes: null,
              state: item.state,
              refusal:
                "Native containers are managed by their graph. Use the project lifecycle or Doctor.",
            });
          }
        }
        // Legacy graph snapshots report receipt-bound network and image identities.
        if (store === "runtime" && result.status === "observed") {
          const graph = await readers
            .invoke({
              runtime,
              cwd,
              args: ["graph", "status", "--run-id", result.run, "--json"],
              signal,
              timeoutMs: 5000,
            })
            .catch(() => null);
          const receipt = isRecord(graph) ? graph.receipt : null;
          if (
            !(
              isRecord(receipt) &&
              receipt.run === run &&
              isRecord(receipt.resources)
            )
          ) {
            issues.add("Native graph attachments could not be observed.");
            return;
          }
          for (const resource of Object.values(receipt.resources).filter(
            isRecord
          )) {
            const kind = resource.kind === "network" ? "network" : "image";
            const name = getString(
              resource,
              kind === "network" ? "name" : "image"
            );
            if (!name) {
              continue;
            }
            rows.push({
              id: name,
              name,
              kind,
              backend: "native",
              owners: [owner],
              bytes: null,
              state: getString(resource, "phase") ?? null,
              refusal: "Referenced by a native graph.",
            });
          }
        }
      })
    );
  }
  if (signal.aborted) {
    issues.add("Native run observation exceeded its time budget.");
  }
  return { rows, owners, issues };
}

export async function nativeInventory(cwd: string, readers = nativeReaders) {
  const [disk, storage, projects] = await Promise.all([
    readers.disk(cwd).catch(() => null),
    Promise.resolve()
      .then(() =>
        readers.invoke({
          cwd,
          runtime: readers.select(),
          args: ["graph", "storage-inventory", "--json"],
          timeoutMs: 12_000,
        })
      )
      .catch(() => null),
    nativeProjectRows(cwd, readers),
  ]);
  const rows = projects.rows;
  if (disk) {
    rows.push({
      id: "native-home",
      name: "Native home",
      kind: "disk",
      backend: "native",
      owners: [],
      bytes: disk.allocatedBytes,
      state: disk.complete ? null : "Partial scan",
      refusal: "Native home contains shared runtime state.",
    });
  }
  if (isRecord(storage) && Array.isArray(storage.volumes)) {
    for (const volume of storage.volumes.filter(isRecord)) {
      const name = getString(volume, "name");
      const ref = volume.graph_reference;
      if (!(name && isRecord(ref))) {
        continue;
      }
      const run = getString(ref, "run");
      const owner = run ? projects.owners.get(run) : undefined;
      if (!owner) {
        projects.issues.add(
          "One or more native volumes could not be attributed to a checkout."
        );
      }
      rows.push({
        id: name,
        name,
        kind: "volume",
        backend: "native",
        owners: owner ? [owner] : [],
        bytes:
          typeof volume.bytes === "number" &&
          Number.isSafeInteger(volume.bytes) &&
          volume.bytes >= 0
            ? volume.bytes
            : null,
        state: getString(ref, "classification") ?? null,
        refusal:
          "The native runtime retains this volume for a graph or restore.",
      });
    }
  }
  if (!disk?.complete) {
    projects.issues.add("Native home disk usage is incomplete or unavailable.");
  }
  if (!(isRecord(storage) && Array.isArray(storage.volumes))) {
    projects.issues.add("Native storage inventory is unavailable.");
  }
  return {
    rows: groupedResources(rows),
    issues: [...projects.issues].sort(),
  };
}

export async function listResources(cwd: string) {
  const [compose, native] = await Promise.all([
    composeInventory(cwd),
    nativeInventory(cwd),
  ]);
  return {
    rows: [...compose.rows, ...native.rows],
    composeComplete: compose.complete,
    nativeComplete: native.issues.length === 0,
    nativeIssues: native.issues,
  };
}

export function removableKind(value: string): value is RemovableKind {
  return value === "container" || value === "volume";
}
