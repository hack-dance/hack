#!/usr/bin/env bun
import { appendFile, lstat, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  NATIVE_STORAGE_TOOL_FILE,
  NATIVE_STORAGE_TOOL_MANIFEST,
  type NativeStorageToolManifest,
  nativeStorageToolManifest,
  parseNativeStorageToolManifest,
} from "../src/backends/native-authored-storage-tool.ts";
import { nativeCandidateMcpPayload } from "../src/mcp/candidate-payload.ts";
import { buildPrereleaseManager } from "./build-prerelease-manager.ts";
import {
  BOOTSTRAP_ASSET,
  INSTALLER_SUMS,
  MANAGER_ASSET,
  renderBootstrap,
} from "./installer/bootstrap.ts";
import { digest, VERSION } from "./installer/integrity.ts";

export const PRERELEASE_ENVIRONMENT = "v5-prerelease";
/**
 * Top-level files in the order `scripts/build-native-candidate.sh` checksums them
 * for a versioned build. `SHA256SUMS` is compared byte for byte, so order matters.
 */
export const PRERELEASE_PAYLOAD = [
  "hack-native",
  "hack-relay-guest",
  NATIVE_STORAGE_TOOL_FILE,
  NATIVE_STORAGE_TOOL_MANIFEST,
  "hack-cli",
  "hack-v5",
  "provider-pins.json",
  "README.md",
  "prerelease.json",
] as const;
export const CONFIG_COMPILER_PAYLOAD = [
  "hack-config-compiler",
  "hack.project.schema.json",
  "hack.local.schema.json",
] as const;
/**
 * Exact modes the bundle builder sets and the installer reproduces. The storage
 * witness is a guest-only ELF that runtime admission requires to be owner
 * executable and not group/other writable; its manifest is private data.
 */
export const PAYLOAD_MODES: Readonly<Record<string, number>> = {
  [NATIVE_STORAGE_TOOL_FILE]: 0o500,
  [NATIVE_STORAGE_TOOL_MANIFEST]: 0o600,
  "hack-config-compiler": 0o755,
  "hack.project.schema.json": 0o600,
  "hack.local.schema.json": 0o600,
};
/** The only packaged and installable candidate platform. */
export const PRERELEASE_PLATFORM = "darwin-arm64";
/** GitHub heading anchor of the consolidated support list in the prerelease guide. */
export const PRERELEASE_SUPPORT_ANCHOR = "supported-platforms-and-capabilities";
/**
 * The unreleased stable line that published candidates precede: candidates are
 * `${PRERELEASE_BASE}-next.N`. Semver orders `X.Y.Z-next.N` below `X.Y.Z`, so
 * once `vX.Y.Z` ships stable, raise this to the next unreleased v5 line (for
 * example `5.1.0`) in a reviewed change; numbering restarts at `next.1`. The
 * publish gate refuses a line that a stable release already reached.
 */
export const PRERELEASE_BASE = "5.0.0";
const BASE = /^5\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const REVISION = /^[0-9a-f]{40}$/;
const STABLE_TAG = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;

export function prereleaseMetadata({
  version,
  sourceRevision,
  base = PRERELEASE_BASE,
}: {
  readonly version: string;
  readonly sourceRevision: string;
  readonly base?: string;
}) {
  if (!BASE.test(base)) {
    throw new Error("Candidate base must be a stable 5.MINOR.PATCH version");
  }
  if (!(version.startsWith(`${base}-next.`) && VERSION.test(version))) {
    throw new Error(
      `Version must be ${base}-next.N with a positive integer and no leading zeros`
    );
  }
  if (!REVISION.test(sourceRevision) || sourceRevision.length !== 40) {
    throw new Error(
      "Source revision must be a full lowercase 40-character commit SHA"
    );
  }
  return {
    schema: "hack.prerelease/v1",
    version,
    tag: `v${version}`,
    source_revision: sourceRevision,
    platform: PRERELEASE_PLATFORM,
  } as const;
}

