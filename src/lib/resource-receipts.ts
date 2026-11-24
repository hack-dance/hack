import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { readDockerDaemonIdentity } from "./docker-helper-environment.ts";
import { getString, isRecord } from "./guards.ts";
import {
  ensurePrivateDirectory,
  publishPrivateFileExclusive,
  readReplaceablePrivateFile,
} from "./private-file.ts";
import {
  COMPOSE_DIRECTORY,
  COMPOSE_PROJECT,
  COMPOSE_SERVICE,
  COMPOSE_VOLUME,
  CONTAINER_ID,
  composeLabel,
  dockerNames,
  dockerResourceReader,
  inspectDockerResource,
  RESOURCE_NAME,
} from "./resources-docker.ts";

export type RemovableKind = "container" | "volume";
export type ResourceReceipt = {
  readonly fingerprint: string;
  readonly composeProject: string;
  readonly project: string;
  readonly checkout: string;
  readonly branch: string | null;
  readonly launch: string;
};

const digest = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

export function resourceFingerprint(
  kind: RemovableKind,
  row: Record<string, unknown>
) {
  const project = composeLabel(row, COMPOSE_PROJECT);
  if (kind === "container") {
    const cwd = composeLabel(row, COMPOSE_DIRECTORY);
    const service = composeLabel(row, COMPOSE_SERVICE);
    return project && cwd && service
      ? digest(JSON.stringify([row.id, project, cwd, service]))
      : null;
  }
  const logical = composeLabel(row, COMPOSE_VOLUME);
  return project &&
    logical &&
    row.id === `${project}_${logical}` &&
    row.driver === "local" &&
    row.scope === "local" &&
    getString(row, "created") &&
    (row.options === null ||
      (isRecord(row.options) && Object.keys(row.options).length === 0))
    ? digest(JSON.stringify([row.id, project, logical, row.created]))
    : null;
}

function receiptFile(
  dir: string,
  daemon: string,
  kind: RemovableKind,
  id: string
) {
  return {
    path: join(dir, `${digest(JSON.stringify([daemon, kind, id]))}.json`),
    directories: [dir],
    staging: "sibling",
    refusal: () => new Error("Resource receipt unavailable."),
  } as const;
}

async function privateReceiptDirectory(create: boolean) {
  const root = await realpath(resolveGlobalHackDir());
  const dir = join(root, "resource-receipts");
  const uid = process.getuid?.();
  const rootInfo = await lstat(root);
  if (
    uid === undefined ||
    rootInfo.uid !== uid ||
    (rootInfo.mode & 0o022) !== 0
  ) {
    throw new Error(
      "Hack home is not private for resource receipt publication."
    );
  }
  if (create) {
    await ensurePrivateDirectory(dir);
  }
  const info = await lstat(dir);
  if (!(info.isDirectory() && info.uid === uid && (info.mode & 0o077) === 0)) {
    throw new Error("Resource receipt directory is unsafe.");
  }
  return dir;
}

export async function readResourceReceipt(opts: {
  readonly daemon: string;
  readonly kind: RemovableKind;
  readonly id: string;
}): Promise<ResourceReceipt | null> {
  try {
    const dir = await privateReceiptDirectory(false);
    const file = await readReplaceablePrivateFile({
      ...receiptFile(dir, opts.daemon, opts.kind, opts.id),
      maxBytes: 8192,
    });
    if (!file || (file.mode & 0o077) !== 0) {
      return null;
    }
    const row: unknown = JSON.parse(file.text);
    if (!isRecord(row)) {
      return null;
    }
    const { fingerprint, composeProject, project, checkout, branch, launch } =
      row;
    return typeof fingerprint === "string" &&
      CONTAINER_ID.test(fingerprint) &&
      typeof composeProject === "string" &&
      RESOURCE_NAME.test(composeProject) &&
      typeof project === "string" &&
      project.length > 0 &&
      typeof checkout === "string" &&
      isAbsolute(checkout) &&
      (branch === null || typeof branch === "string") &&
      typeof launch === "string" &&
      launch.length > 0
      ? { fingerprint, composeProject, project, checkout, branch, launch }
      : null;
  } catch {
    return null;
  }
}

