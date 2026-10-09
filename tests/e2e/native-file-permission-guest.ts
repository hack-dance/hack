import { isRecord } from "../../src/lib/guards.ts";
import type { NativeComposeFileMode } from "../../src/lib/native-compose-file-permissions.ts";

export type NativeFileFixtureGrant = {
  readonly target: string;
  readonly mode: NativeComposeFileMode;
  readonly bytes: readonly number[];
};
export type NativeFileFixtureGuest = {
  readonly uid: number;
  readonly gid: number;
  readonly members: readonly {
    readonly target: string;
    readonly mode: NativeComposeFileMode;
    readonly uid: number;
    readonly gid: number;
  }[];
};

/** Private stdin carries only fixture-authored bytes; stdout exposes permission facts, never content. */
export const nativeFileFixtureReadProgram = `
import {lstat,readFile} from "node:fs/promises";
const deadline=setTimeout(()=>process.exit(89),5000);deadline.unref();
try {
  const raw=await Bun.stdin.arrayBuffer();if(raw.byteLength>8192)process.exit(31);
  const rows=JSON.parse(new TextDecoder().decode(raw));
  if(!Array.isArray(rows)||rows.length<1||rows.length>8)process.exit(32);
  const members=[];
  for(const row of rows){
    if(typeof row.target!=="string"||!row.target.startsWith("/")||!["0444","0400","0600"].includes(row.mode)||!Array.isArray(row.bytes))process.exit(33);
    const before=await lstat(row.target);
    const actual=new Uint8Array(await readFile(row.target));
    const after=await lstat(row.target);
    if(!before.isFile()||before.isSymbolicLink()||(before.mode&4095)!==Number.parseInt(row.mode,8)||JSON.stringify(Array.from(actual))!==JSON.stringify(row.bytes)||before.dev!==after.dev||before.ino!==after.ino||before.uid!==after.uid||before.gid!==after.gid||before.mode!==after.mode||before.size!==after.size)process.exit(34);
    members.push({target:row.target,mode:row.mode,uid:before.uid,gid:before.gid});
  }
  process.stdout.write(JSON.stringify({version:1,marker:"granted-files-exact",uid:process.getuid(),gid:process.getgid(),members}));
} catch {process.exit(35)}
`;

/** An explicitly privileged observer tests the readonly mount, independently of the reader's DAC rights. */
export const nativeFileFixtureWriteProgram = `
import {writeFile} from "node:fs/promises";
const deadline=setTimeout(()=>process.exit(89),5000);deadline.unref();
try {
  if(process.getuid()!==0)process.exit(41);
  const raw=await Bun.stdin.arrayBuffer();if(raw.byteLength>8192)process.exit(88);const rows=JSON.parse(new TextDecoder().decode(raw));if(!Array.isArray(rows)||rows.length<1||rows.length>8)process.exit(42);
  for(const row of rows){try{await writeFile(row.target,"unexpected-fixture-write");process.exit(43)}catch(error){if(error?.code!=="EROFS")process.exit(44)}}
  process.stdout.write("exact-readonly-files");
} catch {process.exit(45)}
`;

/** The chosen non-root guest UID must differ from every observed protected file owner. Refusal diagnostics contain fixed guard names only. */
export const nativeFileFixtureDeniedProgram = `
import {lstat,readFile} from "node:fs/promises";
const deadline=setTimeout(()=>process.exit(89),5000);deadline.unref();
const refuseMetadata=(guard)=>{try{process.stdout.write(JSON.stringify({version:1,stage:"nonowner-metadata-refused",guard}))}finally{process.exit(52)}};
try {
  const raw=await Bun.stdin.arrayBuffer();if(raw.byteLength>8192)process.exit(88);const rows=JSON.parse(new TextDecoder().decode(raw));if(!Array.isArray(rows)||rows.length<1||rows.length>8||process.getuid()===0)process.exit(51);
  for(const row of rows){
    const info=await lstat(row.target);
    if(!["0400","0600"].includes(row.mode))refuseMetadata("protected-mode");
    if((info.mode&4095)!==Number.parseInt(row.mode,8))refuseMetadata("mode");
    if(info.uid!==row.uid)refuseMetadata(info.uid===process.getuid()?"owner-uid-is-observer":"owner-uid-other");
    if(info.gid!==row.gid)refuseMetadata("owner-gid");
    if(info.uid===process.getuid())refuseMetadata("nonowner-uid");
    try{await readFile(row.target);process.exit(53)}catch(error){if(error?.code!=="EACCES")process.exit(54)}
  }
  process.stdout.write("exact-nonowner-read-refused");
} catch {process.exit(55)}
`;

