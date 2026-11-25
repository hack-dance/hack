/**
 * Processes of this user that belong to a native home (HACK-2524).
 *
 * A home's run is held only by processes started for that home: its frontend,
 * graph owner, relays, publishers, VM provider and Caddy. Each names the home in its
 * command line (`--candidate-root <home>`, the provider's state paths, the HTTPS
 * owner's configuration path) or runs with its working directory inside it. So no
 * such process means nothing holds the run's sockets, VM or published ports.
 *
 * A listing that cannot be read or parsed refuses; it never reads as empty. Each
 * listing must also show this very process (its pid in `ps`, its working directory
 * in `lsof`), so a run that failed or returned nothing refuses too. A home
 * moved and started again from its new path has processes that name the new path
 * only: this scan cannot see them (the residual of the gone-home release).
 */
import { ClosedCliError } from "../lib/cli-result.ts";

export type NativeHomeProcess = {
  readonly pid: number;
  readonly why: "command" | "cwd";
};

type Run = (
  argv: readonly string[]
) => Promise<{ readonly code: number; readonly stdout: string }>;

const LISTING_TIMEOUT_MS = 10_000;
const PS_ROW = /^\s*(\d+)\s+(.*)$/;
const BEFORE_PATH = /[\s="':]/;
const AFTER_PATH = /[\s/"':]/;

function scanRefused(): Error {
  return new ClosedCliError(
    "The processes of the recorded native home could not be listed, so its run cannot be proven gone; nothing was released. Retry once ps and lsof can list this user's processes."
  );
}

async function run(argv: readonly string[]) {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), LISTING_TIMEOUT_MS);
  try {
    const stdout = await new Response(child.stdout).text();
    return { code: await child.exited, stdout };
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `text` names `home` as a whole path (or a path inside it). */
function namesHome(text: string, home: string): boolean {
  for (let at = text.indexOf(home); at >= 0; at = text.indexOf(home, at + 1)) {
    const before = at === 0 ? " " : (text[at - 1] ?? " ");
    const after = text[at + home.length] ?? " ";
    if (BEFORE_PATH.test(before) && AFTER_PATH.test(after)) {
      return true;
    }
  }
  return false;
}

/** Processes whose command line names `home` (`ps`). */
async function byCommand(exec: Run, home: string, self: number) {
  const ps = await exec([
    "/bin/ps",
    "-A",
    "-ww",
    "-o",
    "pid=",
    "-o",
    "command=",
  ]).catch(() => undefined);
  if (!ps || ps.code !== 0 || ps.stdout.trim() === "") {
    throw scanRefused();
  }
  const pids: number[] = [];
  let sawSelf = false;
  for (const line of ps.stdout.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const match = PS_ROW.exec(line);
    if (!match) {
      throw scanRefused();
    }
    const pid = Number(match[1]);
    if (pid === self) {
      sawSelf = true;
    } else if (namesHome(match[2] ?? "", home)) {
      pids.push(pid);
    }
  }
  if (!sawSelf) {
    throw scanRefused();
  }
  return pids;
}

/** Processes of this user working inside `home` (`lsof`, cwd only). */
async function byDirectory(exec: Run, home: string, self: number) {
  // lsof exits 1 when some process could not be read; its readable rows still count.
  const lsof = await exec([
    "lsof",
    "-nP",
    "-a",
    "-d",
    "cwd",
    "-Fpn",
    "-u",
    String(process.getuid?.() ?? ""),
  ]).catch(() => undefined);
  if (!lsof || (lsof.code !== 0 && lsof.code !== 1)) {
    throw scanRefused();
  }
  const pids: number[] = [];
  let pid: number | undefined;
  let sawSelf = false;
  for (const line of lsof.stdout.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      continue;
    }
    const cwd = line.startsWith("n") ? line.slice(1) : undefined;
    if (cwd === undefined || pid === undefined) {
      continue;
    }
    if (pid === self) {
      sawSelf = true;
    } else if (cwd === home || cwd.startsWith(`${home}/`)) {
      pids.push(pid);
    }
  }
  // lsof exits 1 both for "some process unreadable" and for a failed run: only a
  // listing that shows this process's own working directory counts.
  if (!sawSelf) {
    throw scanRefused();
  }
  return pids;
}

export async function nativeHomeProcesses(
  home: string,
  opts: { readonly run?: Run; readonly self?: number } = {}
): Promise<readonly NativeHomeProcess[]> {
  const exec = opts.run ?? run;
  const self = opts.self ?? process.pid;
  const found = new Map<number, NativeHomeProcess["why"]>();
  for (const pid of await byCommand(exec, home, self)) {
    found.set(pid, "command");
  }
  for (const pid of await byDirectory(exec, home, self)) {
    if (!found.has(pid)) {
      found.set(pid, "cwd");
    }
  }
  return [...found].map(([pid, why]) => ({ pid, why }));
}
