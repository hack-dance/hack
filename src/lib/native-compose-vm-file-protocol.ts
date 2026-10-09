import { isRecord } from "./guards.ts";
import { refuseNativeComposeFile } from "./native-compose-file-bytes.ts";
import { keys } from "./native-compose-private-state.ts";

export const NATIVE_COMPOSE_VM_FILES_EXTENSION = "x-hack-native-vm-files";
export const NATIVE_COMPOSE_VM_FILE_IMAGE = "oven/bun:1.4.2-slim";
export const NATIVE_COMPOSE_VM_FILE_LIMIT = 2 * 1024 * 1024;
/** Docker omits optional empty image fields. Default absence only, retaining
 * every present value for the image decoder's type and policy checks. */
export const VM_FILE_IMAGE_FORMAT =
  '{"id":{{json .Id}},"user":{{$user := ""}}{{range $key, $value := .Config}}{{if eq $key "User"}}{{$user = $value}}{{end}}{{end}}{{json $user}},"volumes":{{$volumesPresent := false}}{{range $key, $value := .Config}}{{if eq $key "Volumes"}}{{$volumesPresent = true}}{{json $value}}{{end}}{{end}}{{if not $volumesPresent}}null{{end}},"labels":{{$labelsPresent := false}}{{range $key, $value := .Config}}{{if eq $key "Labels"}}{{$labelsPresent = true}}{{json $value}}{{end}}{{end}}{{if not $labelsPresent}}null{{end}}}';
const TOKEN = /^[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const WORKLOAD = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const UNSAFE_TARGET = /[\\\0]/;
const DECIMAL = /^(0|[1-9][0-9]{0,24})$/;
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return refuseNativeComposeFile();
  }
}
export type VmFileMode = "0444" | "0400" | "0600";
export type VmFileIdentity = {
  readonly dev: string;
  readonly ino: string;
  readonly ctime: string;
  readonly size: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
};
export type VmFileMember = {
  readonly id: string;
  readonly workload: string;
  readonly target: string;
  readonly mode: VmFileMode;
  readonly uid: number;
  readonly gid: number;
  readonly digest: string;
  readonly file: VmFileIdentity;
};
export type VmFileFacts = {
  readonly version: 1;
  readonly token: string;
  readonly root: VmFileIdentity;
  readonly witness: VmFileIdentity;
  readonly members: readonly VmFileMember[];
};
export function vmFileNumericId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < 0xff_ff_ff_ff
  );
}
function identity(value: unknown): value is VmFileIdentity {
  return (
    isRecord(value) &&
    keys(value, "ctime,dev,gid,ino,mode,size,uid") &&
    typeof value.dev === "string" &&
    DECIMAL.test(value.dev) &&
    typeof value.ino === "string" &&
    DECIMAL.test(value.ino) &&
    value.ino !== "0" &&
    typeof value.ctime === "string" &&
    DECIMAL.test(value.ctime) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    value.size <= 1024 * 1024 &&
    typeof value.mode === "number" &&
    Number.isSafeInteger(value.mode) &&
    value.mode >= 0 &&
    value.mode <= 0o777 &&
    vmFileNumericId(value.uid) &&
    vmFileNumericId(value.gid)
  );
}
/** Closed private observations; these are not a transport or mutation capability. */
export function parseVmFileFacts(text: string): VmFileFacts {
  if (Buffer.byteLength(text) > NATIVE_COMPOSE_VM_FILE_LIMIT) {
    return refuseNativeComposeFile();
  }
  const value = json(text);
  if (
    !(
      isRecord(value) &&
      keys(value, "members,root,token,version,witness") &&
      value.version === 1 &&
      typeof value.token === "string" &&
      TOKEN.test(value.token) &&
      identity(value.root) &&
      value.root.mode === 0o711 &&
      value.root.uid === 0 &&
      value.root.gid === 0 &&
      identity(value.witness) &&
      value.witness.mode === 0o400 &&
      value.witness.uid === 0 &&
      value.witness.gid === 0 &&
      value.witness.size === 32 &&
      Array.isArray(value.members)
    )
  ) {
    return refuseNativeComposeFile();
  }
  const ids = new Set<string>();
  const targets = new Set<string>();
  const members: VmFileMember[] = [];
  let total = 0;
  for (const row of value.members) {
    if (
      !(
        isRecord(row) &&
        keys(row, "digest,file,gid,id,mode,target,uid,workload") &&
        typeof row.id === "string" &&
        TOKEN.test(row.id) &&
        !ids.has(row.id) &&
        typeof row.workload === "string" &&
        WORKLOAD.test(row.workload) &&
        typeof row.target === "string" &&
        row.target.startsWith("/") &&
        row.target !== "/" &&
        !UNSAFE_TARGET.test(row.target) &&
        row.target
          .slice(1)
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== "..") &&
        !targets.has(`${row.workload}:${row.target}`) &&
        (row.mode === "0444" || row.mode === "0400" || row.mode === "0600") &&
        vmFileNumericId(row.uid) &&
        vmFileNumericId(row.gid) &&
        typeof row.digest === "string" &&
        DIGEST.test(row.digest) &&
        identity(row.file) &&
        row.file.mode === Number.parseInt(row.mode, 8) &&
        row.file.uid === row.uid &&
        row.file.gid === row.gid
      )
    ) {
      return refuseNativeComposeFile();
    }
    ids.add(row.id);
    targets.add(`${row.workload}:${row.target}`);
    total += row.file.size;
    if (total > 1024 * 1024) {
      return refuseNativeComposeFile();
    }
    members.push(
      Object.freeze({
        id: row.id,
        workload: row.workload,
        target: row.target,
        mode: row.mode,
        uid: row.uid,
        gid: row.gid,
        digest: row.digest,
        file: Object.freeze({ ...row.file }),
      })
    );
  }
  if (members.length === 0) {
    return refuseNativeComposeFile();
  }
  return Object.freeze({
    version: 1,
    token: value.token,
    root: Object.freeze({ ...value.root }),
    witness: Object.freeze({ ...value.witness }),
    members: Object.freeze(members),
  });
}

