import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import {
  type NativeDnsCommandRunner,
  runNativeDnsAttachedCommand,
} from "./native-domain-dns-host.ts";
import { type ExecResult, exec } from "./shell.ts";

const LABELS = ["sh.brew.dnsmasq", "homebrew.mxcl.dnsmasq"] as const;
const PLIST_DIRECTORY = "/Library/LaunchDaemons";
const MAX_OUTPUT = 64 * 1024;
const READY_ATTEMPTS = 20;
const READY_INTERVAL_MS = 250;
const READY_DEADLINE_MS = 5000;
const WHITESPACE = /\s/;
const LINE_BREAK = /\r?\n/;
const PID_LINE = /^pid = \d+$/;

interface PathMetadata {
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

interface LoadedJob {
  readonly label: (typeof LABELS)[number];
  readonly pid: number | null;
  readonly running: boolean;
}

/** Testing seams stay read-only until the returned restart callback is invoked. */
export interface NativeDnsLaunchdRestartOptions {
  readonly dnsmasqBinary: string;
  readonly mainConfigPath: string;
  readonly includeDir: string;
  readonly inspectedArgs: readonly string[];
  readonly runCommand?: NativeDnsCommandRunner;
  readonly runPrivileged?: NativeDnsCommandRunner;
  readonly statPath?: (path: string) => Promise<PathMetadata | null>;
}

async function defaultCommand(command: readonly string[]): Promise<ExecResult> {
  return await exec(command, { stdin: "ignore", timeoutMs: 3000 });
}

async function defaultPrivileged(
  command: readonly string[]
): Promise<ExecResult> {
  return await runNativeDnsAttachedCommand({ command });
}

async function defaultStatPath(path: string): Promise<PathMetadata | null> {
  try {
    const result = await lstat(path);
    return {
      uid: result.uid,
      mode: result.mode,
      nlink: result.nlink,
      isFile: result.isFile(),
      isDirectory: result.isDirectory(),
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function exact(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  );
}

function requiredOutput(result: ExecResult, action: string): string {
  if (
    result.exitCode !== 0 ||
    result.stdout.length > MAX_OUTPUT ||
    result.stderr.length > MAX_OUTPUT
  ) {
    const detail = result.stderr.trim().replaceAll("\n", " ").slice(0, 512);
    throw new Error(
      `${action} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`
    );
  }
  return result.stdout;
}

function scalar(lines: readonly string[], key: string): string {
  const prefix = `${key} = `;
  const matches = lines.filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) {
    throw new Error(`Native DNS launchd job has no unique ${key}`);
  }
  return matches[0]?.slice(prefix.length) ?? "";
}

function parseJob(opts: {
  readonly text: string;
  readonly label: LoadedJob["label"];
  readonly expectedArgs: readonly string[];
}): LoadedJob {
  if (opts.text.length > MAX_OUTPUT) {
    throw new Error("Native DNS launchd job output is oversized");
  }
  const rawLines = opts.text.split(LINE_BREAK);
  const lines = rawLines
    .filter((line) => line.startsWith("\t") && !line.startsWith("\t\t"))
    .map((line) => line.trim());
  if (rawLines[0] !== `system/${opts.label} = {`) {
    throw new Error("Native DNS launchd job has an unexpected identity");
  }
  const path = `${PLIST_DIRECTORY}/${opts.label}.plist`;
  if (
    scalar(lines, "path") !== path ||
    scalar(lines, "type") !== "LaunchDaemon" ||
    scalar(lines, "program") !== opts.expectedArgs[0]
  ) {
    throw new Error(
      "Native DNS launchd job is foreign to the inspected service"
    );
  }
  const argumentStarts = rawLines.flatMap((line, index) =>
    line === "\targuments = {" ? [index] : []
  );
  if (argumentStarts.length !== 1) {
    throw new Error("Native DNS launchd arguments are ambiguous");
  }
  const start = argumentStarts[0] ?? -1;
  const end = rawLines.indexOf("\t}", start + 1);
  const argumentLines = rawLines.slice(start + 1, end);
  if (
    end < 0 ||
    !argumentLines.every(
      (line) => line.startsWith("\t\t") && !line.startsWith("\t\t\t")
    ) ||
    !exact(
      argumentLines.map((line) => line.trim()),
      opts.expectedArgs
    )
  ) {
    throw new Error(
      "Native DNS launchd arguments differ from the inspected process"
    );
  }
  const running =
    scalar(lines, "state") === "running" &&
    scalar(lines, "job state") === "running";
  const pids = lines.filter((line) => PID_LINE.test(line));
  if (pids.length > 1) {
    throw new Error("Native DNS launchd job has ambiguous process IDs");
  }
  const pid =
    pids.length === 1 ? Number(pids[0]?.slice("pid = ".length)) : null;
  if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error("Native DNS launchd job has an invalid process ID");
  }
  return { label: opts.label, pid, running };
}

function parsePlist(opts: {
  readonly text: string;
  readonly label: LoadedJob["label"];
  readonly expectedArgs: readonly string[];
}): void {
  let value: unknown;
  try {
    value = JSON.parse(opts.text);
  } catch {
    throw new Error("Native DNS launchd plist is invalid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Native DNS launchd plist is invalid");
  }
  const record = value as Record<string, unknown>;
  const args = record.ProgramArguments;
  if (
    record.Label !== opts.label ||
    record.KeepAlive !== true ||
    record.RunAtLoad !== true ||
    !Array.isArray(args) ||
    !args.every((part: unknown) => typeof part === "string") ||
    !exact(args, opts.expectedArgs)
  ) {
    throw new Error(
      "Native DNS launchd plist differs from the inspected service"
    );
  }
}

async function inspectLoadedJobs(opts: {
  readonly expectedArgs: readonly string[];
  readonly runCommand: NativeDnsCommandRunner;
  readonly statPath: NonNullable<NativeDnsLaunchdRestartOptions["statPath"]>;
}): Promise<LoadedJob> {
  const loaded: LoadedJob[] = [];
  for (const label of LABELS) {
    const target = `system/${label}`;
    const printed = await opts.runCommand(["/bin/launchctl", "print", target]);
    if (
      printed.exitCode === 113 &&
      printed.stderr.includes(`Could not find service "${label}"`)
    ) {
      continue;
    }
    const output = requiredOutput(printed, `launchctl print ${target}`);
    const path = `${PLIST_DIRECTORY}/${label}.plist`;
    const metadata = await opts.statPath(path);
    const parent = await opts.statPath(dirname(path));
    if (
      !metadata?.isFile ||
      metadata.uid !== 0 ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o022) !== 0 ||
      !parent?.isDirectory ||
      parent.uid !== 0 ||
      (parent.mode & 0o022) !== 0
    ) {
      throw new Error(
        `Native DNS launchd plist is not a root-owned regular file: ${path}`
      );
    }
    const plist = await opts.runCommand([
      "/usr/bin/plutil",
      "-convert",
      "json",
      "-o",
      "-",
      path,
    ]);
    parsePlist({
      text: requiredOutput(plist, `plutil ${path}`),
      label,
      expectedArgs: opts.expectedArgs,
    });
    loaded.push(
      parseJob({ text: output, label, expectedArgs: opts.expectedArgs })
    );
  }
  if (loaded.length !== 1) {
    throw new Error(
      loaded.length === 0
        ? "No matching system dnsmasq launchd job is loaded"
        : "Multiple system dnsmasq launchd jobs are loaded"
    );
  }
  return loaded[0] as LoadedJob;
}

