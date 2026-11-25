import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { HackCliError } from "./cli-result.ts";
import {
  DATA_BACKUP_MANIFEST,
  DATA_BACKUP_PARTIAL_SUFFIX,
  DATA_BACKUP_SCHEMA,
  DATA_BACKUP_TREE_DIGEST,
  DATA_BACKUP_VOLUME_NAME,
  type DataBackupManifest,
  type DataBackupVolume,
} from "./data-backup-format.ts";
import { parseJsonText } from "./data-backup-helper.ts";
import { isRecord } from "./guards.ts";

const SHA256_HEX = /^[a-f0-9]{64}$/;

/** A backup whose manifest and every listed tar were checked byte for byte. */
export type VerifiedBackup = {
  readonly path: string;
  /** sha256 of the manifest bytes: names this exact backup in labels and journals. */
  readonly id: string;
  readonly manifest: DataBackupManifest;
};

function invalid(path: string, why: string): never {
  throw new HackCliError({
    code: "E_BACKUP_INVALID",
    message: `${path} is not a usable hack data export backup: ${why}. Nothing was changed.`,
  });
}

function count(value: unknown, min: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= min
  );
}

function verifiedVolume(path: string, value: unknown): DataBackupVolume {
  if (
    !(
      isRecord(value) &&
      typeof value.key === "string" &&
      DATA_BACKUP_VOLUME_NAME.test(value.key) &&
      typeof value.nameSha256 === "string" &&
      SHA256_HEX.test(value.nameSha256) &&
      typeof value.driver === "string" &&
      value.file === `${value.key}.tar` &&
      count(value.tarBytes, 0) &&
      typeof value.tarSha256 === "string" &&
      SHA256_HEX.test(value.tarSha256) &&
      count(value.entries, 1) &&
      count(value.excludedSockets, 0) &&
      typeof value.contentDigest === "string" &&
      SHA256_HEX.test(value.contentDigest) &&
      isRecord(value.labelsSha256) &&
      typeof value.labelsSha256["com.docker.compose.project"] === "string" &&
      SHA256_HEX.test(value.labelsSha256["com.docker.compose.project"]) &&
      typeof value.labelsSha256["com.docker.compose.volume"] === "string" &&
      SHA256_HEX.test(value.labelsSha256["com.docker.compose.volume"])
    )
  ) {
    return invalid(path, "a volume record in manifest.json is malformed");
  }
  return {
    key: value.key,
    nameSha256: value.nameSha256,
    driver: value.driver,
    labelsSha256: {
      "com.docker.compose.project":
        value.labelsSha256["com.docker.compose.project"],
      "com.docker.compose.volume":
        value.labelsSha256["com.docker.compose.volume"],
    },
    file: value.file,
    tarBytes: value.tarBytes,
    tarSha256: value.tarSha256,
    entries: value.entries,
    excludedSockets: value.excludedSockets,
    contentDigest: value.contentDigest,
  };
}

/** Parse the manifest strictly; anything unexpected refuses. */
export function parseDataBackupManifest(
  path: string,
  value: unknown
): DataBackupManifest {
  if (
    !(
      isRecord(value) &&
      value.schema === DATA_BACKUP_SCHEMA &&
      typeof value.project === "string" &&
      (value.branch === null || typeof value.branch === "string") &&
      typeof value.composeProjectSha256 === "string" &&
      SHA256_HEX.test(value.composeProjectSha256) &&
      typeof value.createdAt === "string" &&
      typeof value.hackVersion === "string" &&
      typeof value.helperImage === "string" &&
      value.digestAlgorithm === DATA_BACKUP_TREE_DIGEST &&
      Array.isArray(value.volumes) &&
      Array.isArray(value.skipped)
    )
  ) {
    return invalid(
      path,
      `manifest.json is not a ${DATA_BACKUP_SCHEMA} manifest`
    );
  }
  const volumes = value.volumes.map((entry) => verifiedVolume(path, entry));
  if (new Set(volumes.map((volume) => volume.key)).size !== volumes.length) {
    return invalid(path, "manifest.json lists a volume key twice");
  }
  return {
    schema: DATA_BACKUP_SCHEMA,
    project: value.project,
    branch: value.branch,
    composeProjectSha256: value.composeProjectSha256,
    createdAt: value.createdAt,
    hackVersion: value.hackVersion,
    helperImage: value.helperImage,
    digestAlgorithm: DATA_BACKUP_TREE_DIGEST,
    volumes,
    skipped: [],
  };
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        return hash.digest("hex");
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

/**
 * Check a backup directory before any effect: not an interrupted `.partial`
 * export, a `hack.data-backup.v1` manifest, and every listed tar a regular
 * file (never a symlink) with the recorded size and sha256.
 */
export async function verifyDataBackup(path: string): Promise<VerifiedBackup> {
  if (basename(path).endsWith(DATA_BACKUP_PARTIAL_SUFFIX)) {
    return invalid(
      path,
      "it is an interrupted export (.partial), which is never a backup; use a completed backup directory"
    );
  }
  const directory = await lstat(path).catch(() => null);
  if (!directory?.isDirectory()) {
    return invalid(path, "it is not a directory");
  }
  const manifestPath = join(path, DATA_BACKUP_MANIFEST);
  const manifestStat = await lstat(manifestPath).catch(() => null);
  if (!manifestStat?.isFile()) {
    return invalid(
      path,
      "it has no manifest.json (an export writes it last, so the backup is incomplete)"
    );
  }
  const bytes = await readFile(manifestPath);
  const manifest = parseDataBackupManifest(
    path,
    parseJsonText(bytes.toString("utf8"))
  );
  for (const volume of manifest.volumes) {
    const tarPath = join(path, volume.file);
    const tar = await lstat(tarPath).catch(() => null);
    if (!tar?.isFile()) {
      return invalid(path, `${volume.file} is missing`);
    }
    if (tar.size !== volume.tarBytes) {
      return invalid(
        path,
        `${volume.file} has ${tar.size} bytes, the manifest records ${volume.tarBytes}`
      );
    }
    if ((await fileSha256(tarPath)) !== volume.tarSha256) {
      return invalid(path, `${volume.file} does not match its recorded sha256`);
    }
  }
  return {
    path,
    id: createHash("sha256").update(bytes).digest("hex"),
    manifest,
  };
}
