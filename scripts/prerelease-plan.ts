#!/usr/bin/env bun
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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
  type LinuxManagerDigests,
  MANAGER_ASSET,
  renderBootstrap,
} from "./installer/bootstrap.ts";
import { extractArchive } from "./installer/bundle.ts";
import {
  LINUX_SUMS,
  linuxSumsNames,
  officialArchive,
} from "./installer/download.ts";
import {
  BUNDLE_PLATFORMS,
  type BundlePlatform,
  bundleArchiveName,
  COMPOSE_PAYLOAD,
  composeOnly,
  digest,
  hostBundlePlatform,
  LINUX_BUNDLE_PLATFORMS,
  managerAssetName,
  VERSION,
} from "./installer/integrity.ts";
import {
  PLATFORMS_ASSET,
  renderReleasePlatforms,
  requireReleasePlatforms,
} from "./installer/release-platforms.ts";

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
  "hack-lifecycle-supervisor": 0o755,
  "hack.project.schema.json": 0o600,
  "hack.local.schema.json": 0o600,
};
/**
 * The native candidate platform, and the platform the release-level
 * `prerelease.json` records. There it means "the native bundle's platform,
 * kept for published managers", not "the only platform in the release":
 * every published manager, macOS and Linux, requires exactly this value and
 * exactly five keys in that file, so it does not change when other platforms
 * are added. `prerelease-platforms.json` names every platform in a release
 * (see `scripts/installer/release-platforms.ts`, HACK-2419).
 */
