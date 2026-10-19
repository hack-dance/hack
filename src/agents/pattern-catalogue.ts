/**
 * Typed register of the twelve reusable project patterns (HACK-P01..P12)
 * found across Hack consumers, with each card's current disposition.
 *
 * Invariants (enforced by tests/pattern-catalogue.test.ts):
 * - All twelve ids are present exactly once; the register stays complete even
 *   for recipes Hack cannot support yet.
 * - A card that is not `supported` names its domain owner and the missing
 *   contract. Such a disposition never waives the owner's runtime gates.
 * - Every `hack` invocation a card names resolves in CLI_SPEC on this branch.
 * - Unsafe recipes (broad process kills, kill-by-port, placeholder liveness,
 *   secrets in argv) appear only inside negative-example blocks.
 * - A card's `example` directory exists and is statically validated by
 *   tests/pattern-examples.test.ts (config schema, Compose contract, README
 *   commands); every directory under `examples/patterns/` belongs to one card.
 *
 * Consumer names stay in the Linear issues; the shipped reference records
 * only how many consumers a card generalizes from.
 */

/** How far Hack supports a pattern today. */
export type PatternDisposition =
  | "supported"
  | "partial"
  | "retain-as-example"
  | "deferred"
  | "rejected";

/** Where a card's generalization comes from. */
export type PatternProvenance = {
  /** Number of distinct consumer projects that exhibit the pattern. */
  readonly consumers: number;
  /** Research register entry; consumer detail lives in the Linear issue. */
  readonly source: string;
};

export type PatternCard = {
  /** Stable research id, `HACK-P01`..`HACK-P12`. */
  readonly id: string;
  /** Linear issue that tracks the card. */
  readonly linearId: string;
  readonly title: string;
  readonly useWhen: string;
  readonly disposition: PatternDisposition;
  /**
   * `hack` invocations that exist on this CLI and apply to the pattern. For a
   * card that is not `supported`, these cover only the part Hack owns today.
   */
  readonly supportedCommands: readonly string[];
  readonly prerequisites: string;
  readonly envOwnership: string;
  readonly readiness: string;
  readonly cleanup: string;
  /** What looks like success but is not; rendered as a negative example. */
  readonly negativeControl: string;
  /** Work unit(s) that own the runtime mechanism. */
  readonly domainOwner: string;
  /** Contract Hack still lacks; `null` only for `supported` cards. */
  readonly missingContract: string | null;
  readonly provenance: PatternProvenance;
  /**
   * Repository-relative directory of a static example project that realizes
   * the supported part of the card, or `null` when none exists. Contributor
   * reference only: it is not rendered into the packaged reference because the
   * plugin ships without the repository's `examples/` tree.
   */
  readonly example: string | null;
};