async function processMatches(opts: {
  readonly job: LoadedJob;
  readonly expectedArgs: readonly string[];
  readonly runCommand: NativeDnsCommandRunner;
}): Promise<boolean> {
  if (!opts.job.running || opts.job.pid === null) {
    return false;
  }
  const result = await opts.runCommand([
    "/bin/ps",
    "-ww",
    "-p",
    String(opts.job.pid),
    "-o",
    "command=",
  ]);
  if (result.exitCode !== 0) {
    return false;
  }
  if (result.stdout.length > MAX_OUTPUT || result.stderr.length > MAX_OUTPUT) {
    throw new Error("Native DNS process inspection output is oversized");
  }
  if (result.stdout.trim() !== opts.expectedArgs.join(" ")) {
    throw new Error("Native DNS launchd PID runs a foreign process");
  }
  return true;
}

/** Validate the exact loaded system job before DNS files are changed. */
export async function prepareNativeDnsLaunchdRestart(
  opts: NativeDnsLaunchdRestartOptions
): Promise<() => Promise<void>> {
  const expectedArgs = [
    opts.dnsmasqBinary,
    "--keep-in-foreground",
    "-C",
    opts.mainConfigPath,
    "-7",
    `${opts.includeDir},*.conf`,
  ];
  const supportedInputs =
    [opts.dnsmasqBinary, opts.mainConfigPath, opts.includeDir].every(
      (path) =>
        isAbsolute(path) && normalize(path) === path && !WHITESPACE.test(path)
    ) && exact(opts.inspectedArgs, expectedArgs);
  if (!supportedInputs) {
    throw new Error(
      "Inspected dnsmasq arguments do not match the supported system job"
    );
  }
  const runCommand = opts.runCommand ?? defaultCommand;
  const runPrivileged = opts.runPrivileged ?? defaultPrivileged;
  const statPath = opts.statPath ?? defaultStatPath;
  const inspect = async () =>
    await inspectLoadedJobs({ expectedArgs, runCommand, statPath });
  const prepared = await inspect();
  if (!(await processMatches({ job: prepared, expectedArgs, runCommand }))) {
    throw new Error(
      "Inspected dnsmasq launchd job is not running its declared process"
    );
  }
  let attempted = false;
  return async () => {
    const before = await inspect();
    if (before.label !== prepared.label) {
      throw new Error("Native DNS launchd job changed after preflight");
    }
    const beforeMatches = await processMatches({
      job: before,
      expectedArgs,
      runCommand,
    });
    if (!(beforeMatches || attempted)) {
      throw new Error(
        "Native DNS launchd job stopped before the first restart"
      );
    }
    attempted = true;
    const target = `system/${before.label}`;
    const kickstart = await runPrivileged([
      "sudo",
      "-n",
      "/bin/launchctl",
      "kickstart",
      "-k",
      target,
    ]);
    requiredOutput(kickstart, `launchctl kickstart ${target}`);
    const deadline = performance.now() + READY_DEADLINE_MS;
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
      if (performance.now() >= deadline) {
        break;
      }
      const after = await inspect();
      if (after.label !== before.label) {
        throw new Error("Native DNS launchd job changed during restart");
      }
      const ready = await processMatches({
        job: after,
        expectedArgs,
        runCommand,
      });
      if (ready && (!beforeMatches || after.pid !== before.pid)) {
        return;
      }
      await Bun.sleep(
        Math.max(0, Math.min(READY_INTERVAL_MS, deadline - performance.now()))
      );
    }
    throw new Error(
      "Native DNS launchd job did not become ready after kickstart"
    );
  };
}
