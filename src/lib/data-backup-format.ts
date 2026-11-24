import { createHash } from "node:crypto";
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
  /**
   * sha256 of the Docker volume name (`name:` or `<compose project>_<key>`).
   * The resolved name can carry interpolated env values, so only its hash is
   * stored; a restore compares hashes to tell whether the name changed.
   */
  readonly nameSha256: string;
  readonly driver: string;
  /**
   * sha256 of each Compose label that proved ownership: the project label's
   * value is the resolved Compose project name, which can carry
   * interpolated env values, so no value is stored in the clear.
   */
  readonly labelsSha256: {
    readonly "com.docker.compose.project": string;
    readonly "com.docker.compose.volume": string;
  };
  /** File name of the tar inside the backup directory. */
  readonly file: string;
  readonly tarBytes: number;
  /** sha256 of the tar file, computed on the host while it streamed. */
  readonly tarSha256: string;
  /** Entries in the tree, the volume root included, sockets excluded. */
  readonly entries: number;
  /**
   * Unix sockets left out of both the tar (GNU tar skips them) and the
   * digest: they are runtime artifacts (such as `mysql.sock`) that a restore
   * cannot recreate.
   */
  readonly excludedSockets: number;
  /** {@link DATA_BACKUP_TREE_DIGEST} of the volume tree, computed in the helper. */
  readonly contentDigest: string;
};

export type DataBackupSkipReason = "external" | "foreign" | "absent";

/** Skipped volumes are reported by Compose key only, never by Docker name. */
export type DataBackupSkipped = {
  readonly key: string;
  readonly reason: DataBackupSkipReason;
};

/** The identity hash of a resolved Docker volume name. */
export function dataBackupNameSha256(name: string): string {
  return createHash("sha256").update(name).digest("hex");
}

export type DataBackupManifest = {
  readonly schema: typeof DATA_BACKUP_SCHEMA;
  /** Hack's project name (hack.config.json `name`, else the checkout's). */
  readonly project: string;
  /** Branch instance slug, or null for the default instance. */
  readonly branch: string | null;
  /**
   * sha256 of the resolved Compose project name (which can carry
   * interpolated env values); a restore compares hashes.
   */
  readonly composeProjectSha256: string;
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
 * `b` `p`), permission bits in octal (`mode & 0o7777`), uid, gid, size
 * (regular files only, else 0), and content (a regular file's lowercase hex
 * sha256, a symlink's raw target, a device's decimal rdev, else empty). The
 * digest is the sha256 of that byte stream. No field can contain NUL, so the
 * encoding is unambiguous. Times, xattrs and ACLs are not covered. Unix
 * sockets are left out and only counted (`excludedSockets`), because tar
 * cannot archive them, so a restore never has them.
 */
export const DATA_BACKUP_DIGEST_SCRIPT = `
const fs=require("node:fs"),crypto=require("node:crypto");
const NUL=Buffer.from([0]),SLASH=Buffer.from("/"),ROOT=Buffer.from(".");
const entries=[];let sockets=0;
const kind=s=>s.isFile()?"f":s.isDirectory()?"d":s.isSymbolicLink()?"l":s.isCharacterDevice()?"c":s.isBlockDevice()?"b":s.isFIFO()?"p":s.isSocket()?"s":"?";
const fileHash=p=>{const h=crypto.createHash("sha256"),fd=fs.openSync(p,"r"),b=Buffer.allocUnsafe(1<<20);try{let n;while((n=fs.readSync(fd,b,0,b.length,null))>0)h.update(b.subarray(0,n));}finally{fs.closeSync(fd);}return h.digest("hex");};
const walk=(abs,rel)=>{
 const s=fs.lstatSync(abs),t=kind(s);let size=0,content=Buffer.alloc(0);
 if(t==="s"){sockets++;return;}
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
process.stdout.write(JSON.stringify({algorithm:"${DATA_BACKUP_TREE_DIGEST}",entries:entries.length,excludedSockets:sockets,digest:h.digest("hex")})+"\\n");
`;

/**
 * Archive-side tree digest: the same {@link DATA_BACKUP_TREE_DIGEST},
 * computed from a tar stream on stdin instead of a live tree, so export can
 * prove the archive it publishes holds exactly the tree it digested. It
 * streams (constant memory), parses GNU (`L`/`K` long names, base-256
 * numbers) and POSIX/pax (`x`/`g` records, the ustar prefix when the magic is `ustar\0` version
 * `00`) headers, verifies
 * each header checksum, and applies the live script's field rules: regular
 * files hash their content; a hard link takes its target entry's type,
 * size and content (of any type tar links: a file, FIFO, symlink or device)
 * with its own mode, uid and gid, which are the same inode's; symlinks carry their target, devices their rdev (glibc
 * `makedev`), directories and FIFOs nothing. Tar cannot hold sockets, so
 * `excludedSockets` is 0. Any other entry type, a bad checksum or a
 * truncated stream exits non-zero.
 */