/** The complete pattern register, in id order. */
export const PATTERN_CATALOGUE: readonly PatternCard[] = [
  {
    id: "HACK-P01",
    linearId: "HACK-1145",
    title: "One-shot dependency and generated-artifact bootstrap",
    useWhen:
      "Services need installed dependencies or generated artifacts before the application starts.",
    disposition: "partial",
    supportedCommands: [
      "hack up --json",
      "hack ps --json",
      "hack logs --no-follow --tail 100",
    ],
    prerequisites:
      "A Compose initializer service that consumers require through `service_completed_successfully`; for the opt-in `hack.dependencies.cache-protocol: locked-v1` label, a pinned installer image and an immutable dependency payload.",
    envOwnership:
      "locked-v1 runs the initializer and verifier with a clean environment and refuses explicit `environment`/`env_file`; credential- or env-dependent installers keep their existing setup.",
    readiness:
      "Installation, generated-artifact publication and application readiness are separate steps. Completion is the initializer's successful exit plus its verifier, not a populated cache.",
    cleanup:
      "Ordinary `hack down` keeps dependency volumes. Keep worktree-specific generated output in its own always-run step and directory.",
    negativeControl:
      "A populated cache directory is not a completion marker. Concurrent writers to one volume and failed publication need ownership and recovery; consumers must see a complete old or complete new artifact.",
    domainOwner: "WU07/WU11",
    missingContract:
      "locked-v1 covers one immutable payload per volume. Atomic publication of worktree-specific generated artifacts, env-dependent installers, and two-worktree or interrupted-writer qualification remain open.",
    provenance: { consumers: 4, source: "HACK-P01 research register" },
    example: "examples/patterns/p01-dependency-bootstrap",
  },
  {
    id: "HACK-P02",
    linearId: "HACK-1146",
    title: "Portable toolchain without an always-on application",
    useWhen:
      "Checks, builds or tests need pinned tools in a container, but the project has no long-running app to start.",
    disposition: "partial",
    supportedCommands: ["hack run --profile <profile> <service> -- <cmd...>"],
    prerequisites:
      "A one-shot Compose service behind an opt-in profile with pinned tool versions, explicit resource bounds and separate named volumes for reusable build caches.",
    envOwnership:
      "Mount no Docker socket, user home, SSH agent or credential directory; keep project secrets out of the image build context.",
    readiness:
      "The task's own exit status is the result. Check the `hack run` exit status directly, not through a pipe filter, so a failed check stays a failure.",
    cleanup:
      "The service is one-shot. Caches live in named volumes that `hack down` preserves; a source-identity override used for tests must not reach release evidence.",
    negativeControl:
      "A test-only source identity override must not escape into release evidence, and a linked worktree's Git pointer needs deliberate handling rather than an assumed `.git` directory.",
    domainOwner: "WU11",
    missingContract:
      "Cross-worktree cache reuse with bounded eviction, a source receipt for linked worktrees, and owned cache accounting remain open.",
    provenance: { consumers: 4, source: "HACK-P02 research register" },
    example: "examples/patterns/p02-portable-toolchain",
  },
  {
    id: "HACK-P03",
    linearId: "HACK-1147",
    title: "Cloud prerequisite preflight",
    useWhen:
      "Startup depends on cloud credentials or tokens that may be missing, expired or scoped wrongly.",
    disposition: "partial",
    supportedCommands: [
      "hack doctor --json",
      "hack env explain <key> --json",
      "hack env explain <key> --target compose --json",
    ],
    prerequisites:
      "Required key names declared in Hack env; the credential tool and its native sign-in owned by the user.",
    envOwnership:
      "Report key names, winning source and repair direction, never values. Check the container view separately from the host view.",
    readiness:
      "Preflight runs before startup and fails with the missing name; a present value is not proof that it is valid or unexpired.",
    cleanup: "Preflight starts nothing and leaves no state.",
    negativeControl:
      "A token on the host does not prove the container receives it, and a headless runner cannot depend on interactive browser sign-in.",
    domainOwner: "WU27",
    missingContract:
      "Hack has no credential availability, expiry or scope check and no machine-identity path for headless runners; the WU27 env contract owns both.",
    provenance: { consumers: 3, source: "HACK-P03 research register" },
    example: null,
  },
  {
    id: "HACK-P04",
    linearId: "HACK-1148",
    title: "Shared host service with identity-aware adoption",
    useWhen:
      "Several projects or branches share a host helper such as a session issuer or local proxy.",
    disposition: "retain-as-example",
    supportedCommands: ["hack up --json", "hack logs --no-follow --tail 100"],
    prerequisites:
      'A lifecycle process with `singleton` ports. Hack adopts an existing helper only when every configured port is occupied and the config opts into `onConflict: "adopt"`.',
    envOwnership:
      "The helper's credentials stay with its owner; adoption must not forward broad host env.",
    readiness:
      "Pair adoption with a `lifecycle.up.before` hook that checks the listener's identity and expected upstream and fails on mismatch.",
    cleanup:
      "Hack stops only processes it started; an adopted helper is not Hack-owned and is never stopped by Hack.",
    negativeControl:
      "Port-only reuse can attach to a foreign service. Process liveness or a placeholder process is not readiness, and no foreign process may be killed to free a port.",
    domainOwner: "WU29",
    missingContract:
      "Today's adoption is port-only. Health- and upstream-checked adoption with a recorded adopted-versus-owned state is the WU29 lifecycle ownership contract.",
    provenance: { consumers: 1, source: "HACK-P04 research register" },
    example: null,
  },
  {
    id: "HACK-P05",
    linearId: "HACK-1149",
    title: "Branch-owned external routing claim",
    useWhen:
      "A branch needs an external route or callback claim tied to its own instance.",
    disposition: "deferred",
    supportedCommands: [],
    prerequisites:
      "Explicit project and branch identity for the claim; no recipe is published until the contract exists.",
    envOwnership:
      "Claim credentials stay host-scoped and are not written into tracked files.",
    readiness:
      "A claim must be a bounded, observable operation with a retry budget.",
    cleanup: "Release only the claim and process group that this branch owns.",
    negativeControl:
      "The observed consumer uses a fixed default URL, unbounded retry and broad name-based cleanup. Retain it as a negative example, not a copyable recipe.",
    domainOwner: "WU29",
    missingContract:
      "Hack has no branch-scoped external claim/release contract with bounded retry, stop-during-retry and PID-reuse safety.",
    provenance: { consumers: 1, source: "HACK-P05 research register" },
    example: null,
  },
  {
    id: "HACK-P06",
    linearId: "HACK-1150",
    title: "Opt-in public tunnel with end-to-end readiness",
    useWhen:
      "A developer occasionally needs the local application reachable from the public internet.",
    disposition: "deferred",
    supportedCommands: [],
    prerequisites:
      "Default off; host-scoped tunnel credentials, the tunnel tool and the intended CA.",
    envOwnership:
      "Pass only the tunnel's own credential; never forward broad host env.",
    readiness:
      "Probe the exposed application route end to end; a missing credential, tool or CA fails clearly.",
    cleanup:
      "Shutdown leaves no owned tunnel child; disabled mode starts no tunnel.",
    negativeControl:
      "A running tunnel process or open TCP listener alone does not prove the external route reaches the right upstream.",
    domainOwner: "WU29",
    missingContract:
      "Hack has no opt-in tunnel lifecycle with external-route readiness and owned-child shutdown.",
    provenance: { consumers: 1, source: "HACK-P06 research register" },
    example: null,
  },
  {
    id: "HACK-P07",
    linearId: "HACK-1151",
    title: "Laptop and headless-runner capability overlays",
    useWhen:
      "The same application topology runs on a laptop and on a headless runner with different auth, network or helpers.",
    disposition: "partial",
    supportedCommands: [
      "hack env explain <key> --env <overlay> --json",
      "hack env explain <key> --env <overlay> --target compose --json",
      "hack up --env <overlay> --json",
    ],
    prerequisites:
      "One shared Compose topology; env overlays that express only the auth, network and helper differences.",
    envOwnership:
      "Overlays own the differences; inspect the effective value source per target instead of reading host env.",
    readiness:
      "Verify container metadata and dependency reachability on each target; the runner must not need browser sign-in.",
    cleanup:
      "Overlays add no state of their own; inherited worktree overrides must be visible and deliberate.",
    negativeControl:
      "Do not change locality flags just to bypass a readiness check. Host env is not evidence of container delivery.",
    domainOwner: "WU27/WU30",
    missingContract:
      "Hack has env overlays and value-free inspection but no laptop/headless capability contract or headless machine identity; WU27 and WU30 own them.",
    provenance: { consumers: 1, source: "HACK-P07 research register" },
    example: null,
  },
  {
    id: "HACK-P08",
    linearId: "HACK-1152",
    title: "Tracked defaults plus idempotent machine-local hydration",
    useWhen:
      "A repository tracks env defaults and each machine adds local values on top.",
    disposition: "partial",
    supportedCommands: [
      "hack env hydrate --file <path> --secret",
      "hack env set <key> --local --value-stdin --secret",
      "hack env explain <key> --json",
    ],
    prerequisites:
      "Tracked defaults, a machine-local layer and preserved operator overrides.",
    envOwnership:
      "Defaults are tracked; `hack env hydrate --secret` reads `KEY=value` entries from piped stdin or `--file` and writes only the gitignored machine-local layer, so values stay out of argv and out of tracked files. Local entries outside the input are kept.",
    readiness:
      "A repeat import with the same values does not rewrite the layer; a changed value gets new ciphertext with a fresh IV. One rename commits all keys, so an interrupted import leaves every key at its previous value. A wrong key, a tracked local layer or a concurrent hydration refuses without changing the layer.",
    cleanup:
      "Unchanged values cause no rewrite. A killed import can leave a staging file and a stale `.hack/.internal/env-hydrate.lock`; the next import reports the lock instead of taking it over.",
    negativeControl:
      "Re-encrypting unchanged entries causes diff and stash churn, and values passed in command arguments are not a secure import mechanism.",
    domainOwner: "WU27/WU14",
    missingContract:
      "Hydration replaces an imported key's local entry; it cannot tell an operator's deliberate local override of that key from a stale hydrated value. `hack env set --local` does not take the hydration lock, so only a recheck just before the rename guards against it.",
    provenance: { consumers: 1, source: "HACK-P08 research register" },
    example: null,
  },
  {
    id: "HACK-P09",
    linearId: "HACK-1153",
    title: "Disposable run workspaces with reference-aware retention",
    useWhen:
      "Runs or branches create workspaces and caches that should be reclaimed once nothing uses them.",
    disposition: "partial",
    supportedCommands: [
      "hack down --prune-caches",
      "hack branch remove <name>",
      "hack projects prune --dry-run",
    ],
    prerequisites:
      'Explicitly disposable cache volumes (`hack.cache.disposable: "true"` or Next.js build output) and a reviewed dry run before pruning.',
    envOwnership: "Reclamation reads no env values.",
    readiness: "Not applicable; retention is a cleanup contract.",
    cleanup:
      "`--prune-caches` is confirmation-gated and removes only exact, project-owned disposable volumes; sessions and application data keep their own retention.",
    negativeControl:
      "Stopped or Docker-reclaimable does not mean disposable. Active, pending, held or unknown resources must survive.",
    domainOwner: "WU12/WU30",
    missingContract:
      "Generation/run ownership, active references, holds and interrupted-reclamation recovery are not implemented for run workspaces.",
    provenance: { consumers: 1, source: "HACK-P09 research register" },
    example: null,
  },
  {
    id: "HACK-P10",
    linearId: "HACK-1154",
    title: "Pinned tool image plus independent dependency caches",
    useWhen:
      "A runner or toolchain image must stay pinned while application dependencies and credentials vary.",
    disposition: "partial",
    supportedCommands: [
      "hack run --profile <profile> <service> -- <cmd...>",
      "hack up --json",
    ],
    prerequisites:
      "Tool manifests pinned in the image; application dependencies in separate cache volumes; credentials outside both.",
    envOwnership:
      "Credentials are injected at run time and never baked into the tool image or caches.",
    readiness:
      "Each run reports which stage ran; a changed lockfile or tool pin rebuilds through the same command.",
    cleanup:
      "Tool images and dependency caches are retained; prune only explicitly disposable caches.",
    negativeControl:
      "Code that has landed is not an enabled, verified deployment, and a cache hit does not prove the installer was skipped.",
    domainOwner: "WU30",
    missingContract:
      "Hack does not yet distinguish L1, L2 and cold misses, detect a tampered cache, or emit stage timing and provenance receipts.",
    provenance: { consumers: 3, source: "HACK-P10 research register" },
    example: null,
  },
  {
    id: "HACK-P11",
    linearId: "HACK-1155",
    title: "Stable agent guidance and typed operation results",
    useWhen:
      "Agents run project workflows and need versioned guidance plus machine-readable results.",
    disposition: "partial",
    supportedCommands: [
      "hack up --json",
      "hack down --json",
      "hack restart --json",
      "hack doctor --json",
      "hack run <service> -- <cmd...>",
    ],
    prerequisites:
      "Generated guidance from Hack's canonical source with a content revision; `--json` on lifecycle and diagnostic commands.",
    envOwnership: "Results report names and states, not values.",
    readiness:
      "Pass child argv after `--` in `hack run <service> -- <cmd...>`. Check the exit status or `--json` envelope directly rather than through a pipe filter.",
    cleanup:
      "Guidance updates are explicit `hack setup` operations, never side effects of ordinary commands.",
    negativeControl:
      "Filtered shell text can hide a failed child, and historical dispatch, PR or gateway requests must not silently expand current product scope.",
    domainOwner: "WU19/WU21",
    missingContract:
      "A guidance freeze during execution and a typed terminal result for resumed background operations remain open.",
    provenance: { consumers: 2, source: "HACK-P11 research register" },
    example: null,
  },
  {
    id: "HACK-P12",
    linearId: "HACK-1156",
    title: "Multi-lane admission and durable run provenance",
    useWhen:
      "Several heavy runs compete for scarce resources and need queued admission with durable ownership.",
    disposition: "deferred",
    supportedCommands: [],
    prerequisites:
      "Separate job admission, scarce-resource leases and project-registry operations.",
    envOwnership: "Admission and provenance records hold no env values.",
    readiness:
      "Report queue time separately from execution time with the exact workload.",
    cleanup:
      "Cancellation and worker restart must not duplicate ownership or lose a continuation.",
    negativeControl:
      "A global registry lock is not a workload scheduler, and idle host, idle lane and idle application are different signals.",
    domainOwner: "WU13/WU04",
    missingContract:
      "Hack has no multi-lane admission, lease or durable run-provenance contract.",
    provenance: { consumers: 2, source: "HACK-P12 research register" },
    example: null,
  },
];