export function createPrereleasePlan({
  version,
  sourceRevision,
  ref,
  eventName,
  channel,
  publish = "false",
  base = PRERELEASE_BASE,
}: {
  readonly version: string;
  readonly sourceRevision: string;
  readonly ref: string;
  readonly eventName: string;
  readonly channel: string;
  readonly publish?: string;
  readonly base?: string;
}) {
  const metadata = prereleaseMetadata({ version, sourceRevision, base });
  if (
    channel !== "prerelease" ||
    ref !== "refs/heads/next" ||
    eventName !== "workflow_dispatch"
  ) {
    throw new Error(
      "Prereleases require an explicit prerelease dispatch from refs/heads/next"
    );
  }
  if (publish !== "false" && publish !== "true") {
    throw new Error("Publish must be explicitly true or false");
  }
  return {
    ...metadata,
    base,
    archive: `hack-${version}-${PRERELEASE_PLATFORM}-native.tar.gz`,
    publish: publish === "true",
    environment: PRERELEASE_ENVIRONMENT,
    assets: [
      `hack-${version}-${PRERELEASE_PLATFORM}-native.tar.gz`,
      "prerelease.json",
      "SHA256SUMS",
      MANAGER_ASSET,
      BOOTSTRAP_ASSET,
      INSTALLER_SUMS,
    ],
  };
}

export type PrereleasePlan = ReturnType<typeof createPrereleasePlan>;

/**
 * Release notes for a published candidate. The support link is pinned to the
 * candidate's own immutable tag, so later guide edits cannot change what the
 * published notes describe.
 */
export function prereleaseNotes({
  tag,
  source_revision: sourceRevision,
}: Pick<PrereleasePlan, "tag" | "source_revision">) {
  return [
    `Native macOS ARM64 candidate from ${sourceRevision}. Requires explicit opt-in; stable installation is unchanged.`,
    `Supported platform, unsupported platforms and capability limits: https://github.com/hack-dance/hack/blob/${tag}/docs/guides/prereleases.md#${PRERELEASE_SUPPORT_ANCHOR}`,
  ].join("\n\n");
}

export function stableReleaseVersion({
  channel,
  tag,
  packageVersion,
}: {
  readonly channel: string;
  readonly tag: string;
  readonly packageVersion: string;
}) {
  if (
    channel !== "stable" ||
    !STABLE_TAG.test(tag) ||
    tag.trim() !== tag ||
    tag !== `v${packageVersion}`
  ) {
    throw new Error(
      "Stable releases require a stable vX.Y.Z tag matching package.json"
    );
  }
  return packageVersion;
}

/** A name alone can auto-create an unprotected environment. Verify actual protection. */
export function requireReviewerProtection(value: unknown): number {
  const environment = object(value);
  const rules = array(environment.protection_rules);
  const protectedReview = rules.some((value) => {
    const rule = object(value);
    return (
      rule.type === "required_reviewers" &&
      array(rule.reviewers).some((value) => {
        const entry = object(value);
        const reviewer = object(entry.reviewer);
        return (
          (entry.type === "User" || entry.type === "Team") &&
          typeof reviewer.id === "number" &&
          Number.isSafeInteger(reviewer.id) &&
          reviewer.id > 0
        );
      })
    );
  });
  if (
    environment.name !== PRERELEASE_ENVIRONMENT ||
    typeof environment.id !== "number" ||
    !Number.isSafeInteger(environment.id) ||
    environment.id <= 0 ||
    environment.can_admins_bypass !== false ||
    !protectedReview
  ) {
    throw new Error(
      "v5-prerelease must have required reviewers and administrator bypass disabled"
    );
  }
  return environment.id;
}

export function requireHumanApproval({
  reviews,
  environmentId,
}: {
  readonly reviews: unknown;
  readonly environmentId: number;
}) {
  const relevant = array(reviews)
    .map(object)
    .filter((review) =>
      array(review.environments).some(
        (value) => object(value).id === environmentId
      )
    );
  const approved = relevant.some((review) => {
    const user = object(review.user);
    return (
      review.state === "approved" &&
      user.type === "User" &&
      typeof user.id === "number" &&
      Number.isSafeInteger(user.id) &&
      user.id > 0
    );
  });
  if (!approved || relevant.some((review) => review.state === "rejected")) {
    throw new Error(
      "This workflow run needs a recorded human approval for v5-prerelease"
    );
  }
}

/** Jobs that must each succeed on the exact-head CI run; `docker-e2e` and `test` are shard fan-ins. */
export const CI_JOBS = [
  "Runtime state models",
  "Candidate core (ubuntu-latest)",
  "Candidate core (macos-latest)",
  "secret-scan",
  "runtime-images",
  "docker-e2e shard 1/4",
  "docker-e2e shard 2/4",
  "docker-e2e shard 3/4",
  "docker-e2e shard 4/4",
  "docker-e2e",
  "test shard 1/8",
  "test shard 2/8",
  "test shard 3/8",
  "test shard 4/8",
  "test shard 5/8",
  "test shard 6/8",
  "test shard 7/8",
  "test shard 8/8",
  "test",
  "linux-process-lifetime",
] as const;