export const DATA_BACKUP_ARCHIVE_DIGEST_SCRIPT = `
const crypto=require("node:crypto");
const NUL=Buffer.from([0]),ROOT=Buffer.from(".");
const reader=Bun.stdin.stream().getReader();
let buf=Buffer.alloc(0),eof=false;
const need=async n=>{while(buf.length<n&&!eof){const r=await reader.read();if(r.done){eof=true;break;}buf=buf.length?Buffer.concat([buf,Buffer.from(r.value)]):Buffer.from(r.value);}return buf.length>=n;};
const fail=m=>{process.stderr.write(m+"\\n");process.exit(3);};
const take=async n=>{if(!(await need(n)))fail("truncated archive");const out=buf.subarray(0,n);buf=buf.subarray(n);return out;};
const data=async(size,onChunk)=>{let left=size;while(left>0){if(buf.length===0&&!(await need(1)))fail("truncated archive");const n=Math.min(left,buf.length);onChunk(buf.subarray(0,n));buf=buf.subarray(n);left-=n;}const pad=(512-(size%512))%512;if(pad)await take(pad);};
const bytesOf=async size=>{const parts=[];await data(size,c=>parts.push(Buffer.from(c)));return Buffer.concat(parts);};
const field=(b,o,l)=>{const s=b.subarray(o,o+l);const z=s.indexOf(0);return z<0?s:s.subarray(0,z);};
const num=(b,o,l)=>{if(b[o]&0x80){let v=0n;for(let i=o;i<o+l;i++)v=(v<<8n)|BigInt(i===o?b[i]&0x7f:b[i]);return Number(v);}const t=field(b,o,l).toString("latin1").trim();return t?parseInt(t,8):0;};
const norm=b=>{let s=b;while(s.length>=2&&s[0]===46&&s[1]===47)s=s.subarray(2);while(s.length>1&&s[s.length-1]===47)s=s.subarray(0,s.length-1);return s.length===0||(s.length===1&&s[0]===46)?ROOT:s;};
const paxRecords=b=>{const out={};let o=0;while(o<b.length){const sp=b.indexOf(32,o);if(sp<0)break;const len=parseInt(b.subarray(o,sp).toString("latin1"),10);if(!(len>0))fail("bad pax record");const rec=b.subarray(sp+1,o+len-1);const eq=rec.indexOf(61);if(eq>0)out[rec.subarray(0,eq).toString("latin1")]=rec.subarray(eq+1);o+=len;}return out;};
const makedev=(ma,mi)=>{const M=BigInt(ma),m=BigInt(mi);return String(Number(((M&0xfffff000n)<<32n)|((M&0xfffn)<<8n)|((m&0xffffff00n)<<12n)|(m&0xffn)));};
const entries=[],known=new Map();
let longName=null,longLink=null,pax={},global={};
for(;;){
 if(!(await need(512))){if(entries.length===0)fail("empty archive");break;}
 const h=await take(512);
 if(h.every(x=>x===0))break;
 let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:h[i];
 if(sum!==num(h,148,8))fail("bad header checksum");
 const type=h[156]===0?"0":String.fromCharCode(h[156]);
 let size=num(h,124,12);
 if(type==="L"){longName=field(await bytesOf(size),0,size);continue;}
 if(type==="K"){longLink=field(await bytesOf(size),0,size);continue;}
 if(type==="x"){pax=paxRecords(await bytesOf(size));continue;}
 if(type==="g"){global={...global,...paxRecords(await bytesOf(size))};continue;}
 const meta={...global,...pax};
 const ustar=h.subarray(257,263).toString("latin1")==="ustar\\u0000"&&h.subarray(263,265).toString("latin1")==="00";
 const prefix=ustar?field(h,345,155):Buffer.alloc(0);
 const raw=longName??meta.path??(prefix.length?Buffer.concat([prefix,Buffer.from("/"),field(h,0,100)]):field(h,0,100));
 const link=longLink??meta.linkpath??field(h,157,100);
 if(meta.size)size=parseInt(meta.size.toString("latin1"),10);
 const mode=num(h,100,8)&0o7777;
 const uid=meta.uid?parseInt(meta.uid.toString("latin1"),10):num(h,108,8);
 const gid=meta.gid?parseInt(meta.gid.toString("latin1"),10):num(h,116,8);
 longName=null;longLink=null;pax={};
 const rel=norm(raw);
 const key=rel.toString("latin1");
 let t,fsize=0,content=Buffer.alloc(0);
 if(type==="0"||type==="7"){const hash=crypto.createHash("sha256");await data(size,c=>hash.update(c));const hex=hash.digest("hex");t="f";fsize=size;content=Buffer.from(hex);}
 else if(type==="1"){await data(size,()=>{});const target=known.get(norm(link).toString("latin1"));if(!target)fail("hard link to an unknown entry");t=target.t;fsize=target.fsize;content=target.content;}
 else if(type==="2"){await data(size,()=>{});t="l";content=Buffer.from(link);}
 else if(type==="3"||type==="4"){await data(size,()=>{});t=type==="3"?"c":"b";content=Buffer.from(makedev(num(h,329,8),num(h,337,8)));}
 else if(type==="5"){await data(size,()=>{});t="d";}
 else if(type==="6"){await data(size,()=>{});t="p";}
 else fail("unsupported archive entry type "+type);
 known.set(key,{t,fsize,content});
 entries.push([rel,Buffer.from(t),Buffer.from(mode.toString(8)),Buffer.from(String(uid)),Buffer.from(String(gid)),Buffer.from(String(fsize)),content]);
}
entries.sort((a,b)=>Buffer.compare(a[0],b[0]));
const d=crypto.createHash("sha256");
for(const fields of entries)for(const f of fields){d.update(f);d.update(NUL);}
process.stdout.write(JSON.stringify({algorithm:"${DATA_BACKUP_TREE_DIGEST}",entries:entries.length,excludedSockets:0,digest:d.digest("hex")})+"\\n");
`;