/** Markers that delimit negative examples in the rendered catalogue. */
export const NEGATIVE_EXAMPLE_START = "<!-- negative-example -->";
export const NEGATIVE_EXAMPLE_END = "<!-- /negative-example -->";

const DISPOSITION_LABELS: Readonly<Record<PatternDisposition, string>> = {
  supported: "Supported",
  partial: "Partial",
  "retain-as-example": "Retained as example",
  deferred: "Deferred",
  rejected: "Rejected",
};

/** Render the catalogue as the packaged `hack-cli` reference. */
export function renderPatternCatalogue(): string {
  const lines = [
    "# Hack pattern catalogue",
    "",
    "Reusable patterns observed across Hack projects, with what Hack supports today.",
    "Use a card's commands only within its disposition. A partial, retained, deferred",
    "or rejected card names the missing contract and its owner; do not improvise the",
    "missing part with ad hoc scripts.",
    "",
    "| Id | Pattern | Disposition | Owner |",
    "| --- | --- | --- | --- |",
    ...PATTERN_CATALOGUE.map(
      (card) =>
        `| ${card.id} | ${card.title} | ${DISPOSITION_LABELS[card.disposition]} | ${card.domainOwner} |`
    ),
    "",
    ...PATTERN_CATALOGUE.flatMap((card) => renderCard(card)),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderCard(card: PatternCard): string[] {
  const commands =
    card.supportedCommands.length === 0
      ? "none yet; do not substitute a hand-written recipe."
      : card.supportedCommands.map((command) => `\`${command}\``).join(", ");
  const consumers =
    card.provenance.consumers === 1
      ? "single-consumer generalization"
      : `${card.provenance.consumers} consumers`;
  const disposition =
    card.missingContract === null
      ? DISPOSITION_LABELS[card.disposition]
      : `${DISPOSITION_LABELS[card.disposition]}. Missing: ${card.missingContract}`;
  return [
    `## ${card.id}: ${card.title}`,
    "",
    `- Use when: ${card.useWhen}`,
    `- Disposition: ${disposition}`,
    `- Owner: ${card.domainOwner}; tracked in ${card.linearId}.`,
    `- Commands: ${commands}`,
    `- Prerequisites: ${card.prerequisites}`,
    `- Env ownership: ${card.envOwnership}`,
    `- Readiness: ${card.readiness}`,
    `- Cleanup: ${card.cleanup}`,
    `- Provenance: ${consumers} (${card.provenance.source}).`,
    "",
    NEGATIVE_EXAMPLE_START,
    `> Negative control: ${card.negativeControl}`,
    NEGATIVE_EXAMPLE_END,
    "",
  ];
}
