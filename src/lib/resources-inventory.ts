import { stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { readNativeDiskUsage } from "../backends/native-disk-usage.ts";
import {
  invokeNativeRuntime,
  resolveNativeSetupSelection,
} from "../backends/native-runtime-client.ts";
import {
  projectDockerTransportEnvironment,
  readDockerDaemonIdentity,
} from "./docker-helper-environment.ts";
import { getString, isRecord } from "./guards.ts";
import { readProjectsRegistry } from "./projects-registry.ts";
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

export async function checkoutGone(checkout: string): Promise<boolean> {
  return await stat(checkout).then(
    () => false,
    (error: unknown) => isRecord(error) && error.code === "ENOENT"
  );
}

async function receiptOwner(receipt: {
  readonly project: string;
  readonly checkout: string;
  readonly branch: string | null;
}): Promise<ResourceOwner> {
  const { project, checkout, branch } = receipt;
  return { project, checkout, branch, detached: await checkoutGone(checkout) };
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
    unique.set(key, { ...row, owners: [...owners.values()] });
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
  daemon: string | null
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
  const removableState = ["created", "exited", "dead"].includes(
    container.state
  );
  const stoppedRefusal = verified ? null : "No matching Hack launch receipt.";
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

function parseList(raw: string | null): Record<string, unknown>[] {
  try {
    const list: unknown = raw === null ? null : JSON.parse(raw);
    return Array.isArray(list) ? list.filter(isRecord) : [];
  } catch {
    return [];
  }
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

async function composeInventory(cwd: string) {
  const { read, daemon } = resourceDocker(cwd);
  const [runtime, registry, engine, volumeTable, imageTable, volumes] =
    await Promise.all([
      readRuntimeProjects({ includeGlobal: true }),
      readProjectsRegistry(),
      daemon(),
      read(["system", "df", "-v", "--format", "{{json .Volumes}}"]),
      read(["system", "df", "-v", "--format", "{{json .Images}}"]),
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
  for (const project of runtime.runtime) {
    const containers = [...project.services.values()].flatMap(
      (service) => service.containers
    );
    for (const container of containers) {
      const dir = container.workingDir;
      const root = dir && isAbsolute(dir) ? dirname(dir) : null;
      const projectName =
        root && (checkouts.get(root) ?? checkouts.get(dir ?? ""));
      const detached = Boolean(root && (await checkoutGone(root)));
      const hackConfig = dir?.endsWith("/.hack") || dir?.endsWith("/.dev");
      if (!(project.isGlobal || projectName || (hackConfig && detached))) {
        continue;
      }
      const owner = {
        project: projectName || project.project,
        checkout: root,
        branch: null,
        detached,
      };
      rows.push(...(await fromContainer(container, owner, engine)));
    }
  }
  const volumeRows = parseList(volumeTable);
  const sizes = new Map(
    volumeRows.map((row) => [
      getString(row, "Name"),
      dockerDiskBytes(getString(row, "Size")),
    ])
  );
  const images = new Map(
    parseList(imageTable).map((row) => [
      `${getString(row, "Repository")}:${getString(row, "Tag")}`,
      dockerDiskBytes(getString(row, "Size")),
    ])
  );
  for (const id of dockerNames(volumes, RESOURCE_NAME) ?? []) {
    const receipt = engine
      ? await readResourceReceipt({ daemon: engine, kind: "volume", id })
      : null;
    if (!receipt) {
      continue;
    }
    const volume = await inspectDockerResource(read, "volume", id);
    if (
      !volume ||
      resourceFingerprint("volume", volume) !== receipt.fingerprint
    ) {
      continue;
    }
    const linked = volumeRows.find((row) => row.Name === id);
    const owner = await receiptOwner(receipt);
    const locationRefusal = owner.detached
      ? null
      : "A live checkout can still reference this volume.";
    rows.push({
      id,
      name: id,
      kind: "volume",
      backend: "compose",
      owners: [owner],
      bytes: sizes.get(id) ?? null,
      state: null,
      labels: {
        [COMPOSE_PROJECT]: receipt.composeProject,
        [COMPOSE_VOLUME]: composeLabel(volume, COMPOSE_VOLUME),
      },
      refusal:
        linked?.Links !== "0"
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
    complete:
      runtime.ok &&
      volumes !== null &&
      volumeTable !== null &&
      imageTable !== null,
  };
}

async function nativeInventory(cwd: string) {
  const [disk, storage] = await Promise.all([
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
  ]);
  const rows: ResourceRow[] = [];
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
          ? [{ project: run, checkout: null, branch: null, detached: false }]
          : [],
        bytes:
          typeof volume.bytes === "number" && volume.bytes >= 0
            ? volume.bytes
            : null,
        state: getString(ref, "classification") ?? null,
        refusal:
          "The native runtime retains this volume for a graph or restore.",
      });
    }
  }
  return { rows, complete: Boolean(disk?.complete && storage) };
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
