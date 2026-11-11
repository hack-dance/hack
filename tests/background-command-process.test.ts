import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cancelCommand } from "../src/lib/background-command/cancel.ts";
import {
  type EventEnvelope,
  journalPaths,
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
  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes(SUPERVISOR_MARKER)).length;
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
  const records = owned.splice(0);
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
  const proc = Bun.spawn(
    [
      process.execPath,
      LAUNCHER,
      JSON.stringify({ ...config, cwd: fixture.root }),
    ],
    {
      cwd: fixture.root,
      env: fixture.env,
      stdin: config.stdinFile ? Bun.file(config.stdinFile) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: config.linger === true,
    }
  );
  await track(proc.pid, config.linger === true);
  const reader = proc.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    text += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  if (!config.linger) {
    await proc.exited;
  }
  const envelope = JSON.parse(
    text.split("\n")[0] ?? "{}"
  ) as Launched["envelope"];
  let journal: LoadedJournal | null = null;
  if (envelope.ok && envelope.data) {
    journal = await loadJournal({
      commandId: envelope.data.commandId,
      root: fixture.store,
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
        childGroupSignalled: true,
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