/** Omitted ownership uses only Docker's empty-USER default. No passwd/group inference. */
export function resolveVmFileOwnership(opts: {
  readonly uid?: unknown;
  readonly gid?: unknown;
  readonly imageUser: unknown;
}): { readonly uid: number; readonly gid: number } {
  const uid = opts.uid === undefined && opts.imageUser === "" ? 0 : opts.uid;
  const gid = opts.gid === undefined && opts.imageUser === "" ? 0 : opts.gid;
  return vmFileNumericId(uid) && vmFileNumericId(gid)
    ? Object.freeze({ uid, gid })
    : refuseNativeComposeFile();
}
/** Unknown or interrupted observations never become an earned retirement. */
export function parseVmFileJournal(opts: {
  readonly text: string;
  readonly header: string;
}): readonly string[] {
  if (
    Buffer.byteLength(opts.text) > NATIVE_COMPOSE_VM_FILE_LIMIT ||
    !opts.text.startsWith(opts.header) ||
    !opts.text.endsWith("\n")
  ) {
    return refuseNativeComposeFile();
  }
  const phases: string[] = [];
  const initial = [
    "volume-created",
    "writer-created",
    "writer-armed",
    "writer-complete",
    "observer-created",
    "observer-armed",
    "writer-removed",
    "observe-armed",
    "observe-complete",
    "ready",
  ];
  let selected = "ready";
  for (const line of opts.text
    .slice(opts.header.length)
    .trim()
    .split("\n")
    .filter(Boolean)) {
    const row = json(line);
    if (
      !(isRecord(row) && keys(row, "phase") && typeof row.phase === "string")
    ) {
      return refuseNativeComposeFile();
    }
    if (phases.length < initial.length) {
      if (row.phase !== initial[phases.length]) {
        return refuseNativeComposeFile();
      }
    } else {
      const allowed: Readonly<Record<string, readonly string[]>> = {
        ready: ["observe-armed", "retiring"],
        "observe-armed": ["observe-complete"],
        "observe-complete": ["observe-armed", "retiring"],
        retiring: ["observer-stopped"],
        "observer-stopped": ["observer-removed"],
        "observer-removed": ["retired"],
        retired: [],
      };
      if (!allowed[selected]?.includes(row.phase)) {
        return refuseNativeComposeFile();
      }
      selected = row.phase;
    }
    phases.push(row.phase);
  }
  return Object.freeze(phases);
}
export function vmFileJournalReady(phases: readonly string[]): boolean {
  return (
    phases.length >= 10 &&
    (phases.at(-1) === "ready" || phases.at(-1) === "observe-complete")
  );
}