/** Candidate release qualification also requires every compiler architecture. */
export const PRERELEASE_CI_JOBS = [
  ...CI_JOBS,
  "Config compiler (ubuntu-latest)",
  "Config compiler (macos-latest)",
  "Config compiler (ubuntu-24.04-arm)",
  "Config compiler (macos-15-intel)",
] as const;

/** Markers are executed steps of the existing fan-in, not inferred from a run's color. */
export function ciEvidence(jobs: unknown) {
  const fanins = array(jobs)
    .map(object)
    .filter((job) => job.name === "test");
  const steps =
    fanins.length === 1 ? array(fanins[0]?.steps ?? []).map(object) : [];
  const selections = steps.filter(
    (step) =>
      step.name === "selection_mode=full" ||
      step.name === "selection_mode=selected"
  );
  const certificates = steps.filter(
    (step) =>
      step.name === "ci_evidence=release-full" ||
      step.name === "ci_evidence=scoped"
  );
  const selection = selections.length === 1 ? selections[0] : undefined;
  const certificate = certificates.length === 1 ? certificates[0] : undefined;
  return {
    full: selection?.name === "selection_mode=full",
    scoped: certificate?.name === "ci_evidence=scoped",
    releaseFull: certificate?.name === "ci_evidence=release-full",
    complete: [selection, certificate].every(
      (step) => step?.status === "completed" && step.conclusion === "success"
    ),
  };
}

export function requireExactHeadCi({
  run,
  jobs,
  sourceRevision,
  branch = "next",
}: {
  readonly run: unknown;
  readonly jobs: unknown;
  readonly sourceRevision: string;
  /** Main retains its push-only gate; next also accepts explicit full dispatches. */
  readonly branch?: "next" | "main";
}) {
  const ci = object(run);
  if (
    ci.head_sha !== sourceRevision ||
    ci.head_branch !== branch ||
    !(
      ci.event === "push" ||
      (branch === "next" && ci.event === "workflow_dispatch")
    ) ||
    ci.status !== "completed" ||
    ci.conclusion !== "success" ||
    ci.path !== ".github/workflows/ci.yml"
  ) {
    throw new Error(
      `A successful ${branch} ${branch === "main" ? "push " : ""}CI run is required on the exact source SHA`
    );
  }
  if (branch === "next") {
    const evidence = ciEvidence(jobs);
    if (!(evidence.full && evidence.releaseFull && evidence.complete)) {
      throw new Error(
        "Exact-head CI requires successful selection_mode=full and ci_evidence=release-full steps"
      );
    }
    if (
      typeof ci.check_suite_id !== "number" ||
      !Number.isSafeInteger(ci.check_suite_id) ||
      ci.check_suite_id < 1
    ) {
      throw new Error("Exact-head release CI requires its check suite id");
    }
  }
  const completed = array(jobs).map(object);
  for (const name of branch === "main" ? CI_JOBS : PRERELEASE_CI_JOBS) {
    if (
      !completed.some(
        (job) =>
          job.name === name &&
          job.head_sha === sourceRevision &&
          job.status === "completed" &&
          job.conclusion === "success"
      )
    ) {
      throw new Error(`Exact-head CI job did not succeed: ${name}`);
    }
  }
  if (
    completed.some(
      (job) => job.status !== "completed" || job.conclusion !== "success"
    )
  ) {
    throw new Error(
      "Every job in the exact-head CI run must succeed without skips"
    );
  }
}

export type Api = (path: string, allowMissing?: boolean) => Promise<unknown>;

function missingFullCi(
  sourceRevision: string,
  reason: string,
  pushRunId?: number
): Error {
  const pushRecovery = pushRunId
    ? ` Wait for the scoped push run ${pushRunId} at this commit to succeed, or rerun it with: gh run rerun ${pushRunId} . An older full run cannot supersede this running, failed or cancelled scoped run. A new full dispatch may supersede it once the dispatch succeeds.`
    : "";
  return new Error(
    `${reason}.${pushRecovery} A release-full CI run is required at next@${sourceRevision}; a green subset is insufficient. Freeze next at this SHA, run: gh workflow run ci.yml --ref next -f full=true ; wait for success, then retry the prerelease plan.`
  );
}

