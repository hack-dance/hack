import { isRecord } from "../lib/guards.ts";

const BIRTH =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
const ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/;
export type NativeFrontendIdentity = {
  readonly pid: number;
  readonly birth?: string;
};
type Observation = {
  readonly uid: number;
  readonly birth: string;
  readonly zombie: boolean;
};

export function isNativeFrontendBirth(value: unknown): value is string {
  return typeof value === "string" && BIRTH.test(value);
}

/** One bounded identity row, without arguments/environment. An unreadable row grants nothing. */
async function observe(pid: number): Promise<Observation | null> {
  try {
    const proc = Bun.spawn(
      ["/bin/ps", "-p", String(pid), "-o", "pid=,uid=,stat=,lstart="],
      {
        env: { LC_ALL: "C", TZ: "UTC0" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: 2000,
      }
    );
    const reader = proc.stdout.getReader();
    let output = "";
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      if (output.length + chunk.value.length > 1024) {
        proc.kill();
        await reader.cancel();
        await proc.exited;
        return null;
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    if ((await proc.exited) !== 0) {
      return null;
    }
    const match = ROW.exec(output.trim());
    const birth = match?.[4]?.replace(/\s+/g, " ");
    if (!match || Number(match[1]) !== pid || !isNativeFrontendBirth(birth)) {
      return null;
    }
    return {
      uid: Number(match[2]),
      birth,
      zombie: match[3]?.startsWith("Z") === true,
    };
  } catch {
    return null;
  }
}

/** macOS lstart is fixed at creation. Linux lstart can drift with clock corrections. */
export async function captureNativeFrontendBirth(): Promise<
  string | undefined
> {
  if (process.platform !== "darwin") {
    return undefined;
  }
  const row = await observe(process.pid);
  return row && row.uid === process.getuid?.() && !row.zombie
    ? row.birth
    : undefined;
}

/**
 * Read-only exit proof shared by down and frontend finalization. Legacy records
 * retain ESRCH-only behavior. A macOS birth mismatch proves only that the recorded
 * incarnation is gone; it never authorizes a signal to the replacement process.
 */
export async function nativeFrontendGone(
  identity: NativeFrontendIdentity,
  io: NativeFrontendExitIo = {}
): Promise<boolean> {
  return (await nativeFrontendExit(identity, io)) === "gone";
}

export type NativeFrontendExitIo = {
  readonly platform?: NodeJS.Platform;
  readonly absent?: (pid: number) => boolean;
  readonly observe?: (pid: number) => Promise<Observation | null>;
  /** ESRCH is still checked on every call; callers may throttle the ps read. */
  readonly inspectBirth?: boolean;
};

/**
 * The same proof, keeping an unreadable identity row apart from a live one:
 * `gone` is exit proof, `alive` is the recorded incarnation still running, and
 * `unknown` is a row that could not be read (for example, `ps` timing out under
 * load). Only `gone` grants anything.
 */
export async function nativeFrontendExit(
  identity: NativeFrontendIdentity,
  io: NativeFrontendExitIo = {}
): Promise<"gone" | "alive" | "unknown"> {
  const absent =
    io.absent ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return isRecord(error) && error.code === "ESRCH";
      }
    });
  if (absent(identity.pid)) {
    return "gone";
  }
  if (
    (io.platform ?? process.platform) !== "darwin" ||
    io.inspectBirth === false ||
    !isNativeFrontendBirth(identity.birth)
  ) {
    return "alive";
  }
  const row = await (io.observe ?? observe)(identity.pid);
  if (row === null) {
    return "unknown";
  }
  return row.birth !== identity.birth ||
    (row.uid === process.getuid?.() && row.zombie)
    ? "gone"
    : "alive";
}

/** Bounds of {@link nativeFrontendGoneSettled}. */
export const FRONTEND_EXIT_READS = 5;
export const FRONTEND_EXIT_READ_DELAY_MS = 500;

/**
 * Exit proof that one unreadable `ps` row does not turn into "still running"
 * (HACK-2372). An unknown read is retried, at most {@link FRONTEND_EXIT_READS}
 * reads in all; a read that shows the recorded incarnation alive ends the wait
 * at once. Still only `gone` grants anything.
 */
export async function nativeFrontendGoneSettled(
  identity: NativeFrontendIdentity,
  io: NativeFrontendExitIo & {
    readonly reads?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<boolean> {
  const reads = io.reads ?? FRONTEND_EXIT_READS;
  for (let read = 1; ; read++) {
    const exit = await nativeFrontendExit(identity, io);
    if (exit !== "unknown") {
      return exit === "gone";
    }
    if (read >= reads) {
      return false;
    }
    await (io.sleep ?? Bun.sleep)(FRONTEND_EXIT_READ_DELAY_MS);
  }
}
