import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertPinnedBun, bunTestBannerPattern } from "./lib/pinned-bun.ts";

/** Expected findings, not a claim that the requested product guarantees pass. */
export const replayManifest = [
  { id: "P1", property: "SingleRunner", actual: "VIOLATION" },
  { id: "P2", property: "CancelQuiescent", actual: "VIOLATION" },
  { id: "P3", property: "RetryIdempotent", actual: "VIOLATION" },
  { id: "P4", property: "ClaimedTerminal", actual: "VIOLATION" },
  { id: "P5", property: "CancelWins", actual: "PASS" },
] as const;

export type Replay = (typeof replayManifest)[number];
const repoRoot = resolve(import.meta.dir, "..");
const testFile = "tests/supervisor-formal-replay.test.ts";
const runnerFile = "src/control-plane/extensions/supervisor/runner.ts";
const modeVariable = "HACK_SUPERVISOR_STRICT_REPLAY";

export function replayMarker(opts: {
  readonly replay: Replay;
  readonly outcome: "PASS" | "VIOLATION";
}): string {
  return `SUPERVISOR_REPLAY:${opts.replay.id}:${opts.replay.property}:${opts.outcome}`;
}

type StrictReplayOptions = {
  readonly replay: Replay;
  readonly expected: "PASS" | "VIOLATION";
  readonly root?: string;
};