async function ownedVolumeKeys(file: string): Promise<Set<string>> {
  const input = Bun.file(file);
  const doc = parseDocument(await input.text());
  const root = doc.contents;
  if (
    doc.errors.length > 0 ||
    !isMap(root) ||
    root.has("include") ||
    root.has("<<")
  ) {
    return new Set();
  }
  const volumes = root.get("volumes", true);
  if (!isMap(volumes) || volumes.has("<<")) {
    return new Set();
  }
  return new Set(
    volumes.items.flatMap(({ key, value }) => {
      if (!isScalar(key) || typeof key.value !== "string") {
        return [];
      }
      const ordinary =
        value == null ||
        (isScalar(value) && value.value === null) ||
        (isMap(value) &&
          !value.has("external") &&
          !value.has("name") &&
          !value.has("<<"));
      return ordinary ? [key.value] : [];
    })
  );
}

/** An exact resource receipt is published only from a successful, admitted Compose launch. */
export async function recordComposeResourceReceipts(opts: {
  readonly projectDir: string;
  readonly composeFile: string;
  readonly checkout: string;
  readonly project: string;
  readonly composeProject: string;
  readonly branch: string | null;
  readonly launch: string;
  readonly daemon: string;
  readonly env: Readonly<Record<string, string>>;
}) {
  const { projectDir, daemon, composeProject, env } = opts;
  const read = dockerResourceReader({ cwd: projectDir, env });
  const ids = dockerNames(
    await read([
      "ps",
      "-aq",
      "--no-trunc",
      "--filter",
      `label=${COMPOSE_PROJECT}=${composeProject}`,
    ]),
    CONTAINER_ID
  );
  if (!ids?.length || ids.length > 32) {
    return;
  }
  const cwd = await realpath(projectDir);
  const containers = await Promise.all(
    ids.map((id) => inspectDockerResource(read, "container", id))
  );
  if (
    containers.some(
      (row) =>
        !row ||
        composeLabel(row, COMPOSE_PROJECT) !== composeProject ||
        composeLabel(row, COMPOSE_DIRECTORY) !== cwd
    )
  ) {
    return;
  }
  const names = new Set(
    containers.flatMap((row) => {
      return Array.isArray(row?.mounts)
        ? row.mounts.flatMap((mount: unknown) =>
            isRecord(mount) &&
            mount.Type === "volume" &&
            typeof mount.Name === "string"
              ? [mount.Name]
              : []
          )
        : [];
    })
  );
  if (names.size > 32) {
    return;
  }
  const allowed = await ownedVolumeKeys(opts.composeFile);
  const volumes = await Promise.all(
    [...names].map((name) => inspectDockerResource(read, "volume", name))
  );
  const engine = await readDockerDaemonIdentity({ cwd: projectDir, env });
  if (engine.kind !== "verified" || engine.id !== daemon) {
    return;
  }
  const dir = await privateReceiptDirectory(true);
  const publish = async (
    kind: RemovableKind,
    row: Record<string, unknown> | null
  ) => {
    const id = row && getString(row, "id");
    if (!(row && id) || composeLabel(row, COMPOSE_PROJECT) !== composeProject) {
      return;
    }
    const fingerprint = resourceFingerprint(kind, row);
    if (
      !fingerprint ||
      (kind === "volume" &&
        !allowed.has(composeLabel(row, COMPOSE_VOLUME) ?? ""))
    ) {
      return;
    }
    const receipt: ResourceReceipt = {
      fingerprint,
      composeProject,
      project: opts.project,
      checkout: opts.checkout,
      branch: opts.branch,
      launch: opts.launch,
    };
    await publishPrivateFileExclusive({
      ...receiptFile(dir, daemon, kind, id),
      text: JSON.stringify(receipt),
    });
  };
  await Promise.all([
    ...containers.map((row) => publish("container", row)),
    ...volumes.map((row) => publish("volume", row)),
  ]);
}
