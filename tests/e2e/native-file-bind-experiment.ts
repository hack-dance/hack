import { isRecord } from "../../src/lib/guards.ts";

const HEX = /^[a-f0-9]{64}$/;
const OWNERS = ["root", "selected-a", "selected-b", "other"] as const;
const READS = ["success", "EACCES", "unknown"] as const;
const WRITES = ["EROFS", "success", "unknown", "not-requested"] as const;
export type BindExperimentRow = {
  readonly slot: number;
  readonly identity: string;
  readonly owner: (typeof OWNERS)[number];
  readonly group: (typeof OWNERS)[number];
  readonly ownerIsSelf: boolean;
  readonly modeMatched: boolean;
  readonly stable: boolean;
  readonly read: (typeof READS)[number];
  readonly bytesMatched: boolean | null;
  readonly write: (typeof WRITES)[number];
};
function refuse(): never {
  throw new Error("Synthetic bind observation refused; values omitted.");
}
function oneOf<T extends string>(
  value: unknown,
  choices: readonly T[]
): value is T {
  return (
    typeof value === "string" && choices.some((choice) => choice === value)
  );
}

/**
 * Diagnostic only: an owner mismatch does not suppress the synthetic read.
 * No target, UID/GID, file bytes or exception text is emitted. Identity tokens
 * compare stat dev/ino without exposing either value. The existing permission
 * acceptance program is unchanged and remains strict.
 */
export const nativeFileBindExperimentProgram = `
import {lstat,readFile,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
const timer=setTimeout(()=>process.exit(89),5000);timer.unref();
const identity=s=>createHash("sha256").update(JSON.stringify([s.dev,s.ino])).digest("hex");
const owner=n=>n===0?"root":n===65534?"selected-a":n===65533?"selected-b":"other";
try{
 const raw=await Bun.stdin.arrayBuffer();if(raw.byteLength>8192)process.exit(71);
 const input=JSON.parse(new TextDecoder().decode(raw));
 if(!input||!Array.isArray(input.rows)||![2,4].includes(input.rows.length)||typeof input.write!=="boolean"||![0,65534,65533].includes(process.getuid())||(input.write&&process.getuid()!==0))process.exit(72);
 const observations=[];
 for(const row of input.rows){
  if(!row||!Number.isSafeInteger(row.slot)||typeof row.target!=="string"||!row.target.startsWith("/")||!["0400","0600"].includes(row.mode)||!Array.isArray(row.bytes)||row.bytes.length>256||row.bytes.some(b=>!Number.isInteger(b)||b<0||b>255))process.exit(73);
  const before=await lstat(row.target);if(!before.isFile()||before.isSymbolicLink())process.exit(74);
  let read="unknown",bytesMatched=null;
  try{const actual=new Uint8Array(await readFile(row.target));read="success";bytesMatched=JSON.stringify(Array.from(actual))===JSON.stringify(row.bytes)}catch(error){if(error?.code==="EACCES")read="EACCES"}
  let write="not-requested";
  if(input.write){try{await writeFile(row.target,"synthetic-permission-write-counterexample");write="success"}catch(error){write=error?.code==="EROFS"?"EROFS":"unknown"}}
  const after=await lstat(row.target);
  observations.push({slot:row.slot,identity:identity(before),owner:owner(before.uid),group:owner(before.gid),ownerIsSelf:before.uid===process.getuid(),modeMatched:(before.mode&4095)===Number.parseInt(row.mode,8),stable:after.isFile()&&!after.isSymbolicLink()&&before.dev===after.dev&&before.ino===after.ino&&before.mode===after.mode&&before.uid===after.uid&&before.gid===after.gid&&before.size===after.size,read,bytesMatched,write});
 }
 process.stdout.write(JSON.stringify({version:1,observer:owner(process.getuid()),rows:observations}));
}catch{process.exit(75)}
`;

/** Closed diagnostic codec. Unknown read outcomes remain observations, never permission success. */
export function readBindExperiment(text: string, slots: readonly number[]) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse();
  }
  if (
    !(
      isRecord(value) &&
      Object.keys(value).sort().join() === "observer,rows,version" &&
      value.version === 1 &&
      oneOf(value.observer, OWNERS) &&
      Array.isArray(value.rows) &&
      value.rows.length === slots.length
    )
  ) {
    return refuse();
  }
  const rows = value.rows.map(
    (row: unknown, index: number): BindExperimentRow => {
      if (
        !(
          isRecord(row) &&
          Object.keys(row).sort().join() ===
            "bytesMatched,group,identity,modeMatched,owner,ownerIsSelf,read,slot,stable,write" &&
          row.slot === slots[index] &&
          typeof row.identity === "string" &&
          HEX.test(row.identity) &&
          oneOf(row.owner, OWNERS) &&
          oneOf(row.group, OWNERS) &&
          typeof row.ownerIsSelf === "boolean" &&
          typeof row.modeMatched === "boolean" &&
          typeof row.stable === "boolean" &&
          oneOf(row.read, READS) &&
          oneOf(row.write, WRITES) &&
          (row.read === "success"
            ? typeof row.bytesMatched === "boolean"
            : row.bytesMatched === null)
        )
      ) {
        return refuse();
      }
      return row as BindExperimentRow;
    }
  );
  return { observer: value.observer as (typeof OWNERS)[number], rows };
}

/** Choose once from fixed UIDs after every root observation; no trial/retry selects a favorable result. */
export function selectBindExperimentNonowner(
  rows: readonly BindExperimentRow[]
): 65534 | 65533 {
  for (const [owner, uid] of [
    ["selected-a", 65_534],
    ["selected-b", 65_533],
  ] as const) {
    if (rows.every((row) => row.owner !== owner)) {
      return uid;
    }
  }
  return refuse();
}