/** Only an exact named oracle result and the corresponding single-test exit count. */
export async function runStrictReplay(
  opts: StrictReplayOptions
): Promise<void> {
  const bunVersion = await assertPinnedBun();
  const dataRoot = await mkdtemp(join(tmpdir(), "hack-supervisor-data-"));
  try {
    await runReplayProcess({ ...opts, bunVersion, dataRoot });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function runReplayProcess(
  opts: StrictReplayOptions & {
    readonly bunVersion: string;
    readonly dataRoot: string;
  }
): Promise<void> {
  const proc = Bun.spawn(
    [process.execPath, "test", `./${testFile}`, "--timeout", "10000"],
    {
      cwd: opts.root ?? repoRoot,
      env: {
        ...process.env,
        [modeVariable]: opts.replay.id,
        HACK_SUPERVISOR_REPLAY_DATA: opts.dataRoot,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, 15_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const observed = observedReplayOutcome({
      replay: opts.replay,
      bunVersion: opts.bunVersion,
      exitCode,
      timedOut,
      stdout,
      stderr,
    });
    if (observed === opts.expected) {
      return;
    }
    // Scratch runs test temporary controls, so only actual code can contradict a record.
    if (observed !== undefined && opts.root === undefined) {
      throw new Error(
        recordedResultChangedMessage({ replay: opts.replay, observed })
      );
    }
    throw new Error(
      `${opts.replay.id} ${opts.replay.property}: rejected replay evidence (exit=${exitCode}, timeout=${timedOut}); expected ${opts.expected}`
    );
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  }
}

type ReplayOutcome = "PASS" | "VIOLATION";

/**
 * One complete, named result of a strict replay, or undefined for anything else:
 * setup errors, unrelated failures and timeouts are never evidence of an outcome.
 */
export function observedReplayOutcome(opts: {
  readonly replay: Replay;
  readonly bunVersion: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}): ReplayOutcome | undefined {
  const [banner, marker, ...extra] = opts.stdout.trim().split("\n");
  if (
    opts.timedOut ||
    extra.length !== 0 ||
    !new RegExp(`^${bunTestBannerPattern(opts.bunVersion)}$`).test(
      banner ?? ""
    ) ||
    /unhandled|error between tests|timed out/i.test(opts.stderr)
  ) {
    return;
  }
  const passed =
    opts.exitCode === 0 &&
    marker === replayMarker({ replay: opts.replay, outcome: "PASS" }) &&
    /\b1 pass\s+0 fail\b/.test(opts.stderr);
  if (passed) {
    return "PASS";
  }
  const violated =
    opts.exitCode === 1 &&
    marker === replayMarker({ replay: opts.replay, outcome: "VIOLATION" }) &&
    /\b0 pass\s+1 fail\b/.test(opts.stderr) &&
    opts.stderr.includes(
      `PropertyViolation: Requested property violated: ${opts.replay.property}`
    );
  return violated ? "VIOLATION" : undefined;
}

/** What a contributor sees when product behavior no longer matches the manifest. */
export function recordedResultChangedMessage(opts: {
  readonly replay: Replay;
  readonly observed: ReplayOutcome;
}): string {
  const { id, property } = opts.replay;
  const change =
    opts.observed === "PASS"
      ? `Recorded finding no longer holds: ${id} ${property} now passes against the actual code.`
      : `Recorded pass no longer holds: ${id} ${property} is now violated by the actual code.`;
  const intent =
    opts.observed === "PASS"
      ? "If your change fixed this on purpose, record the fix"
      : "If this is a regression, fix the code. If the guarantee changed on purpose, record it";
  return [
    change,
    `${intent}: set ${id} to actual "${opts.observed}" in replayManifest (scripts/check-supervisor-replays.ts), then update the ${id} TLA+ model, its expectation in scripts/lib/tla-checks.ts and its row in specs/fv/COVERAGE.md, and run bun run check:tla.`,
  ].join("\n");
}

type Replacement = { readonly before: string; readonly after: string };
const admissionAnchor = "  const command = opts.command ?? meta.command;";
const terminalAdmissionCondition =
  '["completed", "failed", "cancelled"].includes(meta.status)';
const terminalWrite = `      await opts.jobStore.updateJobStatus({
        jobId: opts.jobId,
        status: input.status,
      });`;
const memoization = `    if (terminalWrite) {
      return terminalWrite;
    }
`;

/** Bounded reference controls only; these are never applied to product files. */
function referenceControl(replay: Replay): readonly Replacement[] {
  switch (replay.id) {
    case "P1":
      return [
        admissionControl(
          'meta.status === "starting" || meta.status === "running"'
        ),
      ];
    case "P2":
      return [
        admissionControl(terminalAdmissionCondition),
        {
          before:
            '      await finish({ status: "cancelled" });\n      return true;',
          after:
            '      await finish({ status: "cancelled" });\n      await proc.exited;\n      return true;',
        },
      ];
    case "P3":
      return [admissionControl(terminalAdmissionCondition)];
    case "P4":
      return [
        {
          before: terminalWrite,
          after: `      try {
${terminalWrite}
      } catch {
${terminalWrite}
      }`,
        },
      ];
    case "P5":
      return [];
    default:
      throw new Error("Unknown replay");
  }
}

function admissionControl(condition: string): Replacement {
  return {
    before: admissionAnchor,
    after: `  if (${condition}) {
    return { jobId: opts.jobId, status: meta.status, exitCode: 0 };
  }

${admissionAnchor}`,
  };
}

function replaceExactlyOnce(source: string, edit: Replacement): string {
  if (source.split(edit.before).length !== 2) {
    throw new Error("Replay control anchor drift: expected exactly one match");
  }
  return source.replace(edit.before, edit.after);
}

function applyEdits(source: string, edits: readonly Replacement[]): string {
  let result = source;
  for (const edit of edits) {
    result = replaceExactlyOnce(result, edit);
  }
  return result;
}

async function checkActual(label: string): Promise<void> {
  for (const replay of replayManifest) {
    await runStrictReplay({ replay, expected: replay.actual });
    process.stdout.write(
      `${label} ${replay.id} ${replay.property}: ${replay.actual}\n`
    );
  }
}

/** Extra implementation evidence; this is not a sixth formal property. */
async function checkStartupPersistence(): Promise<void> {
  const bunVersion = await assertPinnedBun();
  const dataRoot = await mkdtemp(
    join(tmpdir(), "hack-supervisor-startup-data-")
  );
  try {
    const proc = Bun.spawn(
      [
        process.execPath,
        "test",
        "./tests/supervisor-startup-replay.test.ts",
        "--timeout",
        "10000",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HACK_SUPERVISOR_REPLAY_DATA: dataRoot,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      if (
        exitCode !== 0 ||
        !new RegExp(`^${bunTestBannerPattern(bunVersion)}\\n$`).test(stdout) ||
        !/\b2 pass\s+0 fail\b/.test(stderr)
      ) {
        throw new Error(
          "Startup persistence characterization failed; run bun test ./tests/supervisor-startup-replay.test.ts for the reason"
        );
      }
      process.stdout.write(
        "characterization startup persistence (running status, job.started): BUG REPRODUCED\n"
      );
    } finally {
      clearTimeout(timer);
      if (proc.exitCode === null) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await checkActual("actual");
  await checkStartupPersistence();
  const scratch = await mkdtemp(join(tmpdir(), "hack-supervisor-controls-"));
  try {
    await cp(join(repoRoot, "src"), join(scratch, "src"), { recursive: true });
    await mkdir(join(scratch, "tests"));
    await mkdir(join(scratch, "scripts/lib"), { recursive: true });
    await cp(join(repoRoot, testFile), join(scratch, testFile));
    await cp(
      import.meta.path,
      join(scratch, "scripts/check-supervisor-replays.ts")
    );
    await cp(
      join(repoRoot, "scripts/lib/pinned-bun.ts"),
      join(scratch, "scripts/lib/pinned-bun.ts")
    );
    await symlink(
      join(repoRoot, "node_modules"),
      join(scratch, "node_modules")
    );
    const runnerPath = join(scratch, runnerFile);
    const actual = await Bun.file(runnerPath).text();
    for (const replay of replayManifest) {
      const edits = referenceControl(replay);
      const reference = applyEdits(actual, edits);
      if (edits.length > 0) {
        await Bun.write(runnerPath, reference);
        await runStrictReplay({ replay, expected: "PASS", root: scratch });
        process.stdout.write(
          `scratch reference ${replay.id} ${replay.property}: PASS\n`
        );
      }
      // P2 keeps terminal admission protection; only early acknowledgement is mutated.
      const removedControls = replay.id === "P2" ? edits.slice(1) : edits;
      const mutation =
        replay.id === "P5"
          ? [{ before: memoization, after: "" }]
          : removedControls
              .toReversed()
              .map((edit) => ({ before: edit.after, after: edit.before }));
      await Bun.write(runnerPath, applyEdits(reference, mutation));
      await runStrictReplay({ replay, expected: "VIOLATION", root: scratch });
      process.stdout.write(
        `scratch mutation ${replay.id} ${replay.property}: VIOLATION\n`
      );
      await Bun.write(runnerPath, actual);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await checkActual("restored actual");
}

if (import.meta.main) {
  await main();
}