/** The newest release-full attempt wins; cancelled/failed attempts never expose an older green. */
async function currentCiRuns(opts: {
  readonly api: Api;
  readonly sourceRevision: string;
}) {
  const candidates = (
    await pages({
      api: opts.api,
      path: `actions/workflows/ci.yml/runs?branch=next&head_sha=${opts.sourceRevision}`,
      field: "workflow_runs",
    })
  ).map(object);
  const runs: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    if (candidate.event !== "push" && candidate.event !== "workflow_dispatch") {
      continue;
    }
    if (
      typeof candidate.id !== "number" ||
      !Number.isSafeInteger(candidate.id) ||
      candidate.id < 1
    ) {
      throw missingFullCi(
        opts.sourceRevision,
        "CI history has an invalid run id"
      );
    }
    const run = object(await opts.api(`actions/runs/${candidate.id}`));
    if (
      run.id !== candidate.id ||
      run.head_sha !== opts.sourceRevision ||
      run.head_branch !== "next" ||
      run.event !== candidate.event ||
      run.path !== ".github/workflows/ci.yml" ||
      typeof run.updated_at !== "string" ||
      !Number.isFinite(Date.parse(run.updated_at))
    ) {
      throw missingFullCi(
        opts.sourceRevision,
        "CI history has invalid run identity or activity time"
      );
    }
    runs.push(run);
  }
  // A rerun is fresh CI activity even when its original run was created earlier.
  runs.sort(
    (left, right) =>
      Date.parse(String(right.updated_at)) - Date.parse(String(left.updated_at))
  );
  return runs;
}

export async function selectPrereleaseCiRun(opts: {
  readonly api: Api;
  readonly sourceRevision: string;
}) {
  const runs = await currentCiRuns(opts);
  for (const run of runs) {
    const attempt = run.run_attempt;
    if (
      typeof attempt !== "number" ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1
    ) {
      throw missingFullCi(
        opts.sourceRevision,
        "CI history has no valid latest attempt"
      );
    }
    const jobs = await pages({
      api: opts.api,
      path: `actions/runs/${String(run.id)}/attempts/${attempt}/jobs`,
      field: "jobs",
    });
    const evidence = ciEvidence(jobs);
    if (evidence.releaseFull) {
      requireExactHeadCi({ run, jobs, sourceRevision: opts.sourceRevision });
      const latest = object(await opts.api(`actions/runs/${String(run.id)}`));
      if (
        latest.run_attempt !== attempt ||
        latest.status !== "completed" ||
        latest.conclusion !== "success"
      ) {
        throw missingFullCi(
          opts.sourceRevision,
          "The selected full CI attempt changed during verification"
        );
      }
      return { run, jobs };
    }
    if (
      !evidence.scoped ||
      run.status !== "completed" ||
      run.conclusion !== "success"
    ) {
      throw missingFullCi(
        opts.sourceRevision,
        "The newest CI attempt has incomplete release evidence",
        evidence.scoped && run.event === "push" ? Number(run.id) : undefined
      );
    }
  }
  throw missingFullCi(
    opts.sourceRevision,
    "No successful release-full attempt exists (only scoped or unmarked CI evidence)"
  );
}

/** Read-only plan gate, also repeated immediately before publication. */
export async function verifyPrereleaseCi(opts: {
  readonly api: Api;
  readonly sourceRevision: string;
}) {
  const branch = object(await opts.api("branches/next"));
  if (
    branch.protected !== true ||
    object(branch.commit).sha !== opts.sourceRevision
  ) {
    throw new Error("Source SHA must still be the protected next head");
  }
  const { run, jobs } = await selectPrereleaseCiRun(opts);
  await requireBranchChecks({
    api: opts.api,
    sourceRevision: opts.sourceRevision,
    branch,
    ciRun: run,
    ciJobs: jobs,
  });
  return { run, jobs, branch };
}

