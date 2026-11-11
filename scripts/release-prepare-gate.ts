#!/usr/bin/env bun
/**
 * Release-prepare gate (HACK-1424).
 *
 * `release-prepare.yml` used to run the whole CLI suite serially on one Linux
 * runner before semantic-release. On the v5 tree that step cannot pass: the
 * suite preflight needs a built config compiler the workflow never prepares,
 * and CI shards the full suite eight ways across macOS and Linux. This
 * gate replaces the serial suite with the same contract the candidate publish
 * gate already uses: the exact `main` head being released must have a
 * completed, fully successful CI push run. Nothing here mutates anything; a
 * failed check exits non-zero so semantic-release never runs.
 *
 * Trigger contract:
 * - `workflow_run` (CI completed on `main`): the run id and head SHA come from
 *   the event. The checked-out `main` head must still be that SHA; when `main`
 *   has moved on, this run stops and the newer push's own CI run gates it.
 * - `workflow_dispatch` (manual, usually `dry_run`): the latest successful CI
 *   push run for the checked-out `main` head is looked up.
 */
import {
  type Api,
  githubApi,
  pages,
  requireExactHeadCi,
} from "./prerelease-plan.ts";

const SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[1-9][0-9]*$/;

export interface ReleasePrepareTrigger {
  readonly event: "workflow_run" | "workflow_dispatch";
  /** The checked-out `main` head that semantic-release would tag. */
  readonly headSha: string;
  /** `workflow_run` only: the completed CI run that fired this workflow. */
  readonly ciRunId: string | null;
}

/**
 * Validate the trigger from the workflow environment. Every field is checked
 * because a workflow expression that renders empty must refuse, not pass.
 */
export function resolveReleasePrepareTrigger(
  env: Readonly<Record<string, string | undefined>>
): ReleasePrepareTrigger {
  const event = env.RELEASE_PREPARE_EVENT ?? "";
  const headSha = env.RELEASE_PREPARE_HEAD_SHA ?? "";
  if (!SHA.test(headSha)) {
    throw new Error("Release prepare needs the full checked-out main head SHA");
  }
  if (event === "workflow_dispatch") {
    return { event, headSha, ciRunId: null };
  }
  if (event !== "workflow_run") {
    throw new Error(`Unsupported release-prepare trigger: ${event || "none"}`);
  }
  const ciRunId = env.RELEASE_PREPARE_CI_RUN_ID ?? "";
  const ciHeadSha = env.RELEASE_PREPARE_CI_HEAD_SHA ?? "";
  const ciEvent = env.RELEASE_PREPARE_CI_EVENT ?? "";
  const ciConclusion = env.RELEASE_PREPARE_CI_CONCLUSION ?? "";
  if (!RUN_ID.test(ciRunId)) {
    throw new Error("Release prepare needs the completed CI run id");
  }
  if (ciEvent !== "push" || ciConclusion !== "success") {
    throw new Error(
      "Release prepare runs only after a successful CI push run on main"
    );
  }
  if (ciHeadSha !== headSha) {
    throw new Error(
      "main moved past the completed CI run; the newer push has its own CI run and release preparation"
    );
  }
  return { event, headSha, ciRunId };
}

/** Jobs that must each succeed on the exact-head CI run; `docker-e2e` and `test` are shard fan-ins. */
export async function selectStableCiRun({
  api,
  trigger,
}: {
  readonly api: Api;
  readonly trigger: ReleasePrepareTrigger;
}): Promise<{
  readonly run: Record<string, unknown>;
  readonly jobs: unknown[];
}> {
  let run: Record<string, unknown>;
  if (trigger.ciRunId !== null) {
    run = object(await api(`actions/runs/${trigger.ciRunId}`));
  } else {
    const runs = object(
      await api(
        `actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${trigger.headSha}&status=success&per_page=1`
      )
    );
    const [first] = array(runs.workflow_runs);
    if (first === undefined) {
      throw new Error(
        `No successful main push CI run exists for ${trigger.headSha}`
      );
    }
    run = object(first);
  }
  if (typeof run.id !== "number") {
    throw new Error("CI run has no id");
  }
  const jobs = await pages({
    api,
    path: `actions/runs/${run.id}/jobs`,
    field: "jobs",
  });
  return { run, jobs };
}

/** The stable gate is the candidate gate pointed at `main`. */
export function requireStableHeadCi({
  run,
  jobs,
  sourceRevision,
}: {
  readonly run: unknown;
  readonly jobs: unknown;
  readonly sourceRevision: string;
}) {
  requireExactHeadCi({ run, jobs, sourceRevision, branch: "main" });
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid GitHub object");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid GitHub array");
  }
  return value;
}

async function checkedOutHead(): Promise<string> {
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const text = (await new Response(child.stdout).text()).trim();
  if ((await child.exited) !== 0 || !SHA.test(text)) {
    throw new Error("Unable to read the checked-out main head");
  }
  return text;
}

async function main() {
  const trigger = resolveReleasePrepareTrigger({
    ...process.env,
    RELEASE_PREPARE_HEAD_SHA:
      process.env.RELEASE_PREPARE_HEAD_SHA ?? (await checkedOutHead()),
  });
  const { run, jobs } = await selectStableCiRun({ api: githubApi(), trigger });
  requireStableHeadCi({ run, jobs, sourceRevision: trigger.headSha });
  process.stdout.write(
    `Release prepare gate: CI run ${String(run.id)} succeeded in every job on main@${trigger.headSha}\n`
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}
