import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cancelCommand } from "../src/lib/background-command/cancel.ts";
import {
  GUEST_MARKER_ENV,
  GUEST_STOP_PROBE_ENV,
  GUEST_STOP_SCRIPT,
} from "../src/lib/background-command/container-stop.ts";
import {
  type CommandMeta,
  type EventEnvelope,
  journalPaths,
  OUTPUT_FILE_LIMIT_BYTES,
  readChild,
  readEvents,
  readOwner,
} from "../src/lib/background-command/journal.ts";
import {
  identityMatches,
  observeIdentities,
  type ProcessIdentity,
  readSessionId,
} from "../src/lib/background-command/platform.ts";
import {
  type LoadedJournal,
  loadJournal,
  type ProjectedEvent,
  readCommandEvents,
} from "../src/lib/background-command/reader.ts";
import { acceptCommand } from "../src/lib/background-command/store.ts";
import { limitOutputFileSize } from "../src/lib/background-command/supervisor.ts";

// ---------------------------------------------------------------------------
// HACK-2085: real detached supervisors and children, on this host's kernel.
//
// Each test has its own HOME and HACK_HOME under a temp root; Docker points at
// a dead socket and the daemon never autostarts. Every pid a test starts (the
// launcher, the supervisor and the child) is recorded with its birth time; the
// cleanup kills only those that still match pid and birth, then proves each is
// gone. Supervisor processes are counted before and after the file.
// ---------------------------------------------------------------------------

const LAUNCHER = resolve(
  import.meta.dir,
  "helpers/background-command-launcher.ts"
);
const SUPERVISOR_MARKER = "--internal-background-command-supervisor";
const TEST_TIMEOUT_MS = 60_000;

type Fixture = {
  readonly root: string;
  readonly hackHome: string;
  readonly store: string;
  readonly env: Record<string, string>;
};

let fixture: Fixture;
const owned: { identity: ProcessIdentity; group: boolean }[] = [];
let supervisorsBefore = 0;

async function countSupervisors(): Promise<number> {
  const result = Bun.spawnSync(["ps", "-eo", "args="], {
    env: { LC_ALL: "C", PATH: process.env.PATH ?? "" },
  });
  return (
    result.stdout
      .toString()
      .split("\n")
      // argv[1] of `bun index.ts <marker>` or argv[1] of a compiled `hack <marker>`.
      .filter((line) =>
        line.trim().split(" ").slice(1, 3).includes(SUPERVISOR_MARKER)
      ).length
  );
}

beforeAll(async () => {
  supervisorsBefore = await countSupervisors();
});

afterAll(async () => {
  // Host-wide count for the report only: other suites may run supervisors in
  // parallel. Each test proves its own recorded pids are gone in afterEach.
  const after = await countSupervisors();
  console.info(
    `[background-command-process] supervisor processes on this host before=${supervisorsBefore} after=${after}`
  );
});

beforeEach(async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-bg-proc-")));
  const hackHome = join(root, "hack-home");
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(hackHome, { recursive: true });
  fixture = {
    root,
    hackHome,
    store: join(hackHome, "commands"),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(root, "home"),
      HACK_HOME: hackHome,
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_STATE_HOME: join(root, "xdg-state"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
      HACK_GLOBAL_CONFIG_PATH: join(root, "hack.config.json"),
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
      HACK_NO_INTERACTIVE: "1",
      DOCKER_HOST: `unix://${join(root, "no-docker.sock")}`,
      LC_ALL: "C",
    },
  };
});

