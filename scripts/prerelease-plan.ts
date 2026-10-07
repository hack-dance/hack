#!/usr/bin/env bun
import { appendFile, lstat, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nativeCandidateMcpPayload } from "../src/mcp/candidate-payload.ts";

export const PRERELEASE_ENVIRONMENT = "v5-prerelease";
export const PRERELEASE_PAYLOAD = [
  "hack-native",
  "hack-relay-guest",
  "hack-cli",
  "hack-v5",
  "provider-pins.json",
  "README.md",
  "prerelease.json",
] as const;
export const CONFIG_COMPILER_PAYLOAD = [
  "hack-config-compiler",
  "hack.project.schema.json",
] as const;
const VERSION = /^5\.0\.0-next\.[1-9][0-9]*$/;
const REVISION = /^[0-9a-f]{40}$/;
const STABLE_TAG = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;

export function prereleaseMetadata({
  version,
  sourceRevision,
}: {
  readonly version: string;
  readonly sourceRevision: string;
}) {
  if (!VERSION.test(version) || version.trim() !== version) {
    throw new Error(
      "Version must be 5.0.0-next.N with a positive integer and no leading zeros"
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
    platform: "darwin-arm64",
  } as const;
}

export function createPrereleasePlan({
  version,
  sourceRevision,
  ref,
  eventName,
  channel,
  publish = "false",
}: {
  readonly version: string;
  readonly sourceRevision: string;
  readonly ref: string;
  readonly eventName: string;
  readonly channel: string;
  readonly publish?: string;
}) {
  const metadata = prereleaseMetadata({ version, sourceRevision });
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
    archive: `hack-${version}-darwin-arm64-native.tar.gz`,
    publish: publish === "true",
    environment: PRERELEASE_ENVIRONMENT,
    assets: [
      `hack-${version}-darwin-arm64-native.tar.gz`,
      "prerelease.json",
      "SHA256SUMS",
    ],
  };
}

export type PrereleasePlan = ReturnType<typeof createPrereleasePlan>;

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

const CI_JOBS = [
  "Runtime state models",
  "Candidate core (ubuntu-latest)",
  "Candidate core (macos-latest)",
  "secret-scan",
  "runtime-images",
  "docker-e2e",
  "test",
  "linux-process-lifetime",
] as const;

export function requireExactHeadCi({
  run,
  jobs,
  sourceRevision,
}: {
  readonly run: unknown;
  readonly jobs: unknown;
  readonly sourceRevision: string;
}) {
  const ci = object(run);
  if (
    ci.head_sha !== sourceRevision ||
    ci.head_branch !== "next" ||
    ci.event !== "push" ||
    ci.status !== "completed" ||
    ci.conclusion !== "success" ||
    ci.path !== ".github/workflows/ci.yml"
  ) {
    throw new Error(
      "A successful next push CI run is required on the exact source SHA"
    );
  }
  const completed = array(jobs).map(object);
  for (const name of CI_JOBS) {
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

type Api = (path: string, allowMissing?: boolean) => Promise<unknown>;

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
  const branch = object(await api("branches/next"));
  if (
    branch.protected !== true ||
    object(branch.commit).sha !== plan.source_revision
  ) {
    throw new Error("Source SHA must still be the protected next head");
  }
  const environmentId = requireReviewerProtection(
    await api(`environments/${PRERELEASE_ENVIRONMENT}`)
  );
  const runs = object(
    await api(
      `actions/workflows/ci.yml/runs?branch=next&event=push&head_sha=${plan.source_revision}&per_page=1`
    )
  );
  const run = object(array(runs.workflow_runs)[0]);
  if (typeof run.id !== "number") {
    throw new Error("No exact-head next CI run exists");
  }
  const jobs = await pages({
    api,
    path: `actions/runs/${run.id}/jobs`,
    field: "jobs",
  });
  requireExactHeadCi({ run, jobs, sourceRevision: plan.source_revision });
  await requireBranchChecks({
    api,
    sourceRevision: plan.source_revision,
    branch,
  });
  if (
    (await api(`git/ref/tags/${plan.tag}`, true)) !== null ||
    (await api(`releases/tags/${plan.tag}`, true)) !== null
  ) {
    throw new Error("Refusing to replace an existing tag or release");
  }
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

async function requireBranchChecks({
  api,
  sourceRevision,
  branch,
}: {
  readonly api: Api;
  readonly sourceRevision: string;
  readonly branch: Record<string, unknown>;
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
      path: `commits/${sourceRevision}/check-runs?filter=latest`,
      field: "check_runs",
    })
  ).map(object);
  const statuses = (
    await pages({ api, path: `commits/${sourceRevision}/statuses` })
  ).map(object);
  for (const requirement of requirements) {
    if (
      typeof requirement.context !== "string" ||
      requirement.context.length === 0
    ) {
      throw new Error("Invalid required-check policy");
    }
    const check = checks.find(
      (check) =>
        check.name === requirement.context &&
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
      : requirement.integration_id == null && status?.state === "success";
    if (!success) {
      throw new Error(
        `Required exact-head check did not succeed: ${requirement.context}`
      );
    }
  }
}

async function pages({
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

export async function packagePrerelease({
  plan,
  bundle,
  output,
}: {
  readonly plan: PrereleasePlan;
  readonly bundle: string;
  readonly output: string;
}) {
  if (!(await lstat(bundle)).isDirectory()) {
    throw new Error("Native bundle root must be a directory, not an alias");
  }
  const entries = await readdir(bundle);
  const compilerPayload = CONFIG_COMPILER_PAYLOAD.filter((name) =>
    entries.includes(name)
  );
  if (compilerPayload.length !== 0 && compilerPayload.length !== 2) {
    throw new Error(
      "Native config compiler payload must include both compiler and schema"
    );
  }
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
    if (
      name === "hack-config-compiler" ||
      name === "hack.project.schema.json"
    ) {
      const mode = name === "hack-config-compiler" ? 0o755 : 0o600;
      if ((entry.mode & 0o7777) !== mode) {
        throw new Error(
          `Native config compiler payload has unsafe permissions: ${name}`
        );
      }
    }
  }
  const metadata = prereleaseMetadata({
    version: plan.version,
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
      "Expected exactly the archive, metadata and outer checksum release assets"
    );
  }
  for (const name of plan.assets) {
    const entry = await lstat(join(output, name));
    if (!entry.isFile() || entry.nlink !== 1) {
      throw new Error("Release assets must be regular files");
    }
  }
  const expected = prereleaseMetadata({
    version: plan.version,
    sourceRevision: plan.source_revision,
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

function githubApi(): Api {
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
        `Native macOS ARM64 candidate from ${plan.source_revision}. Requires explicit opt-in; stable installation is unchanged.`,
      ]);
    }
  } else if (mode !== "plan") {
    throw new Error(
      "Expected plan, metadata, package, verify, publish, or stable"
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
