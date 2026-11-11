import { describe, expect, test } from "bun:test";
import { CI_JOBS } from "../scripts/prerelease-plan.ts";
import {
  requireStableHeadCi,
  resolveReleasePrepareTrigger,
  selectStableCiRun,
} from "../scripts/release-prepare-gate.ts";

const sha = "a".repeat(40);
const other = "b".repeat(40);

const workflowRunEnv = {
  RELEASE_PREPARE_EVENT: "workflow_run",
  RELEASE_PREPARE_HEAD_SHA: sha,
  RELEASE_PREPARE_CI_RUN_ID: "77",
  RELEASE_PREPARE_CI_HEAD_SHA: sha,
  RELEASE_PREPARE_CI_EVENT: "push",
  RELEASE_PREPARE_CI_CONCLUSION: "success",
};

const ciRun = {
  id: 77,
  head_sha: sha,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
  path: ".github/workflows/ci.yml",
};

const jobs = CI_JOBS.map((name) => ({
  name,
  head_sha: sha,
  status: "completed",
  conclusion: "success",
}));

describe("release-prepare gate (HACK-1424)", () => {
  test("accepts a completed successful CI push run on the checked-out head", () => {
    expect(resolveReleasePrepareTrigger(workflowRunEnv)).toEqual({
      event: "workflow_run",
      headSha: sha,
      ciRunId: "77",
    });
  });

  test("refuses when main moved past the completed CI run", () => {
    expect(() =>
      resolveReleasePrepareTrigger({
        ...workflowRunEnv,
        RELEASE_PREPARE_CI_HEAD_SHA: other,
      })
    ).toThrow("main moved past the completed CI run");
  });

  test("refuses a CI run that was not a successful push", () => {
    for (const patch of [
      { RELEASE_PREPARE_CI_EVENT: "pull_request" },
      { RELEASE_PREPARE_CI_EVENT: "" },
      { RELEASE_PREPARE_CI_CONCLUSION: "failure" },
      { RELEASE_PREPARE_CI_CONCLUSION: "cancelled" },
      { RELEASE_PREPARE_CI_CONCLUSION: "" },
    ]) {
      expect(() =>
        resolveReleasePrepareTrigger({ ...workflowRunEnv, ...patch })
      ).toThrow("only after a successful CI push run");
    }
  });

  test("refuses malformed or empty trigger fields", () => {
    expect(() =>
      resolveReleasePrepareTrigger({
        ...workflowRunEnv,
        RELEASE_PREPARE_HEAD_SHA: "abc",
      })
    ).toThrow("full checked-out main head SHA");
    expect(() =>
      resolveReleasePrepareTrigger({
        ...workflowRunEnv,
        RELEASE_PREPARE_CI_RUN_ID: "",
      })
    ).toThrow("completed CI run id");
    expect(() =>
      resolveReleasePrepareTrigger({
        ...workflowRunEnv,
        RELEASE_PREPARE_CI_RUN_ID: "0x77",
      })
    ).toThrow("completed CI run id");
    expect(() =>
      resolveReleasePrepareTrigger({
        ...workflowRunEnv,
        RELEASE_PREPARE_EVENT: "push",
      })
    ).toThrow("Unsupported release-prepare trigger: push");
    expect(() => resolveReleasePrepareTrigger({})).toThrow(
      "full checked-out main head SHA"
    );
  });

  test("a manual dispatch gates on the checked-out head only", () => {
    expect(
      resolveReleasePrepareTrigger({
        RELEASE_PREPARE_EVENT: "workflow_dispatch",
        RELEASE_PREPARE_HEAD_SHA: sha,
      })
    ).toEqual({ event: "workflow_dispatch", headSha: sha, ciRunId: null });
  });

  test("workflow_run reads the named run and its jobs", async () => {
    const calls: string[] = [];
    const api = async (path: string) => {
      calls.push(path);
      if (path === "actions/runs/77") {
        return ciRun;
      }
      if (path.startsWith("actions/runs/77/jobs")) {
        return { jobs };
      }
      throw new Error(`unexpected ${path}`);
    };
    const selected = await selectStableCiRun({
      api,
      trigger: { event: "workflow_run", headSha: sha, ciRunId: "77" },
    });
    expect(selected.run).toEqual(ciRun);
    expect(selected.jobs).toHaveLength(CI_JOBS.length);
    expect(calls[0]).toBe("actions/runs/77");
    requireStableHeadCi({
      run: selected.run,
      jobs: selected.jobs,
      sourceRevision: sha,
    });
  });

  test("a dispatch looks up the successful main push run for the head", async () => {
    const calls: string[] = [];
    const api = async (path: string) => {
      calls.push(path);
      if (path.startsWith("actions/workflows/ci.yml/runs?")) {
        return { workflow_runs: [ciRun] };
      }
      if (path.startsWith("actions/runs/77/jobs")) {
        return { jobs };
      }
      throw new Error(`unexpected ${path}`);
    };
    const selected = await selectStableCiRun({
      api,
      trigger: { event: "workflow_dispatch", headSha: sha, ciRunId: null },
    });
    expect(selected.run).toEqual(ciRun);
    expect(calls[0]).toBe(
      `actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&status=success&per_page=1`
    );
  });

  test("a dispatch without a successful run for the head refuses", async () => {
    const api = async (path: string) => {
      if (path.startsWith("actions/workflows/ci.yml/runs?")) {
        return { workflow_runs: [] };
      }
      throw new Error(`unexpected ${path}`);
    };
    await expect(
      selectStableCiRun({
        api,
        trigger: { event: "workflow_dispatch", headSha: sha, ciRunId: null },
      })
    ).rejects.toThrow(`No successful main push CI run exists for ${sha}`);
  });

  test("the stable gate requires main, the exact SHA and every job", () => {
    requireStableHeadCi({ run: ciRun, jobs, sourceRevision: sha });
    expect(() =>
      requireStableHeadCi({
        run: { ...ciRun, head_branch: "next" },
        jobs,
        sourceRevision: sha,
      })
    ).toThrow(
      "A successful main push CI run is required on the exact source SHA"
    );
    expect(() =>
      requireStableHeadCi({ run: ciRun, jobs, sourceRevision: other })
    ).toThrow("exact source SHA");
    expect(() =>
      requireStableHeadCi({
        run: ciRun,
        jobs: jobs.filter((job) => job.name !== "test shard 5/8"),
        sourceRevision: sha,
      })
    ).toThrow("Exact-head CI job did not succeed: test shard 5/8");
    expect(() =>
      requireStableHeadCi({
        run: ciRun,
        jobs: [
          ...jobs,
          { name: "test focus", status: "completed", conclusion: "skipped" },
        ],
        sourceRevision: sha,
      })
    ).toThrow("must succeed without skips");
  });
});