afterEach(async () => {
  const records = [...owned.splice(0), ...(await journalIdentities())];
  const snapshot = await observeIdentities(
    records.map((record) => record.identity.pid)
  );
  for (const record of records) {
    if (snapshot && identityMatches({ expected: record.identity, snapshot })) {
      try {
        process.kill(
          record.group ? -record.identity.pid : record.identity.pid,
          "SIGKILL"
        );
      } catch {
        // Already gone.
      }
    }
  }
  const deadline = Date.now() + 5000;
  for (;;) {
    const after = await observeIdentities(
      records.map((record) => record.identity.pid)
    );
    const alive = records.filter((record) =>
      after
        ? identityMatches({ expected: record.identity, snapshot: after })
        : true
    );
    if (alive.length === 0) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Test processes still alive: ${alive.map((record) => record.identity.pid).join(",")}`
      );
    }
    await Bun.sleep(50);
  }
  await rm(fixture.root, { recursive: true, force: true });
});

async function track(
  pid: number,
  group: boolean
): Promise<ProcessIdentity | null> {
  const snapshot = await observeIdentities([pid]);
  const row = snapshot?.get(pid);
  if (!row) {
    return null;
  }
  const identity = { pid, birth: row.birth };
  owned.push({ identity, group });
  return identity;
}

type LaunchConfig = {
  readonly argv: readonly string[];
  readonly requestKey?: string;
  readonly timeoutMs?: number;
  readonly stallAfterMs?: number;
  readonly capture?: "full" | "metadata";
  readonly redactValues?: readonly string[];
  readonly linger?: boolean;
  readonly stdinFile?: string;
  readonly extraEnv?: Record<string, string>;
  /** Overrides for the command's environment only (not the launcher's). */
  readonly childEnv?: Record<string, string>;
  /** Launcher environment keys to drop. */
  readonly withoutEnv?: readonly string[];
  /** Store root when it is not the fixture's HACK_HOME. */
  readonly store?: string;
};

type Launched = {
  readonly envelope: {
    ok: boolean;
    data?: { commandId: string; cursor: string; reused: boolean };
    error?: { code: string };
  };
  readonly launcherPid: number;
  readonly journal: LoadedJournal | null;
};

async function launch(config: LaunchConfig): Promise<Launched> {
  const configFile = join(fixture.root, `launch-${randomUUID()}.json`);
  const {
    extraEnv: _extraEnv,
    withoutEnv: _withoutEnv,
    store: _store,
    ...launcherConfig
  } = config;
  await writeFile(
    configFile,
    JSON.stringify({ ...launcherConfig, cwd: fixture.root })
  );
  const proc = Bun.spawn([process.execPath, LAUNCHER, `@${configFile}`], {
    cwd: fixture.root,
    env: Object.fromEntries(
      Object.entries({ ...fixture.env, ...config.extraEnv }).filter(
        ([key]) => !config.withoutEnv?.includes(key)
      )
    ),
    stdin: config.stdinFile ? Bun.file(config.stdinFile) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: config.linger === true,
  });
  await track(proc.pid, config.linger === true);
  // The launcher prints one pretty-printed envelope; read until it parses.
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let envelope: Launched["envelope"] | null = null;
  while (!envelope) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    text += decoder.decode(chunk.value, { stream: true });
    envelope = tryParseEnvelope(text);
  }
  reader.releaseLock();
  if (!config.linger) {
    await proc.exited;
  }
  envelope ??= { ok: false, error: { code: "E_NO_ENVELOPE" } };
  let journal: LoadedJournal | null = null;
  if (envelope.ok && envelope.data) {
    journal = await loadJournal({
      commandId: envelope.data.commandId,
      root: config.store ?? fixture.store,
    });
    const owner = await readOwner(journal.paths);
    if (owner) {
      owned.push({ identity: owner, group: false });
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const child = await readChild(journal.paths);
      if (child) {
        owned.push({ identity: child, group: true });
        break;
      }
      if (
        (await readEvents(journal.paths)).some(
          (event) => event.type === "command.ended"
        )
      ) {
        break;
      }
      await Bun.sleep(25);
    }
  }
  return { envelope, launcherPid: proc.pid, journal };
}

function tryParseEnvelope(text: string): Launched["envelope"] | null {
  try {
    return JSON.parse(text) as Launched["envelope"];
  } catch {
    return null;
  }
}

/**
 * Every supervisor and child any test in this fixture started, read from the
 * journals themselves: cleanup does not depend on the test reaching the point
 * where it recorded them.
 */
async function journalIdentities(): Promise<
  { identity: ProcessIdentity; group: boolean }[]
> {
  const found: { identity: ProcessIdentity; group: boolean }[] = [];
  const ids = await Array.fromAsync(
    new Bun.Glob("cmd_*").scan({ cwd: fixture.store, onlyFiles: false })
  ).catch(() => [] as string[]);
  for (const commandId of ids) {
    const paths = journalPaths({ root: fixture.store, commandId });
    const owner = await readOwner(paths).catch(() => null);
    const child = await readChild(paths).catch(() => null);
    if (owner) {
      found.push({ identity: owner, group: false });
    }
    if (child) {
      found.push({ identity: child, group: true });
    }
  }
  return found;
}

async function readUntilEnded(opts: {
  readonly journal: LoadedJournal;
  readonly after?: string;
  readonly deadlineMs?: number;
}): Promise<{
  events: ProjectedEvent[];
  outcome?: string;
  exitCode?: number | null;
  nextCursor: string;
}> {
  const events: ProjectedEvent[] = [];
  let after = opts.after;
  const deadline = Date.now() + (opts.deadlineMs ?? 30_000);
  for (;;) {
    const result = await readCommandEvents({
      journal: opts.journal,
      after,
      waitMs: 2000,
      maxBytes: 262_144,
    });
    events.push(...result.events);
    after = result.nextCursor;
    if (result.ended) {
      return {
        events,
        outcome: result.outcome,
        exitCode: result.exitCode,
        nextCursor: after,
      };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Command did not end: ${JSON.stringify(events.map((event) => event.type))}`
      );
    }
  }
}

