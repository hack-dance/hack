import {
  NATIVE_STORAGE_DOCKER_ARTIFACT,
  nativeComposeStorageDockerImageReference,
} from "./native-compose-storage-witness-docker-artifact.ts";

/**
 * On-disk format of a `hack data export` backup (see
 * docs/reference/data-backup.md). A backup is a directory holding one
 * `<key>.tar` per owned volume and `manifest.json`, written last. A directory
 * whose name ends in {@link DATA_BACKUP_PARTIAL_SUFFIX} is an interrupted
 * export and is never a backup.
 */
export const DATA_BACKUP_SCHEMA = "hack.data-backup.v1";
export const DATA_BACKUP_TREE_DIGEST = "hack.tree-digest.v1";
export const DATA_BACKUP_MANIFEST = "manifest.json";
export const DATA_BACKUP_PARTIAL_SUFFIX = ".partial";
export const DATA_BACKUPS_DIR_NAME = "data-backups";

/** Compose volume keys and Docker volume names that are safe as file names. */
export const DATA_BACKUP_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/**
 * The pinned helper image the storage witness already uses. Reused so the
 * backup adds no new image; a digest reference resolves the same bytes on
 * every engine.
 */
export function dataBackupHelperImage(): string {
  return nativeComposeStorageDockerImageReference(
    NATIVE_STORAGE_DOCKER_ARTIFACT
  );
}

export type DataBackupVolume = {
  /** Logical key in the Compose model's top-level `volumes:`. */
  readonly key: string;
  /** Docker volume name (`name:` or `<compose project>_<key>`). */
  readonly name: string;
  readonly driver: string;
  /** The Compose labels that proved ownership. */
  readonly labels: {
    readonly "com.docker.compose.project": string;
    readonly "com.docker.compose.volume": string;
  };
  /** File name of the tar inside the backup directory. */
  readonly file: string;
  readonly tarBytes: number;
  /** sha256 of the tar file, computed on the host while it streamed. */
  readonly tarSha256: string;
  /** Entries in the tree, the volume root included. */
  readonly entries: number;
  /** {@link DATA_BACKUP_TREE_DIGEST} of the volume tree, computed in the helper. */
  readonly contentDigest: string;
};

export type DataBackupSkipReason = "external" | "foreign" | "absent";

export type DataBackupSkipped = {
  readonly key: string;
  /** Null when the model gives no name to check (never for Compose output). */
  readonly name: string | null;
  readonly reason: DataBackupSkipReason;
};

export type DataBackupManifest = {
  readonly schema: typeof DATA_BACKUP_SCHEMA;
  /** Hack's project name. */
  readonly project: string;
  /** Branch instance slug, or null for the default instance. */
  readonly branch: string | null;
  readonly composeProject: string;
  /** UTC ISO-8601 time the export started. */
  readonly createdAt: string;
  readonly hackVersion: string;
  readonly helperImage: string;
  readonly digestAlgorithm: typeof DATA_BACKUP_TREE_DIGEST;
  readonly volumes: readonly DataBackupVolume[];
  readonly skipped: readonly DataBackupSkipped[];
};

const MILLISECONDS = /\.\d{3}Z$/;

/** `20261123T140501Z`: sortable, second resolution, safe in any file system. */
export function dataBackupTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(MILLISECONDS, "Z")
    .replaceAll("-", "")
    .replaceAll(":", "");
}

/**
 * Helper-side tree digest, run by the pinned image's Bun against the volume
 * mounted read-only at `/v`. PR 2's restore runs the same script against the
 * restored volume, so the two digests compare directly.
 *
 * {@link DATA_BACKUP_TREE_DIGEST}: every entry (the root as `.`, others by
 * their path relative to the root, as raw bytes) sorted bytewise; for each,
 * seven fields, each followed by one NUL byte: path, type (`f` `d` `l` `c`
 * `b` `p` `s`), permission bits in octal (`mode & 0o7777`), uid, gid, size
 * (regular files only, else 0), and content (a regular file's lowercase hex
 * sha256, a symlink's raw target, a device's decimal rdev, else empty). The
 * digest is the sha256 of that byte stream. No field can contain NUL, so the
 * encoding is unambiguous. Times, xattrs and ACLs are not covered.
 */
export const DATA_BACKUP_DIGEST_SCRIPT = `
const fs=require("node:fs"),crypto=require("node:crypto");
const NUL=Buffer.from([0]),SLASH=Buffer.from("/"),ROOT=Buffer.from(".");
const entries=[];
const kind=s=>s.isFile()?"f":s.isDirectory()?"d":s.isSymbolicLink()?"l":s.isCharacterDevice()?"c":s.isBlockDevice()?"b":s.isFIFO()?"p":s.isSocket()?"s":"?";
const fileHash=p=>{const h=crypto.createHash("sha256"),fd=fs.openSync(p,"r"),b=Buffer.allocUnsafe(1<<20);try{let n;while((n=fs.readSync(fd,b,0,b.length,null))>0)h.update(b.subarray(0,n));}finally{fs.closeSync(fd);}return h.digest("hex");};
const walk=(abs,rel)=>{
 const s=fs.lstatSync(abs),t=kind(s);let size=0,content=Buffer.alloc(0);
 if(t==="f"){size=s.size;content=Buffer.from(fileHash(abs));}
 else if(t==="l"){content=fs.readlinkSync(abs,{encoding:"buffer"});}
 else if(t==="c"||t==="b"){content=Buffer.from(String(s.rdev));}
 entries.push([rel,Buffer.from(t),Buffer.from((s.mode&0o7777).toString(8)),Buffer.from(String(s.uid)),Buffer.from(String(s.gid)),Buffer.from(String(size)),content]);
 if(t==="d")for(const name of fs.readdirSync(abs,{encoding:"buffer"}))walk(Buffer.concat([abs,SLASH,name]),rel===ROOT?name:Buffer.concat([rel,SLASH,name]));
};
walk(Buffer.from("/v"),ROOT);
entries.sort((a,b)=>Buffer.compare(a[0],b[0]));
const h=crypto.createHash("sha256");
for(const fields of entries)for(const field of fields){h.update(field);h.update(NUL);}
process.stdout.write(JSON.stringify({algorithm:"${DATA_BACKUP_TREE_DIGEST}",entries:entries.length,digest:h.digest("hex")})+"\\n");
`;