const COMMON = `
import { constants } from "node:fs";
import { open, lstat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
function fail() { process.exit(61); }
function requireValue(value) { if (!value) fail(); }
function closed(value, names) { requireValue(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === names); }
function id(value) { return Number.isSafeInteger(value) && value >= 0 && value < 0xffffffff; }
const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
async function input() {
  const chunks = []; let size = 0;
  for await (const chunk of Bun.stdin.stream()) { size += chunk.length; requireValue(size <= 2097152); chunks.push(chunk); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
async function info(path, directory = false) {
  const s = await lstat(path, { bigint: true });
  requireValue(!s.isSymbolicLink() && (directory ? s.isDirectory() : s.isFile() && s.nlink === 1n));
  return { dev: String(s.dev), ino: String(s.ino), ctime: String(s.ctimeNs), size: Number(s.size), mode: Number(s.mode & 511n), uid: Number(s.uid), gid: Number(s.gid) };
}
async function member(path) {
  const before = await info(path);
  requireValue(before.size <= 1048576);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const held = await fd.stat({bigint:true});
    requireValue(held.isFile() && held.nlink === 1n && String(held.dev) === before.dev && String(held.ino) === before.ino && String(held.ctimeNs) === before.ctime);
    const bytes = await fd.readFile();
    const after = await fd.stat({bigint:true});
    requireValue(bytes.length === before.size && after.isFile() && after.nlink === 1n && String(after.dev) === before.dev && String(after.ino) === before.ino && String(after.ctimeNs) === before.ctime && same(before, await info(path)));
    const digest = hash(bytes); bytes.fill(0); return { file: before, digest };
  } finally { await fd.close(); }
}
async function write(path, bytes, mode, uid, gid) {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await fd.writeFile(bytes); await fd.chown(uid,gid); await fd.chmod(mode); await fd.sync(); }
  finally { bytes.fill(0); await fd.close(); }
}
`;
export const VM_FILE_ACCESS_PROGRAM = `
import { readFile } from "node:fs/promises";
const p = JSON.parse(await Bun.stdin.text());
if (!(p && typeof p === "object" && Object.keys(p).sort().join() === "gid,root,rows,uid" && ["/material","/projection"].includes(p.root) && Number.isSafeInteger(p.uid) && p.uid >= 0 && p.uid < 0xffffffff && Number.isSafeInteger(p.gid) && p.gid >= 0 && p.gid < 0xffffffff && Array.isArray(p.rows) && p.rows.length > 0 && p.rows.length <= 16384)) process.exit(62);
for (const row of p.rows) if (!(row && typeof row === "object" && Object.keys(row).sort().join() === "denied,digest,id" && /^[a-f0-9]{32}$/.test(row.id) && /^[a-f0-9]{64}$/.test(row.digest) && typeof row.denied === "boolean")) process.exit(62);
process.setgroups([]); process.setgid(p.gid); process.setuid(p.uid);
if (process.getuid() !== p.uid || process.getgid() !== p.gid) process.exit(62);
for (const row of p.rows) {
  try {
    const bytes = await readFile(p.root + "/" + row.id);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex"); bytes.fill(0);
    if (row.denied || digest !== row.digest) process.exit(62);
  } catch (error) { if (!(row.denied && error && error.code === "EACCES")) process.exit(62); }
}
`;