function stdoutText(
  events: readonly ProjectedEvent[],
  stream = "stdout"
): string {
  return events
    .filter(
      (event) =>
        event.type === "command.output" && event.payload.stream === stream
    )
    .map((event) => String(event.payload.text ?? ""))
    .join("");
}

function endedPayload(events: readonly (ProjectedEvent | EventEnvelope)[]) {
  return events.find((event) => event.type === "command.ended")?.payload;
}

describe("background command processes", () => {
  test(
    "prints, sleeps, prints and exits 3; a new reader resumes from the cursor with no gap",
    async () => {
      const launched = await launch({
        argv: ["sh", "-c", "echo first; sleep 1.5; echo second; exit 3"],
      });
      expect(launched.envelope.ok).toBe(true);
      const journal = launched.journal as LoadedJournal;
      const owner = await readOwner(journal.paths);
      expect(owner?.newSession).toBe(true);
      // First reader: stop once the first line is visible ("killed" afterwards).
      let first = await readCommandEvents({
        journal,
        waitMs: 0,
        maxBytes: 32_768,
      });
      const deadline = Date.now() + 10_000;
      while (
        !stdoutText(first.events).includes("first") &&
        Date.now() < deadline
      ) {
        const more = await readCommandEvents({
          journal,
          after: first.nextCursor,
          waitMs: 500,
          maxBytes: 32_768,
        });
        first = { ...more, events: [...first.events, ...more.events] };
      }
      expect(stdoutText(first.events)).toBe("first\n");
      expect(first.ended).toBe(false);
      const rest = await readUntilEnded({ journal, after: first.nextCursor });
      const seqs = [...first.events, ...rest.events].map((event) => event.seq);
      expect(seqs).toEqual(seqs.map((_, index) => index + 1));
      expect(stdoutText([...first.events, ...rest.events])).toBe(
        "first\nsecond\n"
      );
      expect(rest.outcome).toBe("failed");
      expect(rest.exitCode).toBe(3);
      expect(rest.events.some((event) => event.type === "gap")).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  test(
    "after the supervisor is killed the child keeps running and its output keeps landing",
    async () => {
      const launched = await launch({
        argv: [
          "sh",
          "-c",
          "i=0; while [ $i -lt 40 ]; do echo tick $i; i=$((i+1)); sleep 0.1; done",
        ],
      });
      const journal = launched.journal as LoadedJournal;
      const owner = await readOwner(journal.paths);
      const child = await readChild(journal.paths);
      expect(owner && child).toBeTruthy();
      if (!(owner && child)) {
        return;
      }
      await Bun.sleep(500);
      process.kill(owner.pid, "SIGKILL");
      const sizeAtKill = (await stat(journal.paths.stdout)).size;
      await Bun.sleep(1000);
      const snapshot = await observeIdentities([child.pid, owner.pid]);
      expect(snapshot && identityMatches({ expected: child, snapshot })).toBe(
        true
      );
      expect(snapshot && identityMatches({ expected: owner, snapshot })).toBe(
        false
      );
      expect((await stat(journal.paths.stdout)).size).toBeGreaterThan(
        sizeAtKill
      );
      const read = await readUntilEnded({ journal });
      expect(stdoutText(read.events)).toContain("tick 39\n");
      expect(read.outcome).toBe("unknown");
      expect(endedPayload(read.events)?.reason).toBe("supervisor_lost");
      expect(
        read.events.filter((event) => event.type === "command.ended")
      ).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  test(
    "the supervisor and child survive the death of the launching session",
    async () => {
      const launched = await launch({
        argv: ["sh", "-c", "sleep 1.5; echo survived"],
        linger: true,
      });
      const journal = launched.journal as LoadedJournal;
      const launcherSession = await readSessionId(launched.launcherPid);
      const owner = await readOwner(journal.paths);
      expect(owner?.sessionId).not.toBe(launcherSession);
      // Kill every process in the launcher's session (its group leader is the launcher).
      process.kill(-launched.launcherPid, "SIGKILL");
      const read = await readUntilEnded({ journal });
      expect(read.outcome).toBe("succeeded");
      expect(stdoutText(read.events)).toBe("survived\n");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "cancel stops a running command and says what it confirmed",
    async () => {
      const launched = await launch({
        argv: ["sh", "-c", "echo started; sleep 30"],
      });
      const journal = launched.journal as LoadedJournal;
      const result = await cancelCommand({ journal, root: fixture.store });
      expect(result.outcome).toBe("cancelled");
      expect(result.confirmed).toMatchObject({
        supervisorSignalled: true,
        // The live supervisor stops the group itself (members first).
        childGroupSignalled: false,
        childExited: true,
        containerProcess: "not_confirmed",
      });
      const events = await readEvents(journal.paths);
      expect(
        events.filter((event) => event.type === "command.ended")
      ).toHaveLength(1);
      expect(endedPayload(events)?.outcome).toBe("cancelled");
      const audit = await readFile(join(fixture.store, "audit.log"), "utf8");
      expect(audit).toContain('"event":"start"');
      expect(audit).toContain('"event":"cancel"');
      expect(audit).toContain('"event":"end"');
      expect(audit).not.toContain("sleep 30");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "cancel refuses a reused pid: a live process with another birth is never signalled",
    async () => {
      const bystander = Bun.spawn(["sleep", "30"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      });
      await track(bystander.pid, true);
      const dead = Bun.spawn(["true"]);
      await dead.exited;
      const accepted = await acceptCommand({
        root: fixture.store,
        input: {
          requestKey: null,
          operation: "exec",
          backend: "compose",
          projectId: "fixture",
          projectRoot: fixture.root,
          instanceId: "@base",
          service: "api",
          argv: ["sleep", "30"],
          workdir: null,
          caller: "test",
          timeoutMs: 60_000,
          stallAfterMs: 0,
          capture: "full",
          retentionMs: 60_000,
          liveOutput: "available",
          stallDetection: "available",
          redaction: { values: 0 },
          fingerprintInputs: {},
        },
      });
      const paths = accepted.paths;
      await writeFile(
        paths.owner,
        JSON.stringify({
          pid: dead.pid,
          birth: "Thu Jan  1 00:00:00 1970",
          processGroupId: dead.pid,
          sessionId: null,
          newSession: false,
        }),
        { mode: 0o600 }
      );
      await writeFile(
        paths.child,
        JSON.stringify({
          pid: bystander.pid,
          birth: "Thu Jan  1 00:00:00 1970",
          processGroupId: bystander.pid,
        }),
        { mode: 0o600 }
      );
      const journal = await loadJournal({
        commandId: accepted.meta.commandId,
        root: fixture.store,
      });
      const result = await cancelCommand({ journal, root: fixture.store });
      expect(result.refused).toContain("child");
      expect(result.confirmed.childGroupSignalled).toBe(false);
      expect(() => process.kill(bystander.pid, 0)).not.toThrow();
      expect(bystander.exitCode).toBeNull();
    },
    TEST_TIMEOUT_MS
  );

  test(
    "cancel leaves a live supervisor that is finishing to finish, and force-stops one that is not",
    async () => {
      // A stand-in supervisor that ignores SIGTERM, as a real one in its end
      // path (descendant cleanup, container removal) keeps running past it.
      const accept = () =>
        acceptCommand({
          root: fixture.store,
          input: {
            requestKey: null,
            operation: "run",
            backend: "compose",
            projectId: "fixture",
            projectRoot: fixture.root,
            instanceId: "@base",
            service: "api",
            argv: ["true"],
            workdir: null,
            caller: "test",
            timeoutMs: 60_000,
            stallAfterMs: 0,
            capture: "full",
            retentionMs: 60_000,
            liveOutput: "available",
            stallDetection: "available",
            redaction: { values: 0 },
            fingerprintInputs: {},
          },
        });
      const standIn = async () => {
        const proc = Bun.spawn(["sh", "-c", 'trap "" TERM; sleep 30'], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
        });
        const identity = await track(proc.pid, true);
        expect(identity).not.toBeNull();
        return { proc, identity: identity as ProcessIdentity };
      };
      const writeOwner = async (
        path: string,
        identity: ProcessIdentity
      ): Promise<void> => {
        await writeFile(
          path,
          JSON.stringify({
            ...identity,
            processGroupId: identity.pid,
            sessionId: null,
            newSession: true,
          }),
          { mode: 0o600 }
        );
      };

      const finishing = await accept();
      const busy = await standIn();
      await writeOwner(finishing.paths.owner, busy.identity);
      await writeFile(finishing.paths.stopping, "finishing", { mode: 0o600 });
      const left = await cancelCommand({
        journal: await loadJournal({
          commandId: finishing.meta.commandId,
          root: fixture.store,
        }),
        root: fixture.store,
        waitMs: 300,
      });
      expect(left.outcome).toBe("cancelling");
      expect(busy.proc.exitCode).toBeNull();
      expect(() => process.kill(busy.identity.pid, 0)).not.toThrow();
      const notEnded = await readEvents(finishing.paths);
      expect(notEnded.some((event) => event.type === "command.ended")).toBe(
        false
      );

      const stuck = await accept();
      const silent = await standIn();
      await writeOwner(stuck.paths.owner, silent.identity);
      const forced = await cancelCommand({
        journal: await loadJournal({
          commandId: stuck.meta.commandId,
          root: fixture.store,
        }),
        root: fixture.store,
        waitMs: 300,
      });
      await silent.proc.exited;
      expect(silent.proc.signalCode).toBe("SIGKILL");
      // No spawn marker: nothing was started, so with the supervisor gone the
      // canceller records the end itself.
      expect(forced.outcome).toBe("cancelled");
      expect(endedPayload(await readEvents(stuck.paths))?.reason).toBe(
        "supervisor_unresponsive"
      );
    },
    TEST_TIMEOUT_MS
  );

  test.if(process.platform === "linux")(
    "the in-container stop script ends marked processes and fails closed when it cannot enumerate",
    async () => {
      // Run on this host's /proc as a stand-in for a container's.
      const marker = randomUUID().replaceAll("-", "");
      const marked = Bun.spawn(["sleep", "30"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
        env: { ...fixture.env, [GUEST_MARKER_ENV]: marker },
      });
      await track(marked.pid, true);
      const runScript = (opts: { marker: string; path: string }) =>
        Bun.spawn(["sh", "-c", GUEST_STOP_SCRIPT, "stop", opts.marker], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          env: {
            PATH: opts.path,
            [GUEST_STOP_PROBE_ENV.split("=")[0] as string]: "1",
          },
        }).exited;
      expect(
        await runScript({ marker, path: fixture.env.PATH as string })
      ).toBe(0);
      await marked.exited;
      expect(marked.signalCode).not.toBeNull();

      // Without `tr` the scan would see nothing: it must not read as "none left".
      const bin = join(fixture.root, "bin-without-tr");
      await mkdir(bin);
      for (const tool of ["sh", "sleep"]) {
        const found = Bun.which(tool);
        expect(found).not.toBeNull();
        await symlink(found as string, join(bin, tool));
      }
      expect(await runScript({ marker: "nomatch", path: bin })).not.toBe(0);
    },
    TEST_TIMEOUT_MS
  );

  test(
    "the supervisor never loads the project's bunfig.toml or BUN_OPTIONS (from the command's or the launcher's environment); the command still gets its cwd and env",
    async () => {
      // A preload that records only when the supervisor loads it (the test's
      // own launcher runs in the same directory and may load it too).
      const marker = join(fixture.root, "supervisor-preloaded");
      const preload = join(fixture.root, "preload.js");
      await writeFile(
        preload,
        `if (process.argv.includes(${JSON.stringify(SUPERVISOR_MARKER)})) require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`
      );
      await writeFile(
        join(fixture.root, "bunfig.toml"),
        `preload = [${JSON.stringify(preload)}]\n`
      );
      const launched = await launch({
        argv: ["sh", "-c", 'pwd; echo "opts=$BUN_OPTIONS"'],
        childEnv: { BUN_OPTIONS: `--preload ${preload}` },
        // As if a project .env had put it into the launcher's own process.
        extraEnv: { BUN_OPTIONS: `--preload ${preload}` },
      });
      const read = await readUntilEnded({
        journal: launched.journal as LoadedJournal,
      });
      expect(read.outcome).toBe("succeeded");
      expect(stdoutText(read.events)).toBe(
        `${fixture.root}\nopts=--preload ${preload}\n`
      );
      expect(await lstat(marker).catch(() => null)).toBeNull();
    },
    TEST_TIMEOUT_MS
  );

  test(
    "full capture with more distinct redaction values than the limit is refused before anything starts",
    async () => {
      const refused = await launch({
        argv: ["true"],
        redactValues: Array.from(
          { length: 1025 },
          (_, index) => `value-${index}-padded`
        ),
      });
      expect(refused.envelope.ok).toBe(false);
      expect(refused.envelope.error?.code).toBe("E_USAGE");
      // Refused before acceptance: no journal (here, not even the store).
      const entries = await Array.fromAsync(
        new Bun.Glob("cmd_*").scan({ cwd: fixture.store, onlyFiles: false })
      ).catch(() => []);
      expect(entries).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );

  test(
    "stdin is closed: a command that reads it ends at once; input from a file is refused before anything starts",
    async () => {
      const launched = await launch({
        argv: ["sh", "-c", 'read line; echo "read-status=$?"'],
      });
      const read = await readUntilEnded({
        journal: launched.journal as LoadedJournal,
        deadlineMs: 10_000,
      });
      expect(stdoutText(read.events)).toBe("read-status=1\n");
      expect(read.outcome).toBe("succeeded");

      const input = join(fixture.root, "input.txt");
      await writeFile(input, "data the command would never see\n");
      const refused = await launch({ argv: ["cat"], stdinFile: input });
      expect(refused.envelope.ok).toBe(false);
      expect(refused.envelope.error?.code).toBe("E_USAGE");
      const entries = await Array.fromAsync(
        new Bun.Glob("cmd_*").scan({ cwd: fixture.store, onlyFiles: false })
      );
      expect(entries).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  test(
    "the timeout stops the command group and records timed_out",
    async () => {
      const launched = await launch({
        argv: ["sh", "-c", "sleep 30"],
        timeoutMs: 1000,
      });
      const read = await readUntilEnded({
        journal: launched.journal as LoadedJournal,
      });
      expect(read.outcome).toBe("timed_out");
      expect(endedPayload(read.events)?.containerProcess).toBe("not_confirmed");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "a stop also ends descendants that ignore SIGTERM, by verified identity",
    async () => {
      const launched = await launch({
        argv: [
          "sh",
          "-c",
          "trap '' TERM; (trap '' TERM; exec sleep 30) & echo $! > grandchild.pid; wait",
        ],
        timeoutMs: 1000,
      });
      const pidFile = join(fixture.root, "grandchild.pid");
      const deadlinePid = Date.now() + 5000;
      while (!(await Bun.file(pidFile).exists()) && Date.now() < deadlinePid) {
        await Bun.sleep(25);
      }
      const grandchild = Number((await readFile(pidFile, "utf8")).trim());
      expect(grandchild).toBeGreaterThan(1);
      await track(grandchild, false);
      const read = await readUntilEnded({
        journal: launched.journal as LoadedJournal,
      });
      expect(read.outcome).toBe("timed_out");
      const deadline = Date.now() + 5000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        alive =
          (await observeIdentities([grandchild]))?.has(grandchild) ?? true;
        if (alive) {
          await Bun.sleep(100);
        }
      }
      expect(alive).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  test(
    "after the leader exits on SIGTERM, a remembered descendant that ignores it is killed",
    async () => {
      const launched = await launch({
        argv: [
          "sh",
          "-c",
          "(trap '' TERM; exec sleep 30) & echo $! > grandchild.pid; wait",
        ],
        timeoutMs: 1000,
      });
      const pidFile = join(fixture.root, "grandchild.pid");
      const deadlinePid = Date.now() + 5000;
      while (!(await Bun.file(pidFile).exists()) && Date.now() < deadlinePid) {
        await Bun.sleep(25);
      }
      const grandchild = Number((await readFile(pidFile, "utf8")).trim());
      // Registered for cleanup even if an assertion below fails.
      await track(grandchild, false);
      const read = await readUntilEnded({
        journal: launched.journal as LoadedJournal,
      });
      expect(read.outcome).toBe("timed_out");
      const deadline = Date.now() + 5000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        alive =
          (await observeIdentities([grandchild]))?.has(grandchild) ?? true;
        if (alive) {
          await Bun.sleep(100);
        }
      }
      expect(alive).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  test(
    "cancel: the leader exits on SIGTERM and a descendant that ignores it is still stopped",
    async () => {
      const launched = await launch({
        argv: [
          "sh",
          "-c",
          "(trap '' TERM; exec sleep 30) & echo $! > cancel-grandchild.pid; wait",
        ],
      });
      const pidFile = join(fixture.root, "cancel-grandchild.pid");
      const deadlinePid = Date.now() + 5000;
      while (!(await Bun.file(pidFile).exists()) && Date.now() < deadlinePid) {
        await Bun.sleep(25);
      }
      const grandchild = Number((await readFile(pidFile, "utf8")).trim());
      await track(grandchild, false);
      const journal = launched.journal as LoadedJournal;
      const result = await cancelCommand({ journal, root: fixture.store });
      expect(result.outcome).toBe("cancelled");
      const deadline = Date.now() + 5000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        alive =
          (await observeIdentities([grandchild]))?.has(grandchild) ?? true;
        if (alive) {
          await Bun.sleep(100);
        }
      }
      expect(alive).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  test(
    "redaction values of 70 KiB each reach the supervisor without an environment string",
    async () => {
      const first = `A${"x".repeat(70 * 1024)}`;
      const second = `B${"y".repeat(70 * 1024)}`;
      const launched = await launch({
        argv: ["sh", "-c", `printf '%s' "$SECRET_ONE"; echo; echo done`],
        redactValues: [first, second],
        extraEnv: { SECRET_ONE: first },
      });
      expect(launched.envelope.ok).toBe(true);
      const read = await readUntilEnded({
        journal: launched.journal as LoadedJournal,
      });
      const text = stdoutText(read.events);
      expect(text).not.toContain("xxxxxxxxxxxxxxxx");
      expect(text.endsWith("done\n")).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  test(
    "the file-size wrapper stops a writer at exactly the output file limit",
    async () => {
      // The wrapper alone, with no supervisor cutting the file back: the
      // kernel limit is the only thing between the writer and the disk.
      const path = join(fixture.root, "capped");
      const fd = openSync(path, "a", 0o600);
      try {
        const argv = limitOutputFileSize(
          { capture: "full", backend: "compose" } as CommandMeta,
          [
            "head",
            "-c",
            String(OUTPUT_FILE_LIMIT_BYTES + 1024 * 1024),
            "/dev/zero",
          ]
        );
        const proc = Bun.spawn(argv, {
          stdin: "ignore",
          stdout: fd,
          stderr: "ignore",
        });
        // head reports EFBIG ("File too large") and fails.
        expect(await proc.exited).not.toBe(0);
      } finally {
        closeSync(fd);
      }
      expect((await stat(path)).size).toBe(OUTPUT_FILE_LIMIT_BYTES);
    },
    TEST_TIMEOUT_MS
  );

  test(
    "a burst between two polls cannot grow an output file past the kernel file-size limit",
    async () => {
      // 100 MiB in one burst. Capture stops at 8 MiB and the supervisor cuts
      // the file back; whether the writer also hits the 64 MiB kernel limit
      // (and fails with EFBIG) depends on how fast it writes relative to the
      // 200 ms poll, so only the bound is asserted here. The wrapper test
      // above proves the limit itself.
      const launched = await launch({
        argv: ["sh", "-c", "head -c 104857600 /dev/zero"],
      });
      const journal = launched.journal as LoadedJournal;
      const read = await readUntilEnded({ journal });
      expect(read.outcome === "failed" || read.outcome === "succeeded").toBe(
        true
      );
      expect((await stat(journal.paths.stdout)).size).toBeLessThanOrEqual(
        OUTPUT_FILE_LIMIT_BYTES
      );
    },
    TEST_TIMEOUT_MS
  );

  test(
    "the supervisor finds its journal when the Compose env changes HOME",
    async () => {
      // No HACK_HOME: the store is under the launcher's HOME. The project's
      // env sets another HOME for the command; the supervisor must still use
      // the launcher's store root.
      const store = join(fixture.env.HOME as string, ".hack", "commands");
      const launched = await launch({
        argv: ["sh", "-c", 'echo "home=$HOME"'],
        withoutEnv: ["HACK_HOME"],
        childEnv: { HOME: join(fixture.root, "project-home") },
        store,
      });
      expect(launched.envelope.ok).toBe(true);
      const read = await readUntilEnded({
        journal: launched.journal as LoadedJournal,
      });
      expect(read.outcome).toBe("succeeded");
      expect(stdoutText(read.events)).toBe(
        `home=${join(fixture.root, "project-home")}\n`
      );
    },
    TEST_TIMEOUT_MS
  );

  test(
    "reaching the capture limit stops capture but the command keeps running to its end",
    async () => {
      const launched = await launch({
        argv: [
          "sh",
          "-c",
          "head -c 9437184 /dev/zero | tr '\\0' a; sleep 0.5; echo done-after-limit > done.txt",
        ],
      });
      const journal = launched.journal as LoadedJournal;
      const read = await readUntilEnded({ journal });
      expect(read.outcome).toBe("succeeded");
      expect(
        read.events.some((event) => event.type === "command.output_truncated")
      ).toBe(true);
      expect(endedPayload(read.events)?.truncated).toBe(true);
      expect(await readFile(join(fixture.root, "done.txt"), "utf8")).toBe(
        "done-after-limit\n"
      );
      expect((await stat(journal.paths.stdout)).size).toBeLessThanOrEqual(
        8 * 1024 * 1024
      );
    },
    TEST_TIMEOUT_MS
  );

  test(
    "a resolved value split across two writes is redacted before it is announced or stored",
    async () => {
      const secret = "s3cr3t-value-1234";
      const launched = await launch({
        argv: [
          "sh",
          "-c",
          'printf "token=s3cr3t-"; sleep 1.2; printf "value-1234 end\\n"',
        ],
        redactValues: [secret],
      });
      const journal = launched.journal as LoadedJournal;
      const read = await readUntilEnded({ journal });
      const text = stdoutText(read.events);
      expect(text).toBe(`token=${"*".repeat(secret.length)} end\n`);
      expect(await readFile(journal.paths.stdout, "utf8")).not.toContain(
        secret
      );
      expect(await readFile(journal.paths.meta, "utf8")).not.toContain(secret);
      expect(await readFile(journal.paths.events, "utf8")).not.toContain(
        secret
      );
    },
    TEST_TIMEOUT_MS
  );

  test(
    "a quiet period is reported as an advisory stall and then resumed",
    async () => {
      const launched = await launch({
        argv: ["sh", "-c", "echo a; sleep 2.5; echo b"],
        stallAfterMs: 1000,
      });
      const read = await readUntilEnded({
        journal: launched.journal as LoadedJournal,
      });
      const types = read.events.map((event) => event.type);
      expect(types).toContain("command.stalled");
      expect(types.indexOf("command.resumed")).toBeGreaterThan(
        types.indexOf("command.stalled")
      );
      const stalled = read.events.find(
        (event) => event.type === "command.stalled"
      );
      expect(Number(stalled?.payload.idleMs)).toBeGreaterThanOrEqual(1000);
      expect(read.outcome).toBe("succeeded");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "metadata capture stores no output",
    async () => {
      const launched = await launch({
        argv: ["sh", "-c", "echo hidden"],
        capture: "metadata",
      });
      const journal = launched.journal as LoadedJournal;
      const read = await readUntilEnded({ journal });
      expect(read.events.some((event) => event.type === "command.output")).toBe(
        false
      );
      expect(endedPayload(read.events)?.suppressed).toBe(true);
      expect(await lstat(journal.paths.stdout).catch(() => null)).toBeNull();
    },
    TEST_TIMEOUT_MS
  );

  test(
    "a retried start with the same request key runs the command once",
    async () => {
      const argv = ["sh", "-c", "echo ran >> runs.txt"];
      const first = await launch({ argv, requestKey: "retry-1" });
      await readUntilEnded({ journal: first.journal as LoadedJournal });
      const second = await launch({ argv, requestKey: "retry-1" });
      expect(second.envelope.data?.reused).toBe(true);
      expect(second.envelope.data?.commandId).toBe(
        first.envelope.data?.commandId as string
      );
      expect(await readFile(join(fixture.root, "runs.txt"), "utf8")).toBe(
        "ran\n"
      );
      const conflict = await launch({
        argv: ["sh", "-c", "echo other"],
        requestKey: "retry-1",
      });
      expect(conflict.envelope.error?.code).toBe("E_REQUEST_CONFLICT");
      expect(
        journalPaths({
          root: fixture.store,
          commandId: first.envelope.data?.commandId as string,
        }).dir
      ).toContain(fixture.hackHome);
    },
    TEST_TIMEOUT_MS
  );
});