/** Rechecked after environment approval, immediately before any release mutation. */
export async function verifyPublishGate({
  plan,
  api,
  runId,
  approved,
}: {
  readonly plan: PrereleasePlan;
  readonly api: Api;
  readonly runId: string;
  readonly approved: boolean;
}) {
  await verifyPrereleaseCi({ api, sourceRevision: plan.source_revision });
  const environmentId = requireReviewerProtection(
    await api(`environments/${PRERELEASE_ENVIRONMENT}`)
  );
  if (
    (await api(`git/ref/tags/${plan.tag}`, true)) !== null ||
    (await api(`releases/tags/${plan.tag}`, true)) !== null
  ) {
    throw new Error("Refusing to replace an existing tag or release");
  }
  await requireUnreleasedCandidateLine({ api, base: plan.base });
  if (approved) {
    if (!/^[1-9][0-9]*$/.test(runId)) {
      throw new Error("Publishing needs the current workflow run id");
    }
    requireHumanApproval({
      reviews: await api(`actions/runs/${runId}/approvals`),
      environmentId,
    });
  }
}

/**
 * `BASE-next.N` sorts below stable `vBASE` and every later stable release, so
 * an installed stable would look newer than the candidate. Refuse publication
 * once a stable release reached the candidate line; the fix is to raise
 * `PRERELEASE_BASE`, never to reuse the line. A missing latest release (404)
 * means no stable release exists; a malformed one refuses.
 */
export async function requireUnreleasedCandidateLine({
  api,
  base,
}: {
  readonly api: Api;
  readonly base: string;
}) {
  if (
    (await api(`git/ref/tags/v${base}`, true)) !== null ||
    (await api(`releases/tags/v${base}`, true)) !== null
  ) {
    throw new Error(
      `Stable v${base} already exists; raise PRERELEASE_BASE to the next unreleased line`
    );
  }
  const latest = await api("releases/latest", true);
  if (latest === null) {
    return;
  }
  const tag = object(latest).tag_name;
  if (typeof tag !== "string" || !STABLE_TAG.test(tag)) {
    throw new Error("Latest stable release must have a vX.Y.Z tag");
  }
  if (compareStableVersions(tag.slice(1), base) >= 0) {
    throw new Error(
      `Candidate line ${base} does not sort above the latest stable release ${tag}; raise PRERELEASE_BASE`
    );
  }
}

/** Compare validated `X.Y.Z` stable versions numerically. */
function compareStableVersions(a: string, b: string): number {
  const left = a.split(".").map(BigInt);
  const right = b.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) {
    const l = left[index] ?? 0n;
    const r = right[index] ?? 0n;
    if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

async function requireBranchChecks({
  api,
  sourceRevision,
  branch,
  ciRun,
  ciJobs,
}: {
  readonly api: Api;
  readonly sourceRevision: string;
  readonly branch: Record<string, unknown>;
  readonly ciRun: Record<string, unknown>;
  readonly ciJobs: readonly unknown[];
}) {
  const rules = (await pages({ api, path: "rules/branches/next" })).map(object);
  // Get-branch includes classic check policy with Contents:read. The dedicated
  // protection endpoint requires Administration:read, unavailable to GITHUB_TOKEN.
  // Missing metadata refuses; a permission error is not absent protection.
  const classic = object(object(branch.protection).required_status_checks);
  const requirements = rules
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => array(object(rule.parameters).required_status_checks))
    .map(object);
  requirements.push(
    ...array(classic.checks).map((value) => {
      const check = object(value);
      return { context: check.context, integration_id: check.app_id };
    }),
    ...array(classic.contexts).map((context) => ({ context }))
  );
  if (requirements.length === 0) {
    throw new Error("next must require status checks");
  }
  const checks = (
    await pages({
      api,
      path: `commits/${sourceRevision}/check-runs?filter=all`,
      field: "check_runs",
    })
  ).map(object);
  const statuses = (
    await pages({ api, path: `commits/${sourceRevision}/statuses` })
  ).map(object);
  const ciContexts = new Map(ciJobs.map(object).map((job) => [job.name, job]));
  const externalChecks = requirements.some(
    (requirement) => !ciContexts.has(requirement.context)
  )
    ? (
        await pages({
          api,
          path: `commits/${sourceRevision}/check-runs?filter=latest`,
          field: "check_runs",
        })
      ).map(object)
    : [];
  for (const requirement of requirements) {
    if (
      typeof requirement.context !== "string" ||
      requirement.context.length === 0
    ) {
      throw new Error("Invalid required-check policy");
    }
    const ciJob = ciContexts.get(requirement.context);
    const checkId =
      typeof ciJob?.check_run_url === "string"
        ? /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/check-runs\/([1-9][0-9]*)$/.exec(
            ciJob.check_run_url
          )?.[1]
        : undefined;
    const check = (ciJob ? checks : externalChecks).find(
      (check) =>
        check.name === requirement.context &&
        (!ciJob ||
          (checkId !== undefined &&
            check.id === Number(checkId) &&
            object(check.check_suite).id === ciRun.check_suite_id)) &&
        (requirement.integration_id == null ||
          requirement.integration_id === -1 ||
          object(check.app).id === requirement.integration_id)
    );
    const status = statuses.find(
      (status) => status.context === requirement.context
    );
    const success = check
      ? check.head_sha === sourceRevision &&
        check.status === "completed" &&
        check.conclusion === "success"
      : !ciContexts.has(requirement.context) &&
        requirement.integration_id == null &&
        status?.state === "success";
    if (!success) {
      throw new Error(
        `Required exact-head check did not succeed: ${requirement.context}`
      );
    }
  }
}

