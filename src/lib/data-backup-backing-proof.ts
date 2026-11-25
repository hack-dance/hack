import type { DataBackupDeadlines } from "./data-backup-deadlines.ts";
import type { DataBackupDocker } from "./data-backup-docker.ts";
import { dataBackupHelperImage } from "./data-backup-format.ts";
import {
  type DataHelperContainers,
  withTrackedContainer,
} from "./data-backup-held-volume.ts";
import {
  type HelperPurpose,
  helperContainerName,
  parseJsonText,
} from "./data-backup-helper.ts";
import type { WatchedVolume } from "./data-backup-volumes.ts";
import { isRecord } from "./guards.ts";

/**
 * Daemon-side proof of where a host path's storage lives, for paths that a
 * foreign container binds (a bind mount's Source, or the `device` of a
 * local bind-alias volume) and that do not overlap an owned Mountpoint by
 * text. Text proves nothing about `/proc/self/root/<Mountpoint>`, a symlink
 * to a Mountpoint, or another mount of the same filesystem.
 *
 * One pinned helper (no network, no logging, read-only root, tracked by
 * ID) gets every candidate bind-mounted read-only at `/c/<i>` and every
 * owned Mountpoint at `/o/<j>`. The daemon resolves each source when it
 * mounts it, symlinks and `/proc/self/root` included. The helper reads its
 * own `/proc/self/mountinfo`: each mount's filesystem (major:minor) and
 * canonical root within it, with the submounts a recursive bind carries.
 * A candidate overlaps an owned volume when one of its mounts is on the same
 * filesystem and either root is inside the other (equal, inside or above).
 * A candidate that is not a directory also overlaps when the owned tree
 * holds the same device and inode (a hard link). Every other outcome of
 * the helper (an error, a timeout, a path that does not exist) is unknown.
 */
export const DATA_BACKUP_BACKING_PROOF_SCRIPT = `
const fs=require("node:fs");
const unescape=s=>s.replace(/\\\\([0-7]{3})/g,(_,o)=>String.fromCharCode(parseInt(o,8)));
const mounts=fs.readFileSync("/proc/self/mountinfo","utf8").split("\\n").filter(Boolean).map(l=>{const f=l.split(" ");return {dev:f[2],root:unescape(f[3]),at:unescape(f[4])};});
const within=(p,r)=>r==="/"||p===r||p.startsWith(r+"/");
const own=fs.readdirSync("/o").map(j=>{const at="/o/"+j;const m=mounts.filter(x=>x.at===at).pop();if(!m)throw new Error("owned mount missing");return {j,at,m,st:fs.statSync(at,{bigint:true})};});
const results={},files=[];
for(const i of fs.readdirSync("/c")){
  const at="/c/"+i;
  const es=mounts.filter(x=>x.at===at||x.at.startsWith(at+"/"));
  if(es.length===0)throw new Error("candidate mount missing");
  results[i]=own.filter(o=>es.some(e=>e.dev===o.m.dev&&(within(o.m.root,e.root)||within(e.root,o.m.root)))).map(o=>o.j);
  const st=fs.lstatSync(at,{bigint:true});
  if(!st.isDirectory())files.push({i,st});
}
for(const o of own){
  const same=files.filter(f=>f.st.dev===o.st.dev&&!results[f.i].includes(o.j));
  if(same.length===0)continue;
  const stack=[o.at];
  while(stack.length>0){
    const d=stack.pop();
    for(const name of fs.readdirSync(d)){
      const p=d+"/"+name,s=fs.lstatSync(p,{bigint:true});
      for(const f of same)if(s.dev===f.st.dev&&s.ino===f.st.ino&&!results[f.i].includes(o.j))results[f.i].push(o.j);
      if(s.isDirectory())stack.push(p);
    }
  }
}
process.stdout.write(JSON.stringify({results})+"\\n");
`;

/**
 * For each candidate path, the watched volume names it reaches, or
 * `undefined` for every candidate when the proof could not be made.
 */
export type BackingProver = (opts: {
  readonly paths: readonly string[];
  readonly volumes: readonly WatchedVolume[];
}) => Promise<ReadonlyMap<string, readonly string[]> | undefined>;

/** A {@link BackingProver} that runs the pinned helper on this engine. */
export function createBackingProver(opts: {
  readonly docker: DataBackupDocker;
  readonly purpose: HelperPurpose;
  readonly deadlines: DataBackupDeadlines;
  readonly helpers: DataHelperContainers;
}): BackingProver {
  return async ({ paths, volumes }) => {
    const owned = volumes.filter((volume) => volume.mountpoint !== "");
    if (paths.length === 0 || owned.length === 0) {
      return new Map(paths.map((path) => [path, []]));
    }
    try {
      const mounts = [
        ...paths.flatMap((path, index) => bindArgs(path, `/c/${index}`)),
        ...owned.flatMap((volume, index) =>
          bindArgs(volume.mountpoint, `/o/${index}`)
        ),
      ];
      const stdout = await withTrackedContainer(
        {
          docker: opts.docker,
          name: `${helperContainerName(opts.purpose)}-proof`,
          createArgs: [
            "--network",
            "none",
            "--log-driver",
            "none",
            "--pull",
            "missing",
            "--read-only",
            "--security-opt",
            "no-new-privileges",
            "--label",
            `io.hack.data-backup=${opts.purpose}`,
            "--env",
            "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
            ...mounts,
            "--entrypoint",
            "bun",
            dataBackupHelperImage(),
            "-e",
            DATA_BACKUP_BACKING_PROOF_SCRIPT,
          ],
          createTimeoutMs: opts.deadlines.stepMs,
          checkCreate: (created) => {
            if (created.exitCode !== 0) {
              throw new Error("the proof helper could not be created");
            }
          },
          deadlines: opts.deadlines,
          helpers: opts.helpers,
        },
        async (container) => {
          const run = await opts.docker.capture(
            ["docker", "start", "--attach", container],
            { timeoutMs: opts.deadlines.stepMs }
          );
          if (run.exitCode !== 0) {
            throw new Error("the proof helper failed");
          }
          return run.stdout;
        }
      );
      return parseProof({ stdout, paths, owned });
    } catch {
      // Not proven: every candidate stays unknown (fail closed).
      return undefined;
    }
  };
}

function bindArgs(source: string, target: string): string[] {
  // Commas would split the --mount value: such a path cannot be proven.
  if (source.includes(",") || source.includes('"')) {
    throw new Error("unbindable path");
  }
  return ["--mount", `type=bind,src=${source},dst=${target},readonly`];
}

function parseProof(opts: {
  readonly stdout: string;
  readonly paths: readonly string[];
  readonly owned: readonly WatchedVolume[];
}): ReadonlyMap<string, readonly string[]> | undefined {
  const value = parseJsonText(opts.stdout.trim());
  const results =
    isRecord(value) && isRecord(value.results) ? value.results : null;
  if (results === null) {
    return undefined;
  }
  const proven = new Map<string, readonly string[]>();
  for (const [index, path] of opts.paths.entries()) {
    const hits = results[String(index)];
    if (!Array.isArray(hits)) {
      return undefined;
    }
    proven.set(
      path,
      hits.flatMap((hit) => {
        const volume = opts.owned[Number(hit)];
        return volume === undefined ? [] : [volume.name];
      })
    );
  }
  return proven;
}
