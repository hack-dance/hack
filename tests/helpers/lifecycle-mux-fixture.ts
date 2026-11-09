import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A closed tmux transport stand-in. It starts the shipping wrapper/client, not
 * a second controller. Only test-owned session metadata and captured children exist.
 */
export async function writeLifecycleMuxFixture(root: string): Promise<string> {
  const path = join(root, "tmux");
  const source = `#!${process.execPath}
import { readFile, writeFile, appendFile, unlink } from "node:fs/promises";
// Like tmux, accept the client-level -u (force UTF-8) flag before the command.
const rawArgs=process.argv.slice(2);
let args=rawArgs[0]==="-u"?rawArgs.slice(1):rawArgs;
const file=process.env.HACK_TEST_MUX_STATE;
if (!file) process.exit(92);
await appendFile(file+".calls",JSON.stringify(rawArgs)+"\\n");
if(args.join(" ")==="start-server ; source-file -") {
 const source=await Bun.stdin.text();
 const words=source.match(${String.raw`/"(?:\\.|[^"\\])*"/g`});
 if(!words)process.exit(93);
 args=words.map(word=>JSON.parse(word.replaceAll(String.fromCharCode(92)+"$","$")));
}
const selected=(flag)=>args[args.indexOf(flag)+1];
let state=await readFile(file,"utf8").then(JSON.parse).catch(()=>null);
switch(args[0]) {
case "new-session":
 if(state) process.exit(91);
 state={name:selected("-s"),cwd:selected("-c"),token:"",windows:{}};
 for(let i=0;i<args.length;i++)if(args[i]==="-e"&&args[i+1]?.startsWith("HACK_LIFECYCLE_OWNER_TOKEN="))state.token=args[i+1].slice("HACK_LIFECYCLE_OWNER_TOKEN=".length);
 await writeFile(file,JSON.stringify(state)); break;
case "set-option":
 if(!state)process.exit(91);state.token=args.at(-1);await writeFile(file,JSON.stringify(state));break;
case "list-sessions":
 if(state)console.log([state.name,"0",state.cwd,Object.keys(state.windows).length,"1"].join("\\t"));break;
case "has-session":
 if(!state){console.error("can't find session: "+selected("-t").replace(/^=/,""));process.exit(1);}break;
case "show-options":
 if(!state)process.exit(91);console.log(state.token);break;
case "list-windows":
 if(!state)process.exit(91);for(const name of Object.keys(state.windows))console.log(name);break;
case "new-window": {
 if(!state)process.exit(91);
 const child=Bun.spawn(["/bin/sh","-c",args.at(-1)],{cwd:selected("-c"),detached:true,stdin:"ignore",stdout:"ignore",stderr:"ignore"});
 child.unref();const started=Bun.spawnSync(["/bin/ps","-o","lstart=","-p",String(child.pid)],{env:{LC_ALL:"C",TZ:"UTC"}}).stdout.toString().trim();state.windows[selected("-n")]={pid:child.pid,started};await writeFile(file,JSON.stringify(state));break;
}
case "list-panes": {
 if(!state)process.exit(91);const name=selected("-t").split(":").at(-1);if(state.windows[name])console.log(state.windows[name].pid);break;
}
case "send-keys": {
 if(!state)process.exit(91);const name=selected("-t").split(":").at(-1);const row=state.windows[name];if(row){try{process.kill(-row.pid,"SIGINT");}catch{}}break;
}
case "kill-session":
 if(!state)process.exit(91);for(const row of Object.values(state.windows)){try{process.kill(-row.pid,"SIGTERM");}catch{}}await unlink(file);break;
default:process.exit(93);
}
`;
  await writeFile(path, source, { flag: "wx", mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

/** A process's start time as the stand-in records it; null when it has exited. */
function leaderStartedAt(pid: number): string | null {
  const started = Bun.spawnSync(
    ["/bin/ps", "-o", "lstart=", "-p", String(pid)],
    {
      env: { LC_ALL: "C", TZ: "UTC" },
    }
  )
    .stdout.toString()
    .trim();
  return started === "" ? null : started;
}

/**
 * Whether a recorded group is still the window this fixture started. A live
 * leader must have the recorded start time. With no live leader, a group that
 * still exists keeps its id from being reused, so it can only be ours. A row
 * with no recorded start time proves nothing and is left alone.
 */
function stillOurGroup(row: {
  readonly pid: number;
  readonly started: string;
}): boolean {
  const started = leaderStartedAt(row.pid);
  return started === null || started === row.started;
}

function groupPresent(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

/** Time a stand-in window group gets to handle SIGTERM before SIGKILL. */
const WINDOW_GROUP_TERM_GRACE_MS = 2000;

/**
 * End the window groups the stand-in mux recorded in `stateFile`. Test cleanup
 * for a failed case only: a retained real start would leave them for `hack
 * down` recovery, and nothing would otherwise stop these captured children.
 * The file is rewritten as a whole, so an unreadable one names no groups yet.
 * A window that exited stays in the file, so its id may belong to someone else
 * by now: each signal first checks the group is still the recorded one.
 */
export async function endLifecycleMuxFixtureGroups(
  stateFile: string
): Promise<void> {
  type Row = { readonly pid?: unknown; readonly started?: unknown };
  let windows: Record<string, Row>;
  try {
    windows = (
      JSON.parse(await readFile(stateFile, "utf8")) as {
        readonly windows: Record<string, Row>;
      }
    ).windows;
  } catch {
    return;
  }
  const rows = Object.values(windows ?? {}).flatMap((row) =>
    typeof row.pid === "number" &&
    row.pid > 1 &&
    typeof row.started === "string" &&
    row.started !== ""
      ? [{ pid: row.pid, started: row.started }]
      : []
  );
  const signalAll = (signal: NodeJS.Signals) => {
    for (const row of rows) {
      if (!stillOurGroup(row)) {
        continue;
      }
      try {
        process.kill(-row.pid, signal);
      } catch (error) {
        // The group ended after the check. The others still get their signal.
        if ((error as { readonly code?: unknown }).code !== "ESRCH") {
          throw error;
        }
      }
    }
  };
  signalAll("SIGTERM");
  const deadline = performance.now() + WINDOW_GROUP_TERM_GRACE_MS;
  while (
    rows.some((row) => stillOurGroup(row) && groupPresent(row.pid)) &&
    performance.now() < deadline
  ) {
    await Bun.sleep(20);
  }
  signalAll("SIGKILL");
}