export async function pages({
  api,
  path,
  field,
}: {
  readonly api: Api;
  readonly path: string;
  readonly field?: string;
}) {
  const all: unknown[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = await api(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`
    );
    const items = array(field ? object(result)[field] : result);
    all.push(...items);
    if (items.length < 100) {
      return all;
    }
  }
  throw new Error("GitHub pagination limit exceeded");
}

/** Older bundles may omit local schema, but never the compiler/project-schema pair. */
function configCompilerPayload(entries: readonly string[]) {
  const compilerPayload = CONFIG_COMPILER_PAYLOAD.filter((name) =>
    entries.includes(name)
  );
  if (
    compilerPayload.length !== 0 &&
    !(
      compilerPayload.includes("hack-config-compiler") &&
      compilerPayload.includes("hack.project.schema.json")
    )
  ) {
    throw new Error(
      "Native config compiler payload requires the compiler and project schema; local schema is optional for older bundles"
    );
  }
  return compilerPayload;
}

export async function packagePrerelease({
  plan,
  bundle,
  output,
  buildManager = buildPrereleaseManager,
}: {
  readonly plan: PrereleasePlan;
  readonly bundle: string;
  readonly output: string;
  readonly buildManager?: (output: string) => Promise<void>;
}) {
  if (!(await lstat(bundle)).isDirectory()) {
    throw new Error("Native bundle root must be a directory, not an alias");
  }
  const entries = await readdir(bundle);
  const compilerPayload = configCompilerPayload(entries);
  const mcpPayload = await nativeCandidateMcpPayload(bundle);
  const payload = [...PRERELEASE_PAYLOAD, ...compilerPayload, ...mcpPayload];
  const expected = [
    ...PRERELEASE_PAYLOAD,
    ...compilerPayload,
    "SHA256SUMS",
    ...(mcpPayload.length ? ["mcp"] : []),
  ].sort();
  if (JSON.stringify(entries.sort()) !== JSON.stringify(expected)) {
    throw new Error(
      "Native prerelease bundle must contain exactly the complete payload and checksums"
    );
  }
  for (const name of [...payload, "SHA256SUMS"]) {
    const entry = await lstat(join(bundle, name));
    if (!entry.isFile() || entry.nlink !== 1) {
      throw new Error(`Native bundle payload must be a regular file: ${name}`);
    }
    const mode = PAYLOAD_MODES[name];
    if (mode !== undefined && (entry.mode & 0o7777) !== mode) {
      throw new Error(`Native bundle payload has unsafe permissions: ${name}`);
    }
  }
  const metadata = prereleaseMetadata({
    version: plan.version,
    sourceRevision: plan.source_revision,
    base: plan.base,
  });
  await verifyStorageToolPayload({
    bundle,
    sourceRevision: plan.source_revision,
  });
  const actualMetadata: unknown = await Bun.file(
    join(bundle, "prerelease.json")
  ).json();
  if (JSON.stringify(actualMetadata) !== JSON.stringify(metadata)) {
    throw new Error(
      "Bundle metadata must match the requested version and revision"
    );
  }
  const checksums = await renderChecksums({
    root: bundle,
    names: payload,
  });
  if ((await Bun.file(join(bundle, "SHA256SUMS")).text()) !== checksums) {
    throw new Error(
      "Native bundle checksums do not match its complete payload"
    );
  }
  await mkdir(output, { mode: 0o700 });
  // macOS tar otherwise adds AppleDouble members for source extended attributes.
  // GNU tar ignores COPYFILE_DISABLE, so the fixed payload remains portable.
  await run(
    [
      "tar",
      "--format=ustar",
      "-czf",
      join(output, plan.archive),
      "-C",
      bundle,
      ...payload,
      "SHA256SUMS",
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } }
  );
  await Bun.write(
    join(output, "prerelease.json"),
    `${JSON.stringify(metadata, null, 2)}\n`
  );
  await Bun.write(
    join(output, "SHA256SUMS"),
    await renderChecksums({ root: output, names: [plan.archive] })
  );
  await buildManager(join(output, MANAGER_ASSET));
  await Bun.write(
    join(output, BOOTSTRAP_ASSET),
    renderBootstrap(plan.version, digest(join(output, MANAGER_ASSET)))
  );
  await Bun.write(
    join(output, INSTALLER_SUMS),
    await renderChecksums({
      root: output,
      names: [MANAGER_ASSET, BOOTSTRAP_ASSET],
    })
  );
}

/**
 * Bind the manifest to the witness bytes and the planned source revision with the
 * runtime's own parser. Runtime admission refuses any mismatch, so never publish
 * a bundle that would refuse every storage-backed project.
 */
async function verifyStorageToolPayload({
  bundle,
  sourceRevision,
}: {
  readonly bundle: string;
  readonly sourceRevision: string;
}) {
  const declared = await readStorageToolManifest(
    join(bundle, NATIVE_STORAGE_TOOL_MANIFEST)
  );
  let observed: NativeStorageToolManifest;
  try {
    observed = nativeStorageToolManifest(
      await Bun.file(join(bundle, NATIVE_STORAGE_TOOL_FILE)).bytes(),
      sourceRevision
    );
  } catch {
    throw new Error("Native storage tool must be a bounded Linux ARM64 ELF");
  }
  if (JSON.stringify(declared) !== JSON.stringify(observed)) {
    throw new Error(
      "Native storage tool manifest must match the witness bytes and source revision"
    );
  }
}

/** Same size bound, strict UTF-8 and parser as runtime admission. */
async function readStorageToolManifest(path: string) {
  try {
    const file = Bun.file(path);
    if (file.size > 4096) {
      throw new Error("oversized");
    }
    return parseNativeStorageToolManifest(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(await file.bytes())
      )
    );
  } catch {
    throw new Error("Native storage tool manifest is malformed");
  }
}

export async function renderChecksums({
  root,
  names,
}: {
  readonly root: string;
  readonly names: readonly string[];
}) {
  const lines: string[] = [];
  for (const name of names) {
    const bytes = await Bun.file(join(root, name)).arrayBuffer();
    lines.push(
      `${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}  ${name}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function verifyReleaseAssets({
  plan,
  output,
}: {
  readonly plan: PrereleasePlan;
  readonly output: string;
}) {
  if (
    JSON.stringify((await readdir(output)).sort()) !==
    JSON.stringify([...plan.assets].sort())
  ) {
    throw new Error(
      "Expected exactly the candidate and standalone installer release assets"
    );
  }
  for (const name of plan.assets) {
    const entry = await lstat(join(output, name));
    if (!entry.isFile() || entry.nlink !== 1) {
      throw new Error("Release assets must be regular files");
    }
  }
  if (
    (await Bun.file(join(output, BOOTSTRAP_ASSET)).text()) !==
      renderBootstrap(plan.version, digest(join(output, MANAGER_ASSET))) ||
    (await Bun.file(join(output, INSTALLER_SUMS)).text()) !==
      (await renderChecksums({
        root: output,
        names: [MANAGER_ASSET, BOOTSTRAP_ASSET],
      }))
  ) {
    throw new Error("Standalone installer bytes or checksum manifest changed");
  }
  const expected = prereleaseMetadata({
    version: plan.version,
    sourceRevision: plan.source_revision,
    base: plan.base,
  });
  const metadata: unknown = await Bun.file(
    join(output, "prerelease.json")
  ).json();
  if (JSON.stringify(metadata) !== JSON.stringify(expected)) {
    throw new Error("Release asset metadata does not match the approved plan");
  }
  if (
    (await Bun.file(join(output, "SHA256SUMS")).text()) !==
    (await renderChecksums({ root: output, names: [plan.archive] }))
  ) {
    throw new Error("Release archive does not match its outer checksum");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid GitHub or release object");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid GitHub array");
  }
  return value;
}

async function run(
  cmd: string[],
  options: { readonly env?: NodeJS.ProcessEnv } = {}
) {
  const child = Bun.spawn(cmd, {
    ...options,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) {
    throw new Error(`Command failed: ${cmd[0]}`);
  }
}

function env(name: string): string {
  return process.env[name] ?? "";
}

export function githubApi(): Api {
  if (
    env("GITHUB_ACTIONS") !== "true" ||
    env("GITHUB_REPOSITORY") !== "hack-dance/hack" ||
    !env("GH_TOKEN")
  ) {
    throw new Error(
      "Publish verification requires this repository's GitHub workflow token"
    );
  }
  return async (path, allowMissing = false) => {
    const response = await fetch(
      `https://api.github.com/repos/hack-dance/hack/${path}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${env("GH_TOKEN")}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (allowMissing && response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(
        `GitHub verification failed (${response.status}): ${path}`
      );
    }
    return response.json();
  };
}

async function main() {
  const mode = Bun.argv[2] ?? "plan";
  if (mode === "stable") {
    const pkg = object(await Bun.file("package.json").json());
    const tag = env("RELEASE_TAG_INPUT") || env("GITHUB_REF_NAME");
    const version = stableReleaseVersion({
      channel: env("RELEASE_CHANNEL") || "stable",
      tag,
      packageVersion: String(pkg.version),
    });
    await appendFile(env("GITHUB_OUTPUT"), `tag=${tag}\nversion=${version}\n`);
    return;
  }
  const version = env("HACK_PRERELEASE_VERSION");
  const sourceRevision = env("HACK_PRERELEASE_SOURCE_REVISION");
  if (mode === "metadata") {
    process.stdout.write(
      `${JSON.stringify(prereleaseMetadata({ version, sourceRevision }), null, 2)}\n`
    );
    return;
  }
  const plan = createPrereleasePlan({
    version,
    sourceRevision,
    ref: env("GITHUB_REF"),
    eventName: env("GITHUB_EVENT_NAME"),
    channel: env("RELEASE_CHANNEL"),
    publish: env("HACK_PRERELEASE_PUBLISH") || "false",
  });
  if (env("GITHUB_SHA") && env("GITHUB_SHA") !== sourceRevision) {
    throw new Error(
      "Dispatch SHA must equal the requested full source revision"
    );
  }
  if (mode === "package") {
    await packagePrerelease({
      plan,
      bundle: resolve(env("HACK_PRERELEASE_BUNDLE")),
      output: resolve(env("HACK_PRERELEASE_OUTPUT")),
    });
  } else if (mode === "verify-ci") {
    const { run } = await verifyPrereleaseCi({
      api: githubApi(),
      sourceRevision,
    });
    process.stdout.write(
      `Qualified release-full CI run ${String(run.id)} at ${sourceRevision}\n`
    );
  } else if (mode === "verify" || mode === "publish") {
    if (!plan.publish || env("GITHUB_RUN_ATTEMPT") !== "1") {
      throw new Error(
        "Publishing requires explicit publish=true and a fresh workflow run"
      );
    }
    await verifyPublishGate({
      plan,
      api: githubApi(),
      runId: env("GITHUB_RUN_ID"),
      approved: mode === "publish",
    });
    if (mode === "publish") {
      const output = resolve(env("HACK_PRERELEASE_OUTPUT"));
      await verifyReleaseAssets({ plan, output });
      // Exclusive reference creation refuses a tag created since gate verification.
      // Failure retains this tag for inspection; reruns must never replace it.
      await run([
        "gh",
        "api",
        "--method",
        "POST",
        "repos/hack-dance/hack/git/refs",
        "--raw-field",
        `ref=refs/tags/${plan.tag}`,
        "--raw-field",
        `sha=${plan.source_revision}`,
      ]);
      await run([
        "gh",
        "release",
        "create",
        plan.tag,
        ...plan.assets.map((name) => join(output, name)),
        "--repo",
        "hack-dance/hack",
        "--target",
        plan.source_revision,
        "--verify-tag",
        "--prerelease",
        "--latest=false",
        "--title",
        `Hack ${plan.version}`,
        "--notes",
        prereleaseNotes(plan),
      ]);
    }
  } else if (mode !== "plan") {
    throw new Error(
      "Expected plan, metadata, package, verify-ci, verify, publish, or stable"
    );
  }
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  if (mode === "plan" && env("GITHUB_OUTPUT")) {
    await appendFile(
      env("GITHUB_OUTPUT"),
      `version=${plan.version}\ntag=${plan.tag}\nsource_revision=${plan.source_revision}\narchive=${plan.archive}\n`
    );
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Prerelease failed"}\n`
    );
    process.exitCode = 1;
  }
}
