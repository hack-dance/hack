import { dirname, isAbsolute } from "node:path";
import { nativeAuthoredProjectPs } from "../backends/native-authored-project-observe.ts";
import { readNativeDiskUsage } from "../backends/native-disk-usage.ts";
import { nativeProjectPs } from "../backends/native-project-observe.ts";
import {
  invokeNativeRuntime,
  resolveNativeSetupSelection,
} from "../backends/native-runtime-client.ts";
import {
  listNativeCopyInstances,
  listRegistrationCheckouts,
} from "./branch-instance-identity.ts";
import {
  projectDockerTransportEnvironment,
  readDockerDaemonIdentity,
} from "./docker-helper-environment.ts";
import { getString, isRecord } from "./guards.ts";
import { readProjectRuntimeStateEntry } from "./project-runtime-state.ts";
import { readProjectsRegistry } from "./projects-registry.ts";
import { verifyResourceDetachment } from "./resource-detachment.ts";
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
  receipt: import("./resource-receipts.ts").ResourceReceipt
): Promise<ResourceOwner> {
  const { project, checkout, branch } = receipt;
  return {
    project,
    checkout,
    branch,
    detached: (await verifyResourceDetachment(receipt)).detached,
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
  projectDown: boolean
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
    owners: verified ? [await receiptOwner(receipt)] : [owner],
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
  const [runtime, registry, engine, diskTable, volumes] = await Promise.all([
    readRuntimeProjects({ includeGlobal: true }),
    readProjectsRegistry(),
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
  ]);
  const checkouts = new Map(
    registry.projects.flatMap((project) => [
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
          containers.every((item) => ["exited", "dead"].includes(item.state))
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
      ? await verifyResourceDetachment(receipt)
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

async function nativeProjectRows(cwd: string) {
  const runtime = await Promise.resolve()
    .then(() => resolveNativeSetupSelection())
    .catch(() => null);
  if (!runtime) {
    return {
      rows: [] as ResourceRow[],
      owners: new Map<string, ResourceOwner>(),
      complete: false,
    };
  }
  const { projects } = await readProjectsRegistry();
  const work = (
    await Promise.all(
      projects.flatMap((project) =>
        listRegistrationCheckouts(project).flatMap((checkout) =>
          (["runtime", "authored"] as const).map(async (store) =>
            (
              await listNativeCopyInstances({ checkout, store })
            ).map((branch) => ({
              store,
              scope: {
                projectRoot: checkout.root,
                projectDir: checkout.projectDir,
                nativeHome: runtime.home,
                branch,
              },
              owner: {
                project: project.name,
                checkout: checkout.root,
                branch,
                detached: false,
              },
            }))
          )
        )
      )
    )
  ).flat();
  const signal = AbortSignal.timeout(12_000);
  const rows: ResourceRow[] = [];
  const owners = new Map<string, ResourceOwner>();
  let complete = work.length <= 64;
  for (
    let index = 0;
    index < Math.min(64, work.length) && !signal.aborted;
    index += 4
  ) {
    await Promise.all(
      work.slice(index, index + 4).map(async ({ store, scope, owner }) => {
        const observe =
          store === "runtime" ? nativeProjectPs : nativeAuthoredProjectPs;
        const result = await observe({ runtime, scope, signal }).catch(
          () => null
        );
        if (!result || result.status !== "observed") {
          complete = false;
        }
        if (result?.run) {
          owners.set(result.run, owner);
        }
        for (const item of result?.items ?? []) {
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
        if (
          store === "runtime" &&
          result?.run &&
          result.status === "observed"
        ) {
          const graph = await invokeNativeRuntime({
            runtime,
            cwd,
            args: ["graph", "status", "--run-id", result.run, "--json"],
            signal,
            timeoutMs: 5000,
          }).catch(() => null);
          const receipt = isRecord(graph) ? graph.receipt : null;
          if (!(isRecord(receipt) && isRecord(receipt.resources))) {
            complete = false;
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
  return { rows, owners, complete: complete && !signal.aborted };
}

async function nativeInventory(cwd: string) {
  const [disk, storage, projects] = await Promise.all([
    readNativeDiskUsage(cwd).catch(() => null),
    Promise.resolve()
      .then(() =>
        invokeNativeRuntime({
          cwd,
          runtime: resolveNativeSetupSelection(),
          args: ["graph", "storage-inventory", "--json"],
          timeoutMs: 12_000,
        })
      )
      .catch(() => null),
    nativeProjectRows(cwd),
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
      rows.push({
        id: name,
        name,
        kind: "volume",
        backend: "native",
        owners: run
          ? [
              projects.owners.get(run) ?? {
                project: run,
                checkout: null,
                branch: null,
                detached: false,
              },
            ]
          : [],
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
  return {
    rows: groupedResources(rows),
    complete: Boolean(disk?.complete && storage && projects.complete),
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
    nativeComplete: native.complete,
  };
}

export function removableKind(value: string): value is RemovableKind {
  return value === "container" || value === "volume";
}