/** Missing targets must be ENOENT, rather than an unreadable or hidden mount. */
export const nativeFileFixtureAbsentProgram = `
import {lstat} from "node:fs/promises";
const deadline=setTimeout(()=>process.exit(89),5000);deadline.unref();
try {
  const raw=await Bun.stdin.arrayBuffer();if(raw.byteLength>8192)process.exit(88);const rows=JSON.parse(new TextDecoder().decode(raw));if(!Array.isArray(rows)||rows.length<1||rows.length>8)process.exit(61);
  for(const row of rows){try{await lstat(row.target);process.exit(62)}catch(error){if(error?.code!=="ENOENT")process.exit(63)}}
  process.stdout.write("exact-ungranted-files-absent");
} catch {process.exit(64)}
`;

function keys(value: Record<string, unknown>, expected: readonly string[]) {
  if (Object.keys(value).sort().join() !== [...expected].sort().join()) {
    throw new Error("Fixture guest observation shape refused; values omitted");
  }
}
function identity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Decode only bounded JSON and bind every mode/target in order. This grants no engine authority. */
export function readNativeFileFixtureGuest(opts: {
  readonly text: string;
  readonly expected: readonly NativeFileFixtureGrant[];
}): NativeFileFixtureGuest {
  if (opts.text.length > 4096) {
    throw new Error("Fixture guest observation budget refused; values omitted");
  }
  const value: unknown = JSON.parse(opts.text);
  if (!isRecord(value)) {
    throw new Error("Fixture guest observation refused; values omitted");
  }
  keys(value, ["version", "marker", "uid", "gid", "members"]);
  if (
    !(
      value.version === 1 &&
      value.marker === "granted-files-exact" &&
      identity(value.uid) &&
      identity(value.gid) &&
      Array.isArray(value.members) &&
      value.members.length === opts.expected.length
    )
  ) {
    throw new Error("Fixture guest permissions refused; values omitted");
  }
  const members = value.members.map((entry: unknown, index: number) => {
    if (!isRecord(entry)) {
      throw new Error("Fixture guest member refused; values omitted");
    }
    keys(entry, ["target", "mode", "uid", "gid"]);
    const expected = opts.expected[index];
    if (
      !(
        expected &&
        entry.target === expected.target &&
        entry.mode === expected.mode &&
        identity(entry.uid) &&
        identity(entry.gid)
      )
    ) {
      throw new Error("Fixture guest member changed; values omitted");
    }
    return Object.freeze({
      target: expected.target,
      mode: expected.mode,
      uid: entry.uid,
      gid: entry.gid,
    });
  });
  return Object.freeze({
    uid: value.uid,
    gid: value.gid,
    members: Object.freeze(members),
  });
}

/** Select a fixed non-root observer UID only after seeing actual file ownership. Never infer an image default. */
export function nativeFileFixtureNonowner(
  guest: NativeFileFixtureGuest
): number {
  const protectedMembers = guest.members.filter(
    (member) => member.mode !== "0444"
  );
  if (protectedMembers.length === 0) {
    throw new Error("Fixture has no protected target; values omitted");
  }
  for (const uid of [65_534, 65_533]) {
    if (protectedMembers.every((member) => member.uid !== uid)) {
      return uid;
    }
  }
  throw new Error("Fixture nonowner selection refused; values omitted");
}