export const PRERELEASE_PLATFORM = "darwin-arm64";
/** The Compose-only Linux bundle platforms a release also ships. */
export const PRERELEASE_LINUX_PLATFORMS = LINUX_BUNDLE_PLATFORMS;
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
  platform = PRERELEASE_PLATFORM,
}: {
  readonly version: string;
  readonly sourceRevision: string;
  readonly base?: string;
  /** The bundle the metadata goes into; the release-level file keeps the default. */
  readonly platform?: BundlePlatform;
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
    platform,
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
    // Linux assets are listed apart: `assets` stays exactly the set every
    // published macOS manager and installer was written against.
    linuxAssets: [...linuxSumsNames(version), LINUX_SUMS],
    // Names every platform in the set. Present whenever the Linux assets are.
    platformsAsset: PLATFORMS_ASSET,
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
  const envChanges =
    tag === "v5.0.0-next.17"
      ? [
          "Breaking env output change (HACK-2166, #767): env list now returns names, scopes, layers and set state by default, including JSON. Replace scripted env list --json --show-secrets with explicit hack env get KEY reads for only the keys needed; use has_value for availability checks and never log plaintext. Bulk reveal requires --show-values in an interactive terminal.",
          "Pipe secret writes through hack env add KEY --secret --value-stdin (or env set); positional secret values are refused. Legacy lifecycle hooks/processes now receive only global values. Use hack env protect to list plaintext key names and hack env protect KEY... to encrypt chosen entries in place, preserving scope and overlay.",
          "Fixed migration key deletion (HACK-2172, #769): cleanup preserves current project/shared keys and current env inputs, including filesystem aliases. Keep existing private key backups; the fix cannot recover a key already removed by an earlier release.",
          "Daemon env API: YAML-layer projects return names-only metadata from GET /v1/env. Legacy POST /v1/env/set and /v1/env/unset return HTTP 409 yaml_env_mutation_unsupported for these projects; use the canonical CLI env commands instead.",
        ]
      : [];
  return [
    `Native macOS ARM64 candidate and Compose-only Linux (x86_64, arm64) candidate from ${sourceRevision}. Requires explicit opt-in; stable installation is unchanged.`,
    `Supported platform, unsupported platforms and capability limits: https://github.com/hack-dance/hack/blob/${tag}/docs/guides/prereleases.md#${PRERELEASE_SUPPORT_ANCHOR}`,
    ...envChanges,
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

// ci.yml's compose-upgrade-trial `if:` requires workflow_dispatch and inputs.compose_upgrade_trial.
const PRERELEASE_OPT_IN_CI_JOBS = ["compose-upgrade-trial"] as const;

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
    completed.some((job) => {
      const skippedOptIn =
        branch === "next" &&
        job.conclusion === "skipped" &&
        PRERELEASE_OPT_IN_CI_JOBS.some((name) => name === job.name);
      return (
        job.status !== "completed" ||
        (job.conclusion !== "success" && !skippedOptIn)
      );
    })
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

function renderReleaseMetadata(
  metadata: ReturnType<typeof prereleaseMetadata>
) {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

export async function packagePrerelease({
  plan,
  bundle,
  output,
  buildManager = buildPrereleaseManager,
  linux,
  nativeSignatures,
}: {
  readonly plan: PrereleasePlan;
  readonly bundle: string;
  readonly output: string;
  readonly buildManager?: (output: string) => Promise<void>;
  /**
   * Directory holding exactly the two Linux archives and two Linux managers
   * that `packageLinuxPrerelease` produced on their own hosts. When given,
   * they are verified, copied beside the macOS assets and listed in
   * `SHA256SUMS-linux`, and the installer accepts Linux. The macOS assets
   * other than the installer are the same bytes either way.
   */
  readonly linux?: string;
  /** Fixture seam for synthetic unsigned native archives. */
  readonly nativeSignatures?: (bundle: string) => void;
}) {
  if (!(await lstat(bundle)).isDirectory()) {
    throw new Error("Native bundle root must be a directory, not an alias");
  }
  const entries = await readdir(bundle);
  const helperPayload = [
    ...(entries.includes("hack-lifecycle-supervisor")
      ? ["hack-lifecycle-supervisor"]
      : []),
    ...configCompilerPayload(entries),
  ];
  const mcpPayload = await nativeCandidateMcpPayload(bundle);
  const payload = [...PRERELEASE_PAYLOAD, ...helperPayload, ...mcpPayload];
  const expected = [
    ...PRERELEASE_PAYLOAD,
    ...helperPayload,
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
    renderReleaseMetadata(metadata)
  );
  await Bun.write(
    join(output, "SHA256SUMS"),
    await renderChecksums({ root: output, names: [plan.archive] })
  );
  await buildManager(join(output, MANAGER_ASSET));
  if (linux !== undefined) {
    await addLinuxAssets({ plan, linux, output });
    await Bun.write(
      join(output, PLATFORMS_ASSET),
      renderReleasePlatforms({
        version: plan.version,
        sourceRevision: plan.source_revision,
      })
    );
  }
  await Bun.write(
    join(output, BOOTSTRAP_ASSET),
    renderBootstrap(
      plan.version,
      digest(join(output, MANAGER_ASSET)),
      linux === undefined ? undefined : linuxManagerDigests(output)
    )
  );
  await Bun.write(
    join(output, INSTALLER_SUMS),
    await renderChecksums({
      root: output,
      names: [MANAGER_ASSET, BOOTSTRAP_ASSET],
    })
  );
  if (linux !== undefined) {
    // The finished set must be the one the platforms metadata describes.
    await requireReleasePlatformMetadata({ plan, output });
  }
  await requireInstallableArchive({
    plan,
    platform: PRERELEASE_PLATFORM,
    directory: output,
    signatures: nativeSignatures,
  });
}

/** The digests the installer embeds for the Linux managers in `output`. */
function linuxManagerDigests(output: string): LinuxManagerDigests {
  return {
    "linux-x86_64": digest(join(output, managerAssetName("linux-x86_64"))),
    "linux-arm64": digest(join(output, managerAssetName("linux-arm64"))),
  };
}

/** Extract and verify with the same admission checks as the installer. */
async function requireInstallableArchive({
  plan,
  platform,
  directory,
  signatures,
}: {
  readonly plan: PrereleasePlan;
  readonly platform: BundlePlatform;
  readonly directory: string;
  readonly signatures?: (bundle: string) => void;
}) {
  const archive = join(directory, bundleArchiveName(plan.version, platform));
  const probe = await mkdtemp(join(tmpdir(), "hack-release-archive-"));
  try {
    const { identity } = extractArchive({
      archive,
      checksum: digest(archive),
      destination: join(probe, "bundle"),
      version: plan.version,
      platform,
      signatures,
    });
    if (identity.source_revision !== plan.source_revision) {
      throw new Error(
        `${composeOnly(platform) ? "Linux" : "Native"} archive for ${platform} was built from another source revision`
      );
    }
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

async function requireLinuxAssets(options: {
  readonly plan: PrereleasePlan;
  readonly platform: BundlePlatform;
  readonly directory: string;
}) {
  const { directory, platform } = options;
  await requireInstallableArchive(options);
  await requireLinuxManagerElf({
    path: join(directory, managerAssetName(platform)),
    platform,
  });
}

const ELF_HEADER_BYTES = 64;
const ELF_PROGRAM_HEADER_BYTES = 56;
/** Far above any real executable's count; bounds the table this check reads. */
const ELF_MAX_PROGRAM_HEADERS = 256;

/**
 * Structural validation of a Linux manager: a complete ELF64 little-endian
 * header of an executable (`ET_EXEC` or `ET_DYN`) for the platform's machine,
 * with a program-header table that lies inside the file and at least one
 * loadable segment whose bytes are in the file. It stops a truncated file, a
 * stub or the other architecture's manager from being given a digest in the
 * installer and published. It is not authentication: it does not show the file
 * is the manager the Linux job built.
 */
export async function requireLinuxManagerElf({
  path,
  platform,
}: {
  readonly path: string;
  readonly platform: BundlePlatform;
}) {
  const refuse = (): never => {
    throw new Error(
      `Linux manager for ${platform} is not a structurally valid ELF executable for that architecture`
    );
  };
  const file = Bun.file(path);
  const size = file.size;
  if (size < ELF_HEADER_BYTES + ELF_PROGRAM_HEADER_BYTES) {
    refuse();
  }
  const header = Buffer.from(
    await file.slice(0, ELF_HEADER_BYTES).arrayBuffer()
  );
  // e_ident: magic, ELFCLASS64, ELFDATA2LSB, EV_CURRENT.
  const ident = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  const type = header.readUInt16LE(16);
  const programOffset = header.readBigUInt64LE(32);
  const programCount = header.readUInt16LE(56);
  if (
    header.length !== ELF_HEADER_BYTES ||
    !header.subarray(0, ident.length).equals(ident) ||
    // ET_EXEC is 2, ET_DYN (position-independent executable) is 3.
    !(type === 2 || type === 3) ||
    // EM_X86_64 is 62, EM_AARCH64 is 183.
    header.readUInt16LE(18) !== (platform === "linux-arm64" ? 183 : 62) ||
    header.readUInt32LE(20) !== 1 ||
    header.readUInt16LE(52) !== ELF_HEADER_BYTES ||
    header.readUInt16LE(54) !== ELF_PROGRAM_HEADER_BYTES ||
    programCount < 1 ||
    programCount > ELF_MAX_PROGRAM_HEADERS ||
    programOffset < BigInt(ELF_HEADER_BYTES) ||
    programOffset + BigInt(programCount * ELF_PROGRAM_HEADER_BYTES) >
      BigInt(size)
  ) {
    refuse();
  }
  const start = Number(programOffset);
  const table = Buffer.from(
    await file
      .slice(start, start + programCount * ELF_PROGRAM_HEADER_BYTES)
      .arrayBuffer()
  );
  let loadable = false;
  for (let index = 0; index < programCount; index++) {
    const entry = table.subarray(
      index * ELF_PROGRAM_HEADER_BYTES,
      (index + 1) * ELF_PROGRAM_HEADER_BYTES
    );
    // PT_LOAD is 1; p_offset is at 8 and p_filesz at 32.
    if (
      entry.length === ELF_PROGRAM_HEADER_BYTES &&
      entry.readUInt32LE(0) === 1 &&
      entry.readBigUInt64LE(32) > 0n &&
      entry.readBigUInt64LE(8) + entry.readBigUInt64LE(32) <= BigInt(size)
    ) {
      loadable = true;
    }
  }
  if (!loadable) {
    refuse();
  }
}

/** Verify the Linux build jobs' files and place them beside the macOS assets. */
async function addLinuxAssets({
  plan,
  linux,
  output,
}: {
  readonly plan: PrereleasePlan;
  readonly linux: string;
  readonly output: string;
}) {
  const names = linuxSumsNames(plan.version);
  if (
    JSON.stringify((await readdir(linux)).sort()) !==
    JSON.stringify([...names].sort())
  ) {
    throw new Error(
      "Linux assets must be exactly the two Compose archives and the two Linux managers"
    );
  }
  for (const name of names) {
    const entry = await lstat(join(linux, name));
    if (!entry.isFile() || entry.nlink !== 1) {
      throw new Error(`Linux asset must be a regular file: ${name}`);
    }
  }
  for (const platform of PRERELEASE_LINUX_PLATFORMS) {
    await requireLinuxAssets({ plan, platform, directory: linux });
  }
  for (const name of names) {
    await copyFile(join(linux, name), join(output, name));
  }
  await Bun.write(
    join(output, LINUX_SUMS),
    await renderChecksums({ root: output, names })
  );
}

/**
 * The Linux build job's packaging step, run on the platform it packages: check
 * the bundle `scripts/build-compose-candidate.sh` wrote, archive it and build
 * that platform's manager. The output directory then holds exactly the archive
 * and the manager; the macOS job adds them to the release set.
 */
export async function packageLinuxPrerelease({
  plan,
  bundle,
  output,
  platform,
  buildManager = buildPrereleaseManager,
}: {
  readonly plan: PrereleasePlan;
  readonly bundle: string;
  readonly output: string;
  readonly platform: BundlePlatform;
  readonly buildManager?: (output: string) => Promise<void>;
}) {
  if (!composeOnly(platform)) {
    throw new Error("Linux packaging requires a Linux bundle platform");
  }
  if (!(await lstat(bundle)).isDirectory()) {
    throw new Error("Compose bundle root must be a directory, not an alias");
  }
  const expected = [...COMPOSE_PAYLOAD, "SHA256SUMS"].sort();
  if (
    JSON.stringify((await readdir(bundle)).sort()) !== JSON.stringify(expected)
  ) {
    throw new Error(
      "Compose prerelease bundle must contain exactly the complete payload and checksums"
    );
  }
  for (const name of expected) {
    const entry = await lstat(join(bundle, name));
    if (!entry.isFile() || entry.nlink !== 1) {
      throw new Error(`Compose bundle payload must be a regular file: ${name}`);
    }
    const mode = PAYLOAD_MODES[name];
    if (mode !== undefined && (entry.mode & 0o7777) !== mode) {
      throw new Error(`Compose bundle payload has unsafe permissions: ${name}`);
    }
  }
  const metadata = prereleaseMetadata({
    version: plan.version,
    sourceRevision: plan.source_revision,
    base: plan.base,
    platform,
  });
  const actualMetadata: unknown = await Bun.file(
    join(bundle, "prerelease.json")
  ).json();
  if (JSON.stringify(actualMetadata) !== JSON.stringify(metadata)) {
    throw new Error(
      "Bundle metadata must match the requested version, revision and platform"
    );
  }
  if (
    (await Bun.file(join(bundle, "SHA256SUMS")).text()) !==
    (await renderChecksums({ root: bundle, names: COMPOSE_PAYLOAD }))
  ) {
    throw new Error(
      "Compose bundle checksums do not match its complete payload"
    );
  }
  await mkdir(output, { mode: 0o700 });
  const archive = join(output, bundleArchiveName(plan.version, platform));
  await run([
    "tar",
    "--format=ustar",
    "-czf",
    archive,
    "-C",
    bundle,
    ...COMPOSE_PAYLOAD,
    "SHA256SUMS",
  ]);
  // The installer's own extraction is the acceptance test for the archive.
  const probe = await mkdtemp(join(tmpdir(), "hack-compose-package-"));
  try {
    extractArchive({
      archive,
      checksum: digest(archive),
      destination: join(probe, "bundle"),
      version: plan.version,
      platform,
    });
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
  await buildManager(join(output, managerAssetName(platform)));
}

/**
 * An installer for a Linux build job to install its own package with, before
 * the release set exists. It is the published script with one difference: only
 * this host's manager digest is real. The other two are zeros, so it cannot
 * install on another platform, and it is never a release asset.
 */
export async function writeRehearsalInstaller({
  plan,
  output,
  directory,
  platform = hostBundlePlatform(),
}: {
  readonly plan: PrereleasePlan;
  readonly output: string;
  readonly directory: string;
  readonly platform?: BundlePlatform | null;
}) {
  if (platform === null || !composeOnly(platform)) {
    throw new Error("The rehearsal installer is for a Linux build host");
  }
  const unknown = "0".repeat(64);
  const own = digest(join(output, managerAssetName(platform)));
  await mkdir(directory, { mode: 0o700 });
  await Bun.write(
    join(directory, BOOTSTRAP_ASSET),
    renderBootstrap(plan.version, unknown, {
      "linux-x86_64": platform === "linux-x86_64" ? own : unknown,
      "linux-arm64": platform === "linux-arm64" ? own : unknown,
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

/**
 * Every asset a release uploads: the macOS set, the Linux set, then the
 * metadata that names every platform in both.
 */
export function releaseAssets(plan: PrereleasePlan): string[] {
  return [...plan.assets, ...plan.linuxAssets, plan.platformsAsset];
}

/** Verify that the manifest describes exactly the assets in the release. */
async function requireReleasePlatformMetadata({
  plan,
  output,
}: {
  readonly plan: PrereleasePlan;
  readonly output: string;
}) {
  requireReleasePlatforms({
    raw: await Bun.file(join(output, PLATFORMS_ASSET)).bytes(),
    version: plan.version,
    sourceRevision: plan.source_revision,
    assetNames: await readdir(output),
  });
}

/** Exercise the installed manager's reader without opening a network connection. */
async function verifyLocalRelease({
  plan,
  output,
  assets,
  platform,
  signatures,
}: {
  plan: PrereleasePlan;
  output: string;
  assets: readonly string[];
  platform: BundlePlatform;
  signatures?: (bundle: string) => void;
}) {
  const api = "https://api.github.com/repos/hack-dance/hack";
  const releaseUrl = `${api}/releases/tags/${plan.tag}`;
  const tagUrl = `${api}/git/ref/tags/${plan.tag}`;
  const entries = assets.map((name) => ({
    name,
    browser_download_url: `https://github.com/hack-dance/hack/releases/download/${plan.tag}/${name}`,
  }));
  const files = new Map(
    entries.map(({ name, browser_download_url }) => [
      browser_download_url,
      name,
    ])
  );
  const stage = await mkdtemp(join(tmpdir(), "hack-release-reader-"));
  try {
    const download = await officialArchive(
      stage,
      plan.version,
      undefined,
      platform,
      (url) => {
        if (url === releaseUrl) {
          return Promise.resolve(
            Response.json({
              tag_name: plan.tag,
              prerelease: true,
              draft: false,
              assets: entries,
            })
          );
        }
        if (url === tagUrl) {
          return Promise.resolve(
            Response.json({
              ref: `refs/tags/${plan.tag}`,
              object: { type: "commit", sha: plan.source_revision },
            })
          );
        }
        const name = files.get(url);
        if (name === undefined) {
          throw new Error("Unexpected local release asset request");
        }
        const file = Bun.file(join(output, name));
        return Promise.resolve(
          new Response(file.stream(), {
            headers: { "Content-Length": String(file.size) },
          })
        );
      }
    );
    extractArchive({
      ...download,
      destination: join(stage, "bundle"),
      version: plan.version,
      platform,
      signatures,
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function verifyReleaseAssets({
  plan,
  output,
  linux = false,
  nativeSignatures,
}: {
  readonly plan: PrereleasePlan;
  readonly output: string;
  /**
   * Require the Linux assets too. Publication always does; without it the
   * directory must hold exactly the macOS set, as a macOS-only package does.
   */
  readonly linux?: boolean;
  /** Fixture seam for unsigned synthetic native archives. */
  readonly nativeSignatures?: (bundle: string) => void;
}) {
  const assets = linux ? releaseAssets(plan) : plan.assets;
  if (
    JSON.stringify((await readdir(output)).sort()) !==
    JSON.stringify([...assets].sort())
  ) {
    throw new Error(
      "Expected exactly the candidate and standalone installer release assets"
    );
  }
  for (const name of assets) {
    const entry = await lstat(join(output, name));
    if (!entry.isFile() || entry.nlink !== 1) {
      throw new Error("Release assets must be regular files");
    }
  }
  if (linux) {
    if (
      (await Bun.file(join(output, LINUX_SUMS)).text()) !==
      (await renderChecksums({
        root: output,
        names: linuxSumsNames(plan.version),
      }))
    ) {
      throw new Error("Linux assets do not match their checksum manifest");
    }
    for (const platform of PRERELEASE_LINUX_PLATFORMS) {
      await requireLinuxManagerElf({
        path: join(output, managerAssetName(platform)),
        platform,
      });
    }
  }
  if (
    (await Bun.file(join(output, BOOTSTRAP_ASSET)).text()) !==
      renderBootstrap(
        plan.version,
        digest(join(output, MANAGER_ASSET)),
        linux ? linuxManagerDigests(output) : undefined
      ) ||
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
  if (
    (await Bun.file(join(output, "SHA256SUMS")).text()) !==
    (await renderChecksums({ root: output, names: [plan.archive] }))
  ) {
    throw new Error("Release archive does not match its outer checksum");
  }
  if (linux) {
    await requireReleasePlatformMetadata({ plan, output });
  }
  const platforms: readonly BundlePlatform[] = linux
    ? BUNDLE_PLATFORMS
    : [PRERELEASE_PLATFORM];
  for (const platform of platforms) {
    await verifyLocalRelease({
      plan,
      output,
      assets,
      platform,
      signatures: composeOnly(platform) ? undefined : nativeSignatures,
    });
  }
  const canonical = Buffer.from(renderReleaseMetadata(expected));
  if (
    !canonical.equals(await Bun.file(join(output, "prerelease.json")).bytes())
  ) {
    throw new Error("Release asset metadata does not match the approved plan");
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

async function releaseApi(
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<unknown> {
  const child = Bun.spawn(["gh", "api", ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    timeout: 60_000,
  });
  const [json, status] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (status !== 0) {
    throw new Error("Could not read back the published prerelease");
  }
  return JSON.parse(json);
}

async function pendingReleaseAssets({
  repository,
  releaseId,
  expected,
  env,
}: {
  repository: string;
  releaseId: number;
  expected: ReadonlyMap<string, { size: number; digest: string }>;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const pages = array(
    await releaseApi(
      [
        "--paginate",
        "--slurp",
        `${repository}/releases/${releaseId}/assets?per_page=100`,
      ],
      env
    )
  );
  const remaining = new Map(expected);
  const pending: string[] = [];
  for (const raw of pages.flatMap(array)) {
    const asset = object(raw);
    const local =
      typeof asset.name === "string" ? remaining.get(asset.name) : undefined;
    if (!local || typeof asset.name !== "string") {
      throw new Error(
        "Published prerelease contains an unexpected or duplicate asset"
      );
    }
    if (
      asset.size !== local.size ||
      (asset.digest !== null && asset.digest !== local.digest)
    ) {
      throw new Error(
        `Published prerelease asset does not match the local set: ${asset.name}`
      );
    }
    remaining.delete(asset.name);
    if (asset.state !== "uploaded" || asset.digest === null) {
      pending.push(asset.name);
    }
  }
  return [...pending, ...remaining.keys()];
}

/** Post-create verification reports failures without deleting or replacing the release. */
export async function createAndVerifyPrerelease({
  plan,
  output,
  env,
  sleep = Bun.sleep,
}: {
  readonly plan: PrereleasePlan;
  readonly output: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}) {
  const names = releaseAssets(plan);
  const expected = new Map<string, { size: number; digest: string }>();
  for (const name of names) {
    const path = join(output, name);
    const size = (await lstat(path)).size;
    expected.set(name, { size, digest: `sha256:${digest(path)}` });
  }
  // Exclusive reference creation refuses a tag created since gate verification.
  // Failure retains this tag for inspection; reruns must never replace it.
  await run(
    [
      "gh",
      "api",
      "--method",
      "POST",
      "repos/hack-dance/hack/git/refs",
      "--raw-field",
      `ref=refs/tags/${plan.tag}`,
      "--raw-field",
      `sha=${plan.source_revision}`,
    ],
    { env }
  );
  await run(
    [
      "gh",
      "release",
      "create",
      plan.tag,
      ...names.map((name) => join(output, name)),
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
    ],
    { env }
  );
  try {
    const repository = "repos/hack-dance/hack";
    const release = object(
      await releaseApi([`${repository}/releases/tags/${plan.tag}`], env)
    );
    if (
      release.tag_name !== plan.tag ||
      !Number.isSafeInteger(release.id) ||
      Number(release.id) <= 0
    ) {
      throw new Error("Read-back did not identify the published prerelease");
    }
    for (let retry = 0; ; retry++) {
      const pending = await pendingReleaseAssets({
        repository,
        releaseId: Number(release.id),
        expected,
        env,
      });
      if (pending.length === 0) {
        return;
      }
      if (retry === 5) {
        throw new Error(
          `Published prerelease assets are missing or still settling: ${pending.join(", ")}`
        );
      }
      await sleep(5000);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${reason}. The release exists at ${plan.tag}. Inspect it and do not re-dispatch the same version.`,
      { cause: error }
    );
  }
}

function env(name: string): string {
  return process.env[name] ?? "";
}

/** HACK_PRERELEASE_PLATFORM for `metadata`: unset, or one bundle platform. */
function platformInput(): BundlePlatform | undefined {
  const value = env("HACK_PRERELEASE_PLATFORM");
  if (!value) {
    return;
  }
  const platform = BUNDLE_PLATFORMS.find((name) => name === value);
  if (platform === undefined) {
    throw new Error(
      `HACK_PRERELEASE_PLATFORM must be one of ${BUNDLE_PLATFORMS.join(", ")}`
    );
  }
  return platform;
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
      `${JSON.stringify(prereleaseMetadata({ version, sourceRevision, platform: platformInput() ?? PRERELEASE_PLATFORM }), null, 2)}\n`
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
    // A release always carries the Linux assets; a macOS-only set is for tests.
    if (!env("HACK_PRERELEASE_LINUX_ASSETS")) {
      throw new Error(
        "Packaging requires HACK_PRERELEASE_LINUX_ASSETS, the directory holding the Linux build jobs' archives and managers"
      );
    }
    await packagePrerelease({
      plan,
      bundle: resolve(env("HACK_PRERELEASE_BUNDLE")),
      output: resolve(env("HACK_PRERELEASE_OUTPUT")),
      linux: resolve(env("HACK_PRERELEASE_LINUX_ASSETS")),
    });
  } else if (mode === "package-linux") {
    const platform = hostBundlePlatform();
    if (platform === null || !composeOnly(platform)) {
      throw new Error("package-linux runs on Linux x86_64 or arm64");
    }
    await packageLinuxPrerelease({
      plan,
      bundle: resolve(env("HACK_PRERELEASE_BUNDLE")),
      output: resolve(env("HACK_PRERELEASE_OUTPUT")),
      platform,
    });
  } else if (mode === "rehearsal-installer") {
    await writeRehearsalInstaller({
      plan,
      output: resolve(env("HACK_PRERELEASE_OUTPUT")),
      directory: resolve(env("HACK_PRERELEASE_REHEARSAL")),
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
      await verifyReleaseAssets({ plan, output, linux: true });
      await createAndVerifyPrerelease({ plan, output });
    }
  } else if (mode !== "plan") {
    throw new Error(
      "Expected plan, metadata, package, package-linux, rehearsal-installer, verify-ci, verify, publish, or stable"
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