export const VM_FILE_WRITER_PROGRAM = `${COMMON}\n${String.raw`
try {
  const p = await input(); closed(p, "members,token,version");
  requireValue(p.version === 1 && /^[a-f0-9]{32}$/.test(p.token) && Array.isArray(p.members) && p.members.length > 0 && p.members.length <= 16384);
  requireValue((await readdir("/material")).length === 0);
  const root = await open("/material", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireValue((await root.stat()).isDirectory()); await root.chown(0,0); await root.chmod(457);
    const ids = new Set(); let size = 0; const members = [];
    for (const row of p.members) {
      closed(row, "bytes,gid,id,mode,target,uid,workload");
      requireValue(/^[a-f0-9]{32}$/.test(row.id) && !ids.has(row.id) && ["0444","0400","0600"].includes(row.mode) && id(row.uid) && id(row.gid) && typeof row.bytes === "string" && typeof row.workload === "string" && /^[a-z0-9][a-z0-9._-]{0,62}$/.test(row.workload) && typeof row.target === "string" && row.target.startsWith("/") && row.target !== "/" && !/[\\\0]/.test(row.target) && row.target.slice(1).split("/").every(part => part !== "" && part !== "." && part !== ".."));
      ids.add(row.id); const bytes = Buffer.from(row.bytes,"base64");
      requireValue(bytes.toString("base64") === row.bytes); size += bytes.length; requireValue(size <= 1048576);
      await write("/material/" + row.id, bytes, parseInt(row.mode,8), row.uid,row.gid);
      members.push({ id:row.id, workload:row.workload, target:row.target, mode:row.mode, uid:row.uid, gid:row.gid, ...await member("/material/" + row.id) });
    }
    await write("/material/.owner", Buffer.from(p.token),256,0,0); await root.sync();
    const access = ${JSON.stringify(VM_FILE_ACCESS_PROGRAM)};
    async function check(uid,gid,rows) {
      const child = Bun.spawn([process.execPath,"-e",access], { stdin: Buffer.from(JSON.stringify({uid,gid,rows,root:"/material"})), stdout:"ignore", stderr:"ignore", env:{PATH:"/usr/local/bin:/usr/bin:/bin"} });
      const timer = setTimeout(() => child.kill("SIGKILL"),3000);
      try { requireValue(await child.exited === 0); } finally { clearTimeout(timer); }
    }
    for (const row of members) await check(row.uid,row.gid,[{id:row.id,digest:row.digest,denied:false}]);
    let other = 65534; while (members.some((row) => row.uid === other || row.gid === other)) other--;
    requireValue(other > 0);
    await check(other,other,members.map((row) => ({id:row.id,digest:row.digest,denied:row.mode !== "0444"})));
    process.stdout.write(JSON.stringify({version:1,token:p.token,root:await info("/material",true),witness:await info("/material/.owner"),members}));
  } finally { await root.close(); }
} catch { fail(); }
`}`;

export const VM_FILE_OBSERVER_PROGRAM = `
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
await Bun.stdin.text();
process.exit(63);
`;
export const VM_FILE_VERIFY_PROGRAM = `${COMMON}\n${`
try {
  const p = await input(); closed(p,"members,root,token,version,witness");
  requireValue(p.version === 1 && /^[a-f0-9]{32}$/.test(p.token) && Array.isArray(p.members) && p.members.length > 0 && p.members.length <= 16384);
  const ids = new Set();
  for (const row of p.members) {
    closed(row,"digest,file,gid,id,mode,target,uid,workload");
    requireValue(/^[a-f0-9]{32}$/.test(row.id) && !ids.has(row.id) && ["0444","0400","0600"].includes(row.mode) && id(row.uid) && id(row.gid) && /^[a-f0-9]{64}$/.test(row.digest));
    ids.add(row.id);
  }
  requireValue(same(await info("/material",true),p.root) && same(await info("/material/.owner"),p.witness));
  requireValue((await readdir("/material")).sort().join() === [".owner",...p.members.map((row) => row.id)].sort().join());
  const witness = await member("/material/.owner"); requireValue(witness.digest === hash(p.token));
  for (const row of p.members) {
    const observed = await member("/material/" + row.id);
    requireValue(same(observed.file,row.file) && observed.digest === row.digest);
    const projected = await member("/projection/" + row.id);
    requireValue(same(projected.file,row.file) && projected.digest === row.digest);
    let denied = false;
    try { const fd = await open("/projection/" + row.id,constants.O_WRONLY | constants.O_NOFOLLOW); await fd.close(); }
    catch (error) { denied = error && error.code === "EROFS"; }
    requireValue(denied);
  }
  const access = ${JSON.stringify(VM_FILE_ACCESS_PROGRAM)};
  async function check(uid,gid,rows) {
    const child=Bun.spawn([process.execPath,"-e",access],{stdin:Buffer.from(JSON.stringify({uid,gid,rows,root:"/projection"})),stdout:"ignore",stderr:"ignore",env:{PATH:"/usr/local/bin:/usr/bin:/bin"}});
    const timer=setTimeout(()=>child.kill("SIGKILL"),3000);
    try {requireValue(await child.exited===0);}finally{clearTimeout(timer);}
  }
  for(const row of p.members)await check(row.uid,row.gid,[{id:row.id,digest:row.digest,denied:false}]);
  let other=65534;while(p.members.some(row=>row.uid===other||row.gid===other))other--;requireValue(other>0);
  await check(other,other,p.members.map(row=>({id:row.id,digest:row.digest,denied:row.mode!=="0444"})));
  requireValue(same(await info("/material",true),p.root) && same(await info("/material/.owner"),p.witness));
  process.stdout.write(JSON.stringify(p));
} catch { fail(); }
`}`;
