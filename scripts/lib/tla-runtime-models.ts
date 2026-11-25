import { verifyFiniteModelResult } from "./tla-result.ts";

type ModelResult = {
  readonly negative: boolean;
  readonly exitCode: number | null;
  readonly output: string;
};
type WitnessFields = readonly string[];
type ModelContract = {
  readonly name: string;
  readonly module: string;
  readonly negativeModule?: string;
  readonly states: number;
  readonly invariant: string;
  readonly fields: WitnessFields;
  readonly alternativeWitnesses?: readonly WitnessFields[];
  readonly additionalControls?: readonly {
    readonly name: string;
    readonly module?: "TerminalReuse" | "MetadataAliasing" | "PreReady";
    readonly negative: boolean;
    readonly states?: number;
    readonly invariant?: string;
    readonly fields?: WitnessFields;
    readonly alternativeWitnesses?: readonly WitnessFields[];
  }[];
};

// The two runtime-service clients are symmetric, so a control may show either
// one as the client that breaks the invariant.
type Client = "c1" | "c2";
type ClientFields = (me: Client) => readonly string[];
function pairOf(
  variable: string,
  me: Client,
  mine: string,
  theirs: string
): string {
  const [first, second] = me === "c1" ? [mine, theirs] : [theirs, mine];
  return `${variable} = (c1 :> ${first} @@ c2 :> ${second})`;
}
function runtimeServiceEither(first: ClientFields, ...others: ClientFields[]) {
  return {
    fields: first("c1"),
    alternativeWitnesses: [
      first("c2"),
      ...others.flatMap((fields) => [fields("c1"), fields("c2")]),
    ],
  };
}

// Bounds and witnesses are reviewed contracts, not learned from each run.
const laterIncompleteMissingLockStages = [
  "temp",
  "linked",
  "final",
  "journal",
  "socket",
  "owner",
] as const;
const stoppedHttpsWitnessFields = [
  'pool = "stopped"',
  'run = "retained"',
  "fin = TRUE",
  'https = "records"',
  'port = "free"',
  "pub = FALSE",
] as const;
const unconfirmedRefreshReplayFields = [
  "replayed = TRUE",
  "unconfirmed = TRUE",
  "closed = FALSE",
  'journal = "none"',
] as const;
// TLC's two-worker search does not always report the shortest trace: a deeper
// first violation can be checked first. Each multi-root-share control therefore
// accepts exactly the first violations its model can reach, as complete states
// (graph a/b, bound a/b, recordSet, ownerSet, mounted, journal op/p, phase; a set
// is written as its sorted members). The lists were enumerated from each control's
// complete state graph restricted to steps from states that still satisfy the
// invariant. The first entry is the shortest witness.
type SharesFirstViolation = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];
const sharesSet = (members: string): string =>
  `{${[...members].map((member) => `"${member}"`).join(", ")}}`;
const sharesFields = ([
  graphA,
  graphB,
  boundA,
  boundB,
  recordSet,
  ownerSet,
  mounted,
  op,
  p,
  phase,
]: SharesFirstViolation): readonly string[] => [
  `graph = [a |-> "${graphA}", b |-> "${graphB}"]`,
  `recordSet = ${sharesSet(recordSet)}`,
  `journal = [op |-> "${op}", p |-> "${p}"]`,
  `bound = [a |-> "${boundA}", b |-> "${boundB}"]`,
  `phase = "${phase}"`,
  `mounted = ${sharesSet(mounted)}`,
  `ownerSet = ${sharesSet(ownerSet)}`,
];
const sharesWitnesses = ([first, ...others]: readonly [
  SharesFirstViolation,
  ...SharesFirstViolation[],
]) => ({
  fields: sharesFields(first),
  alternativeWitnesses: others.map(sharesFields),
});
const sharesOwnShareViolations = [
  ["none", "live", "none", "a", "a", "a", "a", "idle", "a", "running"],
  ["live", "live", "a", "a", "ab", "ab", "ab", "idle", "a", "running"],
  ["live", "live", "b", "b", "ab", "ab", "ab", "idle", "a", "running"],
  ["live", "live", "a", "a", "a", "a", "a", "idle", "a", "running"],
  ["live", "none", "b", "none", "ab", "ab", "ab", "idle", "a", "running"],
  ["live", "retained", "b", "b", "ab", "ab", "ab", "idle", "a", "running"],
  ["none", "live", "none", "a", "ab", "ab", "ab", "idle", "a", "running"],
  ["retained", "live", "a", "a", "ab", "ab", "ab", "idle", "a", "running"],
  ["retained", "live", "a", "a", "a", "a", "a", "idle", "a", "running"],
] as const;
const sharesUnfencedBootViolations = [
  ["none", "none", "none", "none", "a", "a", "a", "add", "b", "running"],
  ["none", "none", "none", "none", "ab", "ab", "ab", "add", "b", "running"],
  ["none", "none", "none", "none", "ab", "a", "ab", "add", "b", "running"],
  ["none", "none", "none", "none", "ab", "ab", "ab", "remove", "b", "running"],
  ["none", "none", "none", "none", "a", "ab", "a", "remove", "b", "running"],
  ["none", "none", "none", "none", "a", "a", "a", "remove", "b", "running"],
  ["retained", "none", "a", "none", "ab", "ab", "ab", "add", "b", "running"],
  ["retained", "none", "a", "none", "ab", "a", "ab", "add", "b", "running"],
  ["retained", "none", "a", "none", "ab", "ab", "ab", "remove", "b", "running"],
  ["retained", "none", "a", "none", "a", "a", "a", "add", "b", "running"],
  ["retained", "none", "a", "none", "a", "ab", "a", "remove", "b", "running"],
  ["retained", "none", "a", "none", "a", "a", "a", "remove", "b", "running"],
] as const;
const sharesOwnerFirstViolations = [
  ["none", "none", "none", "none", "a", "ab", "", "add", "b", "stopped"],
  ["none", "none", "none", "none", "ab", "a", "", "remove", "b", "stopped"],
  ["retained", "none", "a", "none", "ab", "a", "", "remove", "b", "stopped"],
  ["retained", "none", "a", "none", "a", "ab", "", "add", "b", "stopped"],
] as const;
const sharesReferencedRemovalViolations = [
  ["none", "retained", "none", "b", "a", "ab", "", "remove", "b", "stopped"],
  ["retained", "retained", "a", "b", "a", "ab", "", "remove", "b", "stopped"],
] as const;
// TLC's two-worker search does not always report the shortest trace, so the
// restart-policy controls accept every first violation the model can reach.
// A stale use is a bound incarnation that is older than the current one, or
// equal to it while the engine is no longer running.
const restartPolicyStaleUses = [
  { engine: "restarting", bound: 1 },
  { engine: "exited", bound: 1 },
  { engine: "running", bound: 1 },
  { engine: "restarting", bound: 2 },
  { engine: "exited", bound: 2 },
  { engine: "running", bound: 2 },
  { engine: "restarting", bound: 3 },
  { engine: "exited", bound: 3 },
] as const;
// StartGraph's ghost flags: the whole record names every unsafe step taken,
// so a control cannot pass on a violation its guard removal did not cause.
type StartGraphFlag = "start" | "publish" | "replace" | "return";
const startGraphBad = (...flags: readonly StartGraphFlag[]): string =>
  `bad = [${(["start", "publish", "replace", "return"] as const)
    .map((key) => `${key} |-> ${flags.includes(key) ? "TRUE" : "FALSE"}`)
    .join(", ")}]`;
const contracts: readonly ModelContract[] = [
  {
    name: "native-pool-layout",
    module: "PoolLayout",
    states: 38,
    invariant: "LayoutPreserved",
    fields: ['owner = "legacy"', 'initial = "compact"', "refused = TRUE"],
  },
  {
    name: "project-remote-selection",
    module: "ProjectRemoteSelection",
    states: 11,
    invariant: "TeardownUsesStartedTarget",
    fields: ['hook = "pending"', 'started = "none"', 'record = "none"'],
    additionalControls: [
      {
        name: "stale-negative",
        negative: true,
        invariant: "ActiveLabelWins",
        fields: ["stale = TRUE", 'label = "qa"', 'hook = "none"'],
      },
    ],
  },
  {
    name: "guest-execution",
    module: "GuestAgent",
    states: 6860,
    invariant: "ResultBeforeRelease",
    fields: ['job = "released"', 'saved = "none"'],
    additionalControls: [
      {
        name: "unclean-restart",
        negative: true,
        invariant: "NoOrphan",
        fields: ['agent = "online"', "survivor = TRUE", "epoch = 1"],
      },
      {
        name: "wait-eof",
        negative: true,
        invariant: "TerminalReleasable",
        fields: ['job = "exit37"', 'saved = "exit37"', "writerOpen = TRUE"],
      },
      {
        name: "duplicate",
        negative: true,
        invariant: "StartedOnce",
        fields: ["starts = <<2, 0>>", "id = 1"],
      },
      {
        name: "record-running",
        negative: true,
        invariant: "SavedOutcome",
        fields: ['belief = "running"', 'saved = "running"'],
      },
    ],
  },
  {
    name: "project-prerequisites",
    module: "ProjectPrerequisites",
    states: 13,
    invariant: "CheckedBeforeHooks",
    fields: ['phase = "allowed"', "checked = FALSE", "loggedIn = TRUE"],
  },
  {
    name: "autostart-start-stop",
    module: "StartStop",
    states: 41,
    invariant: "NoStartAfterSuccessfulDown",
    fields: [
      'holder = "none"',
      "paused = TRUE",
      'child = "started"',
      "running = TRUE",
      'down = "done"',
      "lateStart = TRUE",
    ],
  },
  {
    name: "lifecycle-controller",
    module: "LifecycleController",
    states: 21,
    invariant: "NoAdoptedStop",
    fields: [
      "unsafeStop = TRUE",
      "epoch = 2",
      "creatorEpoch = 1",
      "adopted = TRUE",
      'stage = "Aborted"',
    ],
    additionalControls: [
      {
        name: "pending",
        negative: true,
        invariant: "DurableBeforeLaunch",
        fields: [
          "unsafeLaunch = TRUE",
          "pending = FALSE",
          "live = TRUE",
          'stage = "AwaitReply"',
        ],
      },
    ],
  },
  {
    name: "lifecycle-supervisor",
    module: "LifecycleSupervisor",
    states: 426,
    invariant: "NoDuplicate",
    fields: ["duplicate = TRUE", "live = TRUE", "durable = TRUE"],
    additionalControls: [
      {
        name: "sid-reuse",
        negative: true,
        invariant: "NoForeignSignal",
        fields: [
          'identity = "sid-reused"',
          "unsafeSignal = TRUE",
          "guard = FALSE",
        ],
      },
      {
        name: "witness-loss",
        negative: true,
        invariant: "RecoveryAuthorityRetained",
        fields: ["snapshot = FALSE", "witness = FALSE", "live = TRUE"],
      },
    ],
  },
  {
    name: "env-migration",
    module: "Migration",
    states: 74,
    invariant: "NoSameRunCleanup",
    fields: [
      'phase = "apply"',
      "legacy = FALSE",
      "snapshot = TRUE",
      "separate = FALSE",
      "published = 0",
      "recorded = 0",
      "complete = FALSE",
      "runProof = FALSE",
    ],
    additionalControls: [
      {
        name: "stale-repair-proof",
        negative: true,
        invariant: "FreshRunProof",
        fields: [
          'phase = "apply"',
          "complete = FALSE",
          "runProof = TRUE",
          "snapshot = TRUE",
          "legacy = TRUE",
          "deferred = FALSE",
        ],
      },
    ],
  },
  {
    // HACK-2188: without resume, a rerun refuses a restore that was only
    // interrupted after moving the step's output aside.
    name: "upgrade-restore",
    module: "Restore",
    states: 613,
    invariant: "InterruptedRestoreResumes",
    fields: [
      'target = "none"',
      'aside = <<"S">>',
      'outcome = "conflict"',
      'phase = "idle"',
      "force = FALSE",
    ],
    additionalControls: [
      {
        // Review of HACK-2188: when a completed restore keeps the step
        // output keyed, a plain rerun after the user deletes the restored
        // file adopts it and recreates the path without overwrite.
        name: "kept-keys",
        negative: true,
        invariant: "DeletionKept",
        fields: [
          "emptied = TRUE",
          'outcome = "restored"',
          "force = FALSE",
          'aside = <<"S">>',
          "consumed = 0",
        ],
      },
    ],
  },
  {
    name: "interactive-session",
    module: "Session",
    states: 459,
    invariant: "NoReplay",
    fields: [
      'stage = "started"',
      "starts = 2",
      "recorded = TRUE",
      "intent = TRUE",
      "capable = FALSE",
    ],
    additionalControls: [
      {
        name: "failed-inspect",
        negative: true,
        invariant: "RetiredWithProof",
        fields: [
          'stage = "retired"',
          "inspectFailed = TRUE",
          "exitedValidated = FALSE",
          "stopped = FALSE",
          "absent = FALSE",
        ],
      },

      {
        name: "eof-retirement",
        negative: true,
        invariant: "RetiredWithProof",
        fields: [
          'stage = "retired"',
          "ended = TRUE",
          "stopped = FALSE",
          "absent = FALSE",
        ],
      },
      {
        name: "wrong-boot",
        negative: true,
        invariant: "RetiredWithProof",
        fields: [
          'stage = "retired"',
          'boot = "replacement"',
          "replacementStopped = TRUE",
          "stopped = FALSE",
          "absent = FALSE",
        ],
      },
    ],
  },
  {
    name: "interactive-envelope",
    module: "Envelope",
    states: 15,
    invariant: "NoRestoreOverPrivate",
    fields: ['stage = "failed"', "pending = 2", "echo = TRUE", "ack = FALSE"],
    alternativeWitnesses: [
      ['stage = "failed"', "pending = 1", "echo = TRUE", "ack = FALSE"],
    ],
  },
  {
    name: "shutdown-rebase",
    module: "ShutdownRebase",
    states: 43,
    invariant: "StopAdmitted",
    fields: ['phase = "running"', "archived = TRUE"],
    additionalControls: [
      {
        name: "absence",
        negative: true,
        invariant: "NoUnprovenPrune",
        fields: ["unsafePrune = TRUE", 'phase = "repaired"'],
      },
    ],
  },
  {
    name: "shutdown-receipt",
    module: "ShutdownReceipt",
    states: 16,
    invariant: "CleanupAdmitsRestore",
    fields: [
      'phase = "Refused"',
      'receiptId = "none"',
      'shutdownId = "original"',
      'compute = "absent"',
    ],
    additionalControls: [
      {
        name: "reachability",
        negative: true,
        invariant: "NeverRestored",
        fields: [
          'phase = "Restored"',
          'receiptId = "original"',
          'shutdownId = "original"',
          'compute = "absent"',
        ],
      },
    ],
  },
  {
    name: "native-plan-reconcile",
    module: "Reconcile",
    states: 747_656,
    invariant: "NoForeignAttach",
    fields: ["foreignAttach = TRUE", "unrecordedAttach = FALSE"],
    additionalControls: [
      {
        name: "replacement",
        negative: true,
        invariant: "AttachSelected",
        fields: ["unrecordedAttach = TRUE", "foreignAttach = FALSE"],
      },
      {
        name: "drop-orphans",
        negative: true,
        invariant: "RetainedDataRecorded",
        fields: ["lostData = TRUE", "foreignAttach = FALSE"],
      },
    ],
  },
  {
    name: "native-cache-reconcile",
    module: "CacheReconcile",
    states: 2208,
    invariant: "UnrelatedEditKeepsCache",
    fields: ["needlessRebuild = TRUE", "staleMounted = FALSE"],
    additionalControls: [
      {
        name: "stale",
        negative: true,
        invariant: "CacheMatchesInputs",
        fields: ["staleMounted = TRUE", "needlessRebuild = FALSE"],
      },
      {
        name: "data-as-cache",
        negative: true,
        invariant: "NoDataAsCache",
        fields: ["dataMounted = TRUE", "staleMounted = FALSE"],
      },
      {
        name: "poison",
        negative: true,
        invariant: "NoForeignWrites",
        fields: ["foreignMounted = TRUE", "staleMounted = FALSE"],
      },
    ],
  },
  {
    name: "pre-ready-retirement",
    module: "Retirement",
    states: 10_965,
    invariant: "Safe",
    fields: ["unsafeSettlement = TRUE", "stopRequested = TRUE"],
    additionalControls: [
      {
        name: "unproved-removal",
        negative: true,
        fields: ["unsafeRemoval = TRUE", "stopRequested = TRUE"],
      },
      {
        name: "stale-inputs",
        negative: true,
        fields: ["unsafeFreshness = TRUE", "stopRequested = TRUE"],
      },
      {
        name: "foreign-session",
        negative: true,
        fields: ["unsafeSession = TRUE", "stopRequested = TRUE"],
      },
      {
        name: "stale-claim",
        negative: true,
        fields: ["unsafeClaim = TRUE", "stopRequested = TRUE"],
      },
      {
        name: "unconfirmed-host-exit",
        negative: true,
        fields: ["unsafeRetire = TRUE", "retired = TRUE"],
      },
      { name: "liveness", negative: false, states: 395 },
    ],
  },
  {
    name: "native-persistent-enrollment",
    module: "Enrollment",
    states: 38,
    invariant: "NoExistingAdoption",
    fields: ['phase = "created"', "volume = 2", "unsafeAdoption = TRUE"],
    additionalControls: [
      {
        name: "metadata-alias",
        module: "MetadataAliasing",
        negative: true,
        invariant: "NoAliasedMatch",
        fields: [
          "actualVolume = 2",
          "reportedMetadata = 1",
          "capturedMetadata = 1",
          "witness = 0",
          "expectedWitness = 1",
          "matched = TRUE",
        ],
      },
      {
        name: "wrong-birth",
        negative: true,
        invariant: "OriginalBirthAtCommit",
        fields: ["captured = 1", "volume = 2", "unsafeCommit = TRUE"],
        alternativeWitnesses: [
          ["captured = 2", "volume = 2", "unsafeCommit = TRUE"],
        ],
      },
      {
        name: "pending-read",
        negative: true,
        invariant: "NoPendingMatch",
        fields: ['record = "pending"', "matched = TRUE", "unsafeRead = TRUE"],
      },
      {
        name: "retire-data",
        negative: true,
        invariant: "RetirementPreservesData",
        fields: ["run = 2", "volume = 0", "unsafeRetirement = TRUE"],
      },
    ],
  },
  {
    name: "native-frontend-recovery",
    module: "Recovery",
    states: 1752,
    invariant: "NoUnreservedPromotion",
    fields: [
      "unsafePromotion = TRUE",
      'stage = "promoted"',
      "savedNext = 0",
      "pending = 0",
    ],
    additionalControls: [
      {
        name: "pre-ready-positive",
        module: "PreReady",
        negative: false,
        states: 160,
      },
      {
        name: "pre-ready-negative",
        module: "PreReady",
        negative: true,
        invariant: "OnlySettledCleanup",
        fields: ["unsafeCleanup = TRUE", "intent = TRUE", "removed = TRUE"],
      },
      {
        name: "pre-ready-release",
        module: "PreReady",
        negative: true,
        invariant: "ReleaseRecorded",
        fields: ["unsafeRelease = TRUE", "release = FALSE", 'owner = "none"'],
      },
      {
        name: "pre-ready-replay",
        module: "PreReady",
        negative: true,
        invariant: "NoReplay",
        fields: [
          "starts = 2",
          "intent = TRUE",
          "complete = FALSE",
          "files = FALSE",
        ],
      },
      {
        name: "live-launcher-recovery",
        negative: true,
        invariant: "NoLiveLauncherRecovery",
        fields: [
          'launcherRecovery = "unsafe"',
          "launcherAlive = FALSE",
          "alive = TRUE",
        ],
      },
      {
        name: "live-launcher-refusal-reachable",
        negative: true,
        invariant: "NeverLiveLauncherRefusal",
        fields: [
          'launcherRecovery = "refused"',
          "launcherAlive = FALSE",
          "alive = TRUE",
        ],
      },
      {
        name: "uncommitted-release",
        negative: true,
        invariant: "NoUncommittedAbsence",
        fields: [
          "unsafeAbsence = TRUE",
          'stage = "empty"',
          "release = FALSE",
          "owner = 0",
        ],
      },
      {
        name: "revoked-authority",
        negative: true,
        invariant: "NoUnissuedEffect",
        fields: [
          "unsafeEffect = TRUE",
          "active = FALSE",
          "binding = 1",
          "progress = 1",
        ],
        alternativeWitnesses: [
          [
            "unsafeEffect = TRUE",
            "active = FALSE",
            "binding = 1",
            "progress = 2",
          ],
          [
            "unsafeEffect = TRUE",
            "active = FALSE",
            "binding = 1",
            "progress = 3",
          ],
        ],
      },
      {
        name: "changed-binding",
        negative: true,
        invariant: "NoUnissuedEffect",
        fields: ["unsafeEffect = TRUE", "binding = 2", "progress = 1"],
        alternativeWitnesses: [
          ["unsafeEffect = TRUE", "binding = 2", "progress = 2"],
          ["unsafeEffect = TRUE", "binding = 2", "progress = 3"],
        ],
      },
      {
        name: "reserved-crash-reachable",
        negative: true,
        invariant: "NeverReservedCrashCompletion",
        fields: ['crashStage = "reserved"', "progress = 3", 'stage = "done"'],
      },
      {
        name: "promoted-crash-reachable",
        negative: true,
        invariant: "NeverPromotedCrashCompletion",
        fields: ['crashStage = "promoted"', "progress = 3", 'stage = "done"'],
      },
      {
        name: "release-crash-reachable",
        negative: true,
        invariant: "NeverReleaseCrashCompletion",
        fields: ['crashStage = "empty"', "progress = 3", 'stage = "done"'],
      },
      {
        name: "unknown-refusal-reachable",
        negative: true,
        invariant: "NeverUnknownRefusal",
        fields: ['stage = "unknown-retained"', "pending = 2", "savedNext = 0"],
      },
      {
        name: "fresh-release-retention-reachable",
        negative: true,
        invariant: "NeverFreshReleaseRetention",
        fields: [
          'stage = "release-failed"',
          "owner = 1",
          "directory = TRUE",
          "release = FALSE",
        ],
      },
    ],
  },
  {
    name: "native-storage-witness",
    module: "Witness",
    states: 352,
    invariant: "NoSeedOnReopen",
    fields: [
      'operation = "resume"',
      "expected = 1",
      "enrolled = 1",
      "metadata = 1",
      "marker = 1",
      "seedWrites = 2",
      "enrollmentWrites = 1",
      "seedCapability = FALSE",
      "completionCapability = FALSE",
      "unsafeSeed = TRUE",
    ],
    additionalControls: [
      {
        name: "missing-witness",
        negative: true,
        invariant: "NoWorkloadWithoutWitness",
        fields: [
          'phase = "running"',
          "expected = 1",
          "enrolled = 1",
          "metadata = 1",
          "marker = 0",
          "unsafeStart = TRUE",
        ],
      },
      {
        name: "wrong-witness",
        negative: true,
        invariant: "NoWorkloadWithoutWitness",
        fields: [
          'phase = "running"',
          "expected = 1",
          "enrolled = 1",
          "metadata = 1",
          "marker = 2",
          "unsafeStart = TRUE",
        ],
      },
      {
        name: "foreign-metadata",
        negative: true,
        invariant: "NoWorkloadWithoutWitness",
        fields: [
          'phase = "running"',
          "expected = 1",
          "enrolled = 1",
          "metadata = 2",
          "marker = 1",
          "unsafeStart = TRUE",
        ],
      },
      {
        name: "premature-completion",
        negative: true,
        invariant: "NoUnprovedCompletion",
        fields: [
          'phase = "enrolled"',
          "expected = 1",
          "enrolled = 1",
          "metadata = 1",
          "marker = 0",
          "unsafeCompletion = TRUE",
        ],
      },
      {
        name: "expectation-replacement",
        negative: true,
        invariant: "NoChangedExpectation",
        fields: [
          'phase = "checking"',
          "expected = 2",
          "originalExpected = 1",
          "enrolled = 1",
          "unsafeReplacement = TRUE",
        ],
      },
      {
        name: "readonly-reenrollment",
        negative: true,
        invariant: "NoReadOnlyReenrollment",
        fields: [
          'phase = "checked"',
          "expected = 1",
          "enrolled = 1",
          "marker = 1",
          "enrollmentWrites = 2",
          "seedCapability = FALSE",
          "completionCapability = FALSE",
          "unsafeReenrollment = TRUE",
        ],
      },
      {
        name: "recovery-seed",
        negative: true,
        invariant: "NoSeedOnReopen",
        fields: [
          'phase = "interrupted"',
          'operation = "recovery"',
          "expected = 1",
          "originalExpected = 1",
          "enrolled = 0",
          "volumePresent = TRUE",
          "marker = 1",
          "seedWrites = 1",
          "seedCapability = FALSE",
          "completionCapability = FALSE",
          "unsafeSeed = TRUE",
        ],
      },
      {
        name: "cold-reachable",
        negative: true,
        invariant: "NeverColdWorkload",
        fields: [
          'phase = "running"',
          'operation = "cold"',
          "expected = 1",
          "enrolled = 1",
          "marker = 1",
          "metadata = 1",
          "seedWrites = 1",
          "enrollmentWrites = 1",
          "unsafeStart = FALSE",
          "unsafeCompletion = FALSE",
        ],
      },
      {
        name: "resume-reachable",
        negative: true,
        invariant: "NeverReadOnlyResume",
        fields: [
          'phase = "running"',
          'operation = "resume"',
          "expected = 1",
          "enrolled = 1",
          "marker = 1",
          "metadata = 1",
          "resumes = 1",
          "seedWrites = 1",
          "enrollmentWrites = 1",
          "seedCapability = FALSE",
          "completionCapability = FALSE",
          "unsafeSeed = FALSE",
          "unsafeStart = FALSE",
        ],
      },
      {
        name: "recovery-reachable",
        negative: true,
        invariant: "NeverEnrolledRecovery",
        fields: [
          'phase = "running"',
          'operation = "recovery"',
          "expected = 1",
          "enrolled = 1",
          "marker = 1",
          "metadata = 1",
          "crashes = 1",
          "seedWrites = 1",
          "enrollmentWrites = 1",
          "seedCapability = FALSE",
          "completionCapability = FALSE",
          "unsafeSeed = FALSE",
          "unsafeStart = FALSE",
        ],
      },
      {
        name: "empty-intent-refusal-reachable",
        negative: true,
        invariant: "NeverEmptyIntentRefusal",
        fields: [
          'phase = "refused"',
          'operation = "recovery"',
          'disposition = "needs-explicit-reconcile"',
          "intent = TRUE",
          "expected = 0",
          "originalExpected = 0",
          "enrolled = 0",
          "volumePresent = FALSE",
          "marker = 0",
          "seedWrites = 0",
          "enrollmentWrites = 0",
          "seedCapability = FALSE",
          "completionCapability = FALSE",
        ],
      },
      {
        name: "interrupted-missing-reachable",
        negative: true,
        invariant: "NeverInterruptedMissingRefusal",
        fields: [
          'phase = "refused"',
          'operation = "recovery"',
          'disposition = "needs-explicit-reconcile"',
          "expected = 1",
          "originalExpected = 1",
          "enrolled = 0",
          "volumePresent = TRUE",
          "metadata = 1",
          "marker = 0",
          "seedWrites = 0",
          "enrollmentWrites = 0",
          "seedCapability = FALSE",
          "completionCapability = FALSE",
        ],
      },
      {
        name: "interrupted-matching-reachable",
        negative: true,
        invariant: "NeverInterruptedMatchingRefusal",
        fields: [
          'phase = "refused"',
          'operation = "recovery"',
          'disposition = "needs-explicit-reconcile"',
          "expected = 1",
          "originalExpected = 1",
          "enrolled = 0",
          "volumePresent = TRUE",
          "metadata = 1",
          "marker = 1",
          "seedWrites = 1",
          "enrollmentWrites = 0",
          "seedCapability = FALSE",
          "completionCapability = FALSE",
        ],
      },
      {
        name: "missing-resume-refusal-reachable",
        negative: true,
        invariant: "NeverMissingResumeRefusal",
        fields: [
          'phase = "refused"',
          'operation = "resume"',
          'disposition = "witness-mismatch"',
          "expected = 1",
          "originalExpected = 1",
          "enrolled = 1",
          "metadata = 1",
          "marker = 0",
          "seedWrites = 1",
          "enrollmentWrites = 1",
          "seedCapability = FALSE",
          "completionCapability = FALSE",
          "unsafeStart = FALSE",
          "unsafeSeed = FALSE",
        ],
      },
      {
        name: "wrong-resume-refusal-reachable",
        negative: true,
        invariant: "NeverWrongResumeRefusal",
        fields: [
          'phase = "refused"',
          'operation = "resume"',
          'disposition = "witness-mismatch"',
          "expected = 1",
          "originalExpected = 1",
          "enrolled = 1",
          "metadata = 1",
          "marker = 2",
          "seedWrites = 1",
          "enrollmentWrites = 1",
          "seedCapability = FALSE",
          "completionCapability = FALSE",
          "unsafeStart = FALSE",
          "unsafeSeed = FALSE",
        ],
      },
      {
        name: "stale-proof-refusal-reachable",
        negative: true,
        invariant: "NeverStaleProofRefusal",
        fields: [
          'phase = "refused"',
          'operation = "cold"',
          'disposition = "needs-explicit-reconcile"',
          "expected = 1",
          "originalExpected = 1",
          "enrolled = 0",
          "metadata = 1",
          "marker = 0",
          "proof = TRUE",
          "unsafeCompletion = FALSE",
        ],
      },
      {
        name: "legacy-refusal-reachable",
        negative: true,
        invariant: "NeverLegacyRefusal",
        fields: [
          'phase = "refused"',
          'disposition = "needs-adoption"',
          "expected = 0",
          "originalExpected = 0",
          "enrolled = 0",
          "volumePresent = TRUE",
          "seedWrites = 0",
          "enrollmentWrites = 0",
          "seedCapability = FALSE",
          "completionCapability = FALSE",
        ],
      },
    ],
  },
  {
    name: "native-file-material",
    module: "Material",
    states: 8388,
    invariant: "NoLostRecovery",
    fields: [
      'generation = "stopped"',
      "recoveryReference = FALSE",
      "members = {1, 2}",
      'retirement = "live"',
      'phase = "complete"',
    ],
    alternativeWitnesses: [
      [
        'generation = "stopped"',
        "recoveryReference = FALSE",
        "members = {1, 2}",
        'retirement = "intent"',
        'phase = "complete"',
      ],
      [
        'generation = "stopped"',
        "recoveryReference = FALSE",
        "members = {2}",
        'retirement = "live"',
        'phase = "complete"',
      ],
      [
        'generation = "stopped"',
        "recoveryReference = FALSE",
        "members = {1}",
        'retirement = "live"',
        'phase = "complete"',
      ],
      [
        'generation = "stopped"',
        "recoveryReference = FALSE",
        "members = {2}",
        'retirement = "intent"',
        'phase = "complete"',
      ],
      [
        'generation = "stopped"',
        "recoveryReference = FALSE",
        "members = {1}",
        'retirement = "intent"',
        'phase = "complete"',
      ],
      [
        'generation = "stopped"',
        "recoveryReference = FALSE",
        "members = {}",
        'retirement = "live"',
        'phase = "complete"',
      ],
    ],
    additionalControls: [
      {
        name: "unproved-absence",
        negative: true,
        invariant: "NoUnprovedDeletion",
        fields: [
          'phase = "retiring"',
          'retirement = "intent"',
          "containerPresent = TRUE",
          "unsafeDelete = TRUE",
        ],
      },
      {
        name: "uncertain-hook",
        negative: true,
        invariant: "NoUnprovedDeletion",
        fields: [
          'phase = "retiring"',
          "hookPending = TRUE",
          "childPending = FALSE",
          "unsafeDelete = TRUE",
        ],
      },
      {
        name: "unknown-child",
        negative: true,
        invariant: "NoUnprovedDeletion",
        fields: [
          'phase = "retiring"',
          "hookPending = FALSE",
          "childPending = TRUE",
          "unsafeDelete = TRUE",
        ],
      },
      {
        name: "unknown-stop-child",
        negative: true,
        invariant: "NoUnprovedDeletion",
        fields: [
          'phase = "retiring"',
          'stopChild = "unknown"',
          "childPending = FALSE",
          "hookPending = FALSE",
          "unsafeDelete = TRUE",
        ],
      },
      {
        name: "stale-reference",
        negative: true,
        invariant: "NoUnprovedDeletion",
        fields: [
          'phase = "retiring"',
          "anchorVersion = 2",
          "ownerVersion = 1",
          "pendingVersion = 1",
          "unsafeDelete = TRUE",
        ],
      },
      {
        name: "stale-finalizer-owner",
        negative: true,
        invariant: "NoStaleCompletion",
        fields: [
          'phase = "complete"',
          'retirement = "retired"',
          "members = {}",
          "ownerVersion = 2",
          "pendingVersion = 1",
          "unsafeCommit = TRUE",
        ],
      },
      {
        name: "stale-finalizer-pending",
        negative: true,
        invariant: "NoStaleCompletion",
        fields: [
          'phase = "complete"',
          'retirement = "retired"',
          "members = {}",
          "ownerVersion = 1",
          "pendingVersion = 2",
          "unsafeCommit = TRUE",
        ],
      },
      {
        name: "missing-without-intent",
        negative: true,
        invariant: "NoInferredIntent",
        fields: [
          'phase = "retiring"',
          'retirement = "intent"',
          "missingWithoutIntent = TRUE",
          "unsafeIntent = TRUE",
        ],
      },
      {
        name: "partial-crash-reachable",
        negative: true,
        invariant: "NeverCompleteAfterPartialCrash",
        fields: [
          'generation = "stopped"',
          'retirement = "retired"',
          "members = {}",
          "partialCrash = TRUE",
          "crashes = 1",
          "unsafeCommit = FALSE",
        ],
      },
      {
        name: "missing-source-reachable",
        negative: true,
        invariant: "NeverCompleteWithoutSource",
        fields: [
          'generation = "stopped"',
          'retirement = "retired"',
          "members = {}",
          "sourceFresh = FALSE",
          "unsafeCommit = FALSE",
        ],
      },
    ],
  },
  {
    name: "native-foreground-down-hooks",
    module: "DownHooks",
    states: 1246,
    invariant: "Safe",
    fields: [
      "unsafeBefore = TRUE",
      "beforeOpen = 2",
      'jState = "beforeStarted"',
      'jGen = "D"',
    ],
    alternativeWitnesses: [
      [
        "unsafeBefore = TRUE",
        "beforeOpen = 2",
        'jState = "beforeStarted"',
        'jGen = "F"',
      ],
    ],
    additionalControls: [
      {
        name: "unknown-generation",
        negative: true,
        fields: ["unsafeGen = TRUE", "newGen = TRUE", 'jState = "absent"'],
      },
      {
        name: "owed-after-interrupt",
        negative: true,
        fields: [
          "unsafeOwe = TRUE",
          "upInterrupted = TRUE",
          'jState = "owed"',
          'jGen = "F"',
        ],
      },
      {
        name: "complete-reachable",
        negative: true,
        invariant: "NeverComplete",
        fields: [
          'jState = "complete"',
          "afterDone = TRUE",
          "unsafeAfter = FALSE",
        ],
      },
      {
        name: "recovery-reachable",
        negative: true,
        invariant: "NeverRecovered",
        fields: [
          'fpc = "dead"',
          'jState = "complete"',
          'jGen = "D"',
          "unsafeBefore = FALSE",
          "unsafeAfter = FALSE",
        ],
      },
    ],
  },
  {
    name: "executable-digest-cache",
    module: "DigestCache",
    states: 1943,
    invariant: "CacheNeverStale",
    // Only CacheHit sets staleHit, and only from phase "idle", so these two
    // fields hold in every first violation, whichever tick the two-worker search
    // reaches first (it found the same stale hit at tick 1 and at tick 2).
    fields: ["staleHit = TRUE", 'phase = "idle"'],
  },
  {
    name: "native-status-start",
    module: "StatusStart",
    states: 110,
    invariant: "ReaderNeverFailsStart",
    fields: [
      "failedByReader = TRUE",
      "services = TRUE",
      "reader = TRUE",
      'lease = "reader"',
    ],
  },
  {
    name: "native-publisher-stop",
    module: "PublisherStop",
    states: 168,
    invariant: "NoUnsafeCleanup",
    fields: [
      'phase = "bridge-retired"',
      "publisher = TRUE",
      "unsafeCleanup = TRUE",
    ],
    alternativeWitnesses: [
      [
        'phase = "bridge-retired"',
        "publisher = FALSE",
        "bridge = FALSE",
        "unsafeCleanup = TRUE",
      ],
      ['phase = "stopped"', "publisher = FALSE", "unsafeCleanup = TRUE"],
    ],
    additionalControls: [
      {
        name: "uncommitted-exit",
        negative: true,
        invariant: "NoUncommittedExit",
        fields: [
          'phase = "bridge-retired"',
          "owner = TRUE",
          "exitProof = FALSE",
          "publisher = FALSE",
        ],
      },
      {
        name: "reservation-tail",
        negative: true,
        invariant: "NoStrandedReservation",
        fields: [
          'phase = "retired"',
          "reservation = TRUE",
          "publisher = FALSE",
        ],
      },
      {
        name: "frontend-loss",
        negative: true,
        invariant: "NoSilentOrphan",
        fields: ['phase = "ready"', "frontend = FALSE", "owner = TRUE"],
        alternativeWitnesses: [
          ['phase = "publisher-down"', "frontend = FALSE", "owner = TRUE"],
          [
            'phase = "publisher-exit-pending"',
            "frontend = FALSE",
            "owner = TRUE",
          ],
        ],
      },
      {
        name: "group-signal",
        negative: true,
        invariant: "NoInterruptRace",
        fields: [
          'phase = "enrolled"',
          "publisher = FALSE",
          "interruptedPublisher = TRUE",
          "bridge = TRUE",
        ],
      },
      {
        name: "completion-reachable",
        negative: true,
        invariant: "NeverComplete",
        fields: [
          'phase = "retired"',
          "bridge = FALSE",
          "publisher = FALSE",
          "unsafeCleanup = FALSE",
        ],
      },
    ],
  },
  {
    name: "native-route-lookup",
    module: "RouteLookup",
    states: 498,
    invariant: "LiveRouteAllowed",
    fields: [
      'lookup = "deny"',
      'pending = "claimed"',
      'committed = [a |-> "original", b |-> "absent"]',
    ],
    alternativeWitnesses: [
      [
        'lookup = "deny"',
        'pending = "staged"',
        'committed = [a |-> "original", b |-> "claimed"]',
      ],
      [
        'lookup = "deny"',
        'pending = "absent"',
        'committed = [a |-> "original", b |-> "staged"]',
      ],
    ],
    additionalControls: [
      {
        name: "detached-inode",
        negative: true,
        invariant: "LiveRouteAllowed",
        fields: [
          'lookup = "deny"',
          "linked = FALSE",
          'committed = [a |-> "original", b |-> "claimed"]',
        ],
        alternativeWitnesses: ["absent", "staged"].map((phase) => [
          'lookup = "deny"',
          "linked = FALSE",
          `committed = [a |-> "original", b |-> "${phase}"]`,
        ]),
      },
      {
        name: "stale-claim",
        negative: true,
        invariant: "AllowMatchesOpenedClaim",
        fields: [
          'lookup = "allow"',
          'selected = "original"',
          'opened = [a |-> "absent", b |-> "absent"]',
        ],
        alternativeWitnesses: [
          ["absent", "claimed"],
          ["absent", "staged"],
          ["replacement", "absent"],
          ["replacement", "claimed"],
          ["replacement", "staged"],
        ].map(([claim, phase]) => [
          'lookup = "allow"',
          'selected = "original"',
          `opened = [a |-> "${claim}", b |-> "${phase}"]`,
        ]),
      },
      {
        name: "retirement-reachable",
        negative: true,
        invariant: "NeverDetachDuringRetirement",
        fields: [
          'lookup = "secondOpen"',
          "linked = FALSE",
          'pending = "none"',
          'selected = "original"',
          'opened = [a |-> "original", b |-> "staged"]',
          'committed = [a |-> "original", b |-> "absent"]',
        ],
      },
    ],
  },
  {
    name: "native-route-stop",
    module: "Stop",
    states: 202,
    invariant: "NoLostRecovery",
    fields: [
      'generation = "stopped"',
      'phase = "complete"',
      "claimHeld = TRUE",
      "workloadPresent = FALSE",
    ],
    additionalControls: [
      {
        name: "unproved-retirement",
        negative: true,
        invariant: "NoUnprovedRelease",
        fields: [
          'phase = "released"',
          "claimHeld = FALSE",
          "absenceObserved = FALSE",
          "unsafeRelease = TRUE",
        ],
      },
      {
        name: "stale-reference",
        negative: true,
        invariant: "NoUnprovedRelease",
        fields: [
          'phase = "released"',
          "claimHeld = FALSE",
          "absenceObserved = TRUE",
          "selected = 1",
          "version = 2",
          "unsafeRelease = TRUE",
        ],
      },
      {
        name: "uncertain-hook",
        negative: true,
        invariant: "NoUnprovedRelease",
        fields: [
          'phase = "released"',
          "claimHeld = FALSE",
          "absenceObserved = TRUE",
          "hookPending = TRUE",
          "unsafeRelease = TRUE",
        ],
      },
      {
        name: "completion-reachable",
        negative: true,
        invariant: "NeverComplete",
        fields: [
          'generation = "stopped"',
          'phase = "complete"',
          "claimHeld = FALSE",
          "workloadPresent = FALSE",
          "routePresent = FALSE",
          "hookPending = FALSE",
          "unsafeRelease = FALSE",
        ],
      },
    ],
  },
  {
    name: "registry-writer",
    module: "RegistryWriter",
    states: 7721,
    invariant: "NoLiveOwnershipLoss",
    fields: ["unsafeReap = TRUE", "lock = 0", "guard = 0"],
  },
  {
    name: "absent-publication-recovery",
    module: "Absent",
    states: 247,
    invariant: "NoPrematurePublication",
    fields: [
      "intent = TRUE",
      "complete = FALSE",
      "retired = FALSE",
      "published = TRUE",
      "unsafePublication = TRUE",
    ],
    alternativeWitnesses: [
      [
        "intent = TRUE",
        "complete = TRUE",
        "retired = FALSE",
        "published = TRUE",
        "unsafePublication = TRUE",
      ],
    ],
    additionalControls: [
      {
        name: "unwitnessed-cleanup",
        negative: true,
        invariant: "NoUnwitnessedCleanup",
        fields: [
          "intent = FALSE",
          "progress = 1",
          'engine = "recovery"',
          'foreground = "recovery"',
          "unsafeCleanup = TRUE",
        ],
      },
      {
        name: "stale-selection",
        negative: true,
        invariant: "NoUnwitnessedCleanup",
        fields: [
          "intent = TRUE",
          "selected = 1",
          "version = 2",
          "progress = 1",
          "unsafeCleanup = TRUE",
        ],
        alternativeWitnesses: [
          [
            "intent = TRUE",
            "selected = 1",
            "version = 2",
            "progress = 2",
            "unsafeCleanup = TRUE",
          ],
        ],
      },
      {
        name: "unconfirmed-retirement",
        negative: true,
        invariant: "NoUnconfirmedRetirement",
        fields: [
          "intent = FALSE",
          "complete = FALSE",
          "progress = 0",
          "retired = TRUE",
          "unsafeRetirement = TRUE",
        ],
        alternativeWitnesses: [
          [
            "intent = TRUE",
            "complete = FALSE",
            "progress = 0",
            "retired = TRUE",
            "unsafeRetirement = TRUE",
          ],
          [
            "intent = TRUE",
            "complete = FALSE",
            "progress = 1",
            "retired = TRUE",
            "unsafeRetirement = TRUE",
          ],
          [
            "intent = TRUE",
            "complete = FALSE",
            "progress = 2",
            "retired = TRUE",
            "unsafeRetirement = TRUE",
          ],
        ],
      },
    ],
  },
  {
    name: "missing-publication-lock",
    module: "MissingLock",
    states: 96,
    invariant: "NoPrematureConsumer",
    fields: [
      'stage = "owner"',
      'consumer = "ordinary"',
      "gate = FALSE",
      "unsafeAdmission = TRUE",
    ],
    additionalControls: [
      {
        name: "retired-admission",
        negative: true,
        invariant: "NoPrematureConsumer",
        fields: [
          'stage = "owner"',
          'consumer = "retired"',
          "gate = FALSE",
          "unsafeAdmission = TRUE",
        ],
      },
      {
        name: "stale-proof",
        negative: true,
        invariant: "NoUnprovedCompletion",
        fields: [
          'stage = "complete"',
          "selected = 1",
          "version = 2",
          "unsafeCompletion = TRUE",
        ],
      },
      {
        name: "replaced-lock",
        negative: true,
        invariant: "NoUnprovedCompletion",
        fields: [
          'stage = "complete"',
          'lockPath = "foreign"',
          "unsafeCompletion = TRUE",
        ],
      },
      {
        name: "old-holder",
        negative: true,
        invariant: "NoUncoordinatedLegacy",
        fields: [
          'stage = "intent"',
          'repair = "active"',
          "gate = TRUE",
          "legacyPublished = TRUE",
        ],
        alternativeWitnesses: laterIncompleteMissingLockStages.map((stage) => [
          `stage = "${stage}"`,
          'repair = "active"',
          "gate = TRUE",
          "legacyPublished = TRUE",
        ]),
      },
      {
        name: "completion-reachable",
        negative: true,
        invariant: "NeverComplete",
        fields: [
          'stage = "complete"',
          'lockPath = "replacement"',
          "unsafeCompletion = FALSE",
        ],
      },
    ],
  },
  {
    name: "shared-https-lifetime",
    module: "SharedHttps",
    states: 64,
    invariant: "NoPrematureShutdown",
    fields: ['mode = "closed"', "leases = {2}", "unsafeShutdown = TRUE"],
  },
  {
    name: "previous-boot-shared-https",
    module: "ArchiveHttps",
    states: 92,
    invariant: "NoPrematurePublication",
    fields: [
      "intent = TRUE",
      "complete = FALSE",
      'archived = {"owner"}',
      "crashed = TRUE",
      "published = TRUE",
      "unsafePublication = TRUE",
    ],
    alternativeWitnesses: [
      [
        "intent = TRUE",
        "complete = FALSE",
        'archived = {"owner", "socket"}',
        "crashed = TRUE",
        "published = TRUE",
        "unsafePublication = TRUE",
      ],
    ],
    additionalControls: [
      {
        name: "stale-selection",
        negative: true,
        invariant: "NoUnprovedArchive",
        fields: [
          "intent = TRUE",
          "selected = 1",
          "version = 2",
          "engine = TRUE",
          'admission = "recovery"',
          'archived = {"owner"}',
          "unsafeArchive = TRUE",
        ],
        alternativeWitnesses: [
          [
            "intent = TRUE",
            "selected = 1",
            "version = 2",
            "engine = TRUE",
            'admission = "recovery"',
            'archived = {"owner", "socket"}',
            "unsafeArchive = TRUE",
          ],
          [
            "intent = TRUE",
            "selected = 1",
            "version = 2",
            "engine = TRUE",
            'admission = "recovery"',
            'archived = {"socket"}',
            "unsafeArchive = TRUE",
          ],
        ],
      },
      {
        name: "unproved-archive",
        negative: true,
        invariant: "NoUnprovedArchive",
        fields: [
          "intent = TRUE",
          "eligible = FALSE",
          "engine = TRUE",
          'admission = "recovery"',
          'archived = {"owner"}',
          "unsafeArchive = TRUE",
        ],
        alternativeWitnesses: [
          [
            "intent = TRUE",
            "eligible = FALSE",
            "engine = TRUE",
            'admission = "recovery"',
            'archived = {"owner", "socket"}',
            "unsafeArchive = TRUE",
          ],
          [
            "intent = TRUE",
            "eligible = FALSE",
            "engine = TRUE",
            'admission = "recovery"',
            'archived = {"socket"}',
            "unsafeArchive = TRUE",
          ],
        ],
      },
    ],
  },
  {
    name: "native-startup-owner",
    module: "Owner",
    states: 1720,
    invariant: "NoUnownedResources",
    fields: [
      'mapping = "none"',
      'phase = "exited"',
      'receipt = "authenticated"',
      'resources = "present"',
    ],
    additionalControls: [
      // --wait: the mapping is still saved at started; the release is at ready.
      { name: "wait", negative: false, states: 806 },
      {
        // The launcher is released at started before stop.owe committed.
        name: "detached-before-bookkeeping",
        negative: true,
        invariant: "NoPrematureReturn",
        fields: [
          'launcher = "returned"',
          "accepted = TRUE",
          "startedSeen = TRUE",
          'mapping = "published"',
          "bookkept = FALSE",
        ],
      },
      {
        // No release gate at all: success before every container started.
        name: "detached-before-started",
        negative: true,
        invariant: "NoPrematureReturn",
        fields: [
          'launcher = "returned"',
          "accepted = TRUE",
          "startedSeen = FALSE",
        ],
      },
      {
        // The same gap under --wait: success before ready.
        name: "detached-before-ready-wait",
        negative: true,
        invariant: "NoPrematureReturn",
        fields: ['launcher = "returned"', "accepted = TRUE", "readied = FALSE"],
      },
      {
        // Finding B: the launcher is released before the run mapping is saved.
        name: "mapping-after-line",
        negative: true,
        invariant: "NoReturnWithoutMapping",
        fields: [
          'launcher = "notified"',
          'mapping = "none"',
          "startedSeen = TRUE",
          "bookkept = TRUE",
        ],
      },
      {
        // Finding B under --wait: released at ready with no mapping saved.
        name: "mapping-after-line-wait",
        negative: true,
        invariant: "NoReturnWithoutMapping",
        fields: ['launcher = "notified"', 'mapping = "none"', "readied = TRUE"],
      },
      {
        // The owner accepts a stop half-way through a publication, so the stop
        // misses its staged route.
        name: "stop-mid-publication",
        negative: true,
        invariant: "NoHalfPublicationAfterStop",
        fields: [
          'phase = "stopped"',
          'pub = "publishing"',
          'route = "bound"',
          "recorded = FALSE",
        ],
      },
      {
        // The owner accepts a stop between started and ready without
        // cancelling its wait.
        name: "down-leaves-owner-waiting",
        negative: true,
        invariant: "DownCancelsWait",
        fields: [
          'phase = "started"',
          'down = "accepted"',
          'acceptAt = "started"',
          'wait = "waiting"',
        ],
      },
      {
        // A queued stop takes effect without the owner's acceptance.
        name: "stop-without-accept",
        negative: true,
        invariant: "StoppedOwnerNotWaiting",
        fields: [
          'phase = "stopped"',
          'down = "done"',
          'acceptAt = "none"',
          'wait = "waiting"',
        ],
      },
      {
        // The owner stops the run before the frontend's own controller is
        // aborted: the frontend still waits on a stopped owner.
        name: "stop-before-frontend-cancel",
        negative: true,
        invariant: "StoppedFrontendCancelled",
        fields: [
          'phase = "stopped"',
          'down = "done"',
          'acceptAt = "started"',
          'wait = "cancelled"',
          'frontend = "live"',
        ],
      },
      {
        name: "refused-inspection",
        negative: true,
        invariant: "NoUnrecordedRefusal",
        fields: [
          'mapping = "none"',
          'phase = "exited"',
          'receipt = "refused"',
          'resources = "present"',
        ],
      },
    ],
  },
  {
    // HACK-1953. The negative control runs the stop request in the terminal's
    // process group: one Ctrl-C leaves a pending restart.
    name: "native-restart-intent",
    module: "RestartIntent",
    states: 40,
    invariant: "InterruptLeavesNoIntent",
    fields: [
      "crashed = FALSE",
      "interrupted = TRUE",
      'intent = "prepared"',
      'restart = "failed"',
    ],
    additionalControls: [
      {
        // A crashed restart frontend after (or before) the old owner stopped
        // itself, when a prepared intent requires an active graph.
        name: "no-resume",
        negative: true,
        invariant: "NoRecoveryLoop",
        fields: [
          "crashed = TRUE",
          'graph = "stopped"',
          'intent = "prepared"',
          'restart = "failed"',
        ],
      },
      {
        // The v5.0.0-next.12 behavior: neither mechanism, so up and restart
        // refuse each other.
        name: "shared-group-loop",
        negative: true,
        invariant: "NoRecoveryLoop",
        fields: [
          'graph = "stopped"',
          'intent = "prepared"',
          'owner = "retired"',
          'restart = "failed"',
        ],
      },
    ],
  },
  {
    name: "native-start-lock-wait",
    module: "LeaseWait",
    states: 19,
    invariant: "NoEffectWhileHeld",
    fields: ['holder = "second"', 'waiter = "acquired"', "earlyEffect = TRUE"],
    additionalControls: [
      {
        name: "acquisition-reachable",
        negative: true,
        invariant: "NeverAcquired",
        fields: [
          'holder = "second"',
          'waiter = "acquired"',
          "earlyEffect = FALSE",
        ],
      },
      {
        name: "expiry-reachable",
        negative: true,
        invariant: "NeverExpired",
        fields: ['waiter = "expired"', "elapsed = 5", "earlyEffect = FALSE"],
      },
    ],
  },
  {
    name: "stopped-pool-startup",
    module: "Resume",
    states: 71,
    invariant: "NoSubstitutedBoot",
    fields: [
      'phase = "pending"',
      "attempts = 1",
      "bootSelectionMatched = FALSE",
      "selectedOwner = 1",
      "selectedReceipt = 1",
      "locked = TRUE",
    ],
    additionalControls: [
      {
        name: "uncertain-replay",
        negative: true,
        invariant: "NoUncertainReplay",
        fields: [
          'phase = "pending"',
          "attempts = 2",
          "uncertain = TRUE",
          "bootSelectionMatched = TRUE",
          "authority = FALSE",
          "locked = TRUE",
        ],
      },
    ],
  },
  {
    // One start of a pool that is not running: two chained Development samples
    // (the second under the startup lease, a window after the first), Research's
    // three pre-lease samples, the content proofs, the tree recheck under the
    // lease and the pre-boot check, on a host that can fail and recover once,
    // and the recorded earlier sample that may replace Development's wait.
    // This configuration proves the root files under the lease: a start
    // without an early root files proof.
    name: "pool-start-admission",
    module: "PoolStart",
    states: 220_686,
    // Development's second sample taken before the startup lease.
    invariant: "SecondSampleUnderLease",
    fields: ['pc = "Proven"', 'profile = "development"'],
    additionalControls: [
      // The implementation's other path, a cleanly stopped pool's start: root files
      // proven in the window, rechecked under the lease.
      { name: "root-before-lease", negative: false, states: 277_194 },
      {
        name: "window-not-enforced",
        negative: true,
        invariant: "WindowRespected",
        fields: ['pc = "Qualified"', 'profile = "development"'],
      },
      {
        name: "unchained-recheck",
        negative: true,
        invariant: "ChainUnbroken",
        fields: ['pc = "Qualified"', "swapouts = 1"],
      },
      {
        name: "unchained-boot",
        negative: true,
        invariant: "BootBaselineIsLastSample",
        fields: ['pc = "BootAdmitted"', "baseline = <<1>>", "swapouts = 1"],
      },
      {
        name: "research-two-samples",
        negative: true,
        invariant: "ResearchThreeSamples",
        fields: ['pc = "Started"', 'profile = "research"', "vm = TRUE"],
      },
      {
        name: "root-unchecked",
        negative: true,
        invariant: "StartFromProvenRoot",
        fields: ['pc = "RootProven"', "rootOk = FALSE", "rootProved = TRUE"],
      },
      // Without the tree recheck under the lease, a tree that changed after
      // its proof before the lease is booted from.
      {
        name: "changed-tree-start",
        negative: true,
        invariant: "NoStartFromChangedTree",
        fields: [
          'pc = "Started"',
          "treeOk = FALSE",
          "treeProved = TRUE",
          "vm = TRUE",
        ],
      },
      {
        name: "development-start-reachable",
        negative: true,
        invariant: "NeverStartsDevelopment",
        fields: ['profile = "development"', "vm = TRUE"],
      },
      {
        name: "research-start-reachable",
        negative: true,
        invariant: "NeverStartsResearch",
        fields: ['profile = "research"', "vm = TRUE"],
      },
      {
        name: "moved-alias-start-reachable",
        negative: true,
        invariant: "NeverStartsOnMovedAlias",
        fields: ['alias = "moved"', "selected = 2", "vm = TRUE"],
      },
      // The first sample recorded without its predicate check.
      {
        name: "first-sample-unchecked",
        negative: true,
        invariant: "SamplesTakenOnPassingHost",
        fields: ['pc = "Opened"', "hostOk = FALSE"],
      },
      // The same for Development's sample under the lease ...
      {
        name: "second-sample-unchecked",
        negative: true,
        invariant: "SamplesTakenOnPassingHost",
        fields: [
          'pc = "Qualified"',
          'profile = "development"',
          "hostOk = FALSE",
        ],
      },
      // ... and for Research's second and third samples.
      {
        name: "research-sample-unchecked",
        negative: true,
        invariant: "SamplesTakenOnPassingHost",
        fields: ['pc = "Opened"', 'profile = "research"', "hostOk = FALSE"],
      },
      // What few samples do not see, as reachable facts: a start admitted
      // although the host failed between two of its accepted samples.
      {
        name: "development-dip-start-reachable",
        negative: true,
        invariant: "NeverStartsDevelopmentAcrossADip",
        fields: [
          'profile = "development"',
          "acrossDip = TRUE",
          "dips = 1",
          "vm = TRUE",
        ],
      },
      {
        name: "research-dip-start-reachable",
        negative: true,
        invariant: "NeverStartsResearchAcrossADip",
        fields: [
          'profile = "research"',
          "acrossDip = TRUE",
          "dips = 1",
          "vm = TRUE",
        ],
      },
      // The same between the last sample and the pre-boot observation.
      {
        name: "boot-dip-start-reachable",
        negative: true,
        invariant: "NeverStartsAcrossADipBeforeBoot",
        fields: ["bootAcrossDip = TRUE", "dips = 1", "vm = TRUE"],
      },
      // The pre-boot observation admitted without its predicate check ...
      {
        name: "boot-host-unchecked",
        negative: true,
        invariant: "BootSampleOnPassingHost",
        fields: ['pc = "BootAdmitted"', "hostOk = FALSE"],
      },
      // ... or without comparing its swapout count with the baseline.
      {
        name: "boot-swapouts-unchecked",
        negative: true,
        invariant: "BootSampleMatchesBaseline",
        fields: ['pc = "BootAdmitted"', "baseline = <<0>>", "swapouts = 1"],
      },
      // The record of an earlier passing sample that may replace the
      // admission wait. One control for each condition of its reuse ...
      {
        name: "reuse-other-boot",
        negative: true,
        invariant: "ReusedRecordSameBoot",
        fields: ['pc = "Qualified"', 'reusedBoot = "other"'],
      },
      {
        name: "reuse-too-young",
        negative: true,
        invariant: "WindowRespected",
        fields: [
          'pc = "Qualified"',
          'reusedBoot = "this"',
          'reusedAge = "young"',
        ],
      },
      {
        name: "reuse-too-old",
        negative: true,
        invariant: "ReusedRecordWithinBound",
        fields: [
          'pc = "Qualified"',
          'reusedBoot = "this"',
          'reusedAge = "old"',
        ],
      },
      {
        name: "reuse-changed-count",
        negative: true,
        invariant: "ReusedRecordSameSwapouts",
        fields: [
          'pc = "Qualified"',
          'reusedBoot = "this"',
          "reusedSwap = 0",
          "swapouts = 1",
        ],
      },
      // ... and one for its writer: a failing sample recorded.
      {
        name: "record-unchecked",
        negative: true,
        invariant: "RecordsFromPassingSamples",
        fields: ['recBoot = "this"', "recOk = FALSE", "hostOk = FALSE"],
      },
      // Reachable: a start that replaced its wait with a record, one that
      // found an unusable record and waited as before, and the weakening of
      // reuse (the host failed between the recorded sample and the leased one).
      {
        name: "reuse-start-reachable",
        negative: true,
        invariant: "NeverStartsOnReuse",
        fields: ['reusedBoot = "this"', 'reusedAge = "ok"', "vm = TRUE"],
      },
      {
        name: "reuse-miss-start-reachable",
        negative: true,
        invariant: "NeverStartsPastAnUnusableRecord",
        fields: ['reusedBoot = "none"', "missed = TRUE", "vm = TRUE"],
      },
      {
        name: "reuse-dip-start-reachable",
        negative: true,
        invariant: "NeverStartsOnReuseAcrossADip",
        fields: [
          'reusedBoot = "this"',
          "reusedDip = TRUE",
          "dips = 1",
          "vm = TRUE",
        ],
      },
    ],
  },
  {
    name: "multi-root-share",
    module: "Shares",
    states: 55,
    invariant: "OwnShareOnly",
    ...sharesWitnesses(sharesOwnShareViolations),
    additionalControls: [
      {
        name: "unfenced-boot",
        negative: true,
        invariant: "RunningMountsAudited",
        ...sharesWitnesses(sharesUnfencedBootViolations),
      },
      {
        name: "owner-first",
        negative: true,
        invariant: "OwnerNeverAhead",
        ...sharesWitnesses(sharesOwnerFirstViolations),
      },
      {
        name: "referenced-removal",
        negative: true,
        invariant: "ReferencedSharesKept",
        ...sharesWitnesses(sharesReferencedRemovalViolations),
      },
    ],
  },
  {
    name: "dependency-rebind",
    module: "Rebind",
    states: 21,
    invariant: "NoEarlyAdmission",
    fields: [
      'phase = "active"',
      "admitted = TRUE",
      "revoked = {}",
      "streams = {1, 2}",
      "committed = FALSE",
    ],
    additionalControls: [
      { name: "mixed-completed", negative: false, states: 19 },
      { name: "all-completed", negative: false, states: 18 },
      { name: "refused-readiness", negative: false, states: 2 },
      { name: "refused-failed-completed", negative: false, states: 2 },
      {
        name: "terminal-reuse",
        module: "TerminalReuse",
        negative: false,
        states: 82,
      },
      {
        name: "premature-terminal-reuse",
        module: "TerminalReuse",
        negative: true,
        invariant: "NoPrematureNewGrant",
        fields: [
          'phase = "one-off"',
          "grants = {3}",
          "committed = FALSE",
          "slotReady = FALSE",
          "fenced = TRUE",
        ],
      },
      {
        name: "wrong-readiness",
        negative: true,
        invariant: "NoWrongTerminalReadiness",
        fields: [
          'phase = "reviewed"',
          "completed = {2}",
          "reviewed = TRUE",
          "admitted = FALSE",
        ],
      },
      {
        name: "failed-completed",
        negative: true,
        invariant: "NoWrongTerminalReadiness",
        fields: [
          'phase = "reviewed"',
          "completed = {2}",
          "reviewed = TRUE",
          "admitted = FALSE",
        ],
      },
    ],
  },
  {
    // src/lib/global-logging.ts and `hack global install/up`: the logging
    // stack is opt-in; a home that had it keeps it, a new one never starts
    // it unasked, and turning it off never removes its logs.
    name: "global-logging-optin",
    module: "LoggingOptIn",
    states: 1014,
    invariant: "FreshNeverStartsUnasked",
    fields: [
      "existing = FALSE",
      "asked = FALSE",
      "running = TRUE",
      'setting = "unset"',
    ],
    alternativeWitnesses: [
      ["existing = FALSE", "asked = FALSE", "running = TRUE", 'setting = "on"'],
    ],
    additionalControls: [
      {
        name: "legacy-unset-off",
        negative: true,
        invariant: "ExistingHomeKept",
        fields: ["existing = TRUE", 'setting = "unset"', "running = FALSE"],
      },
      {
        name: "off-removes-volumes",
        negative: true,
        invariant: "NoSurpriseDataLoss",
        fields: ["prevData = TRUE", "data = FALSE", 'setting = "off"'],
        alternativeWitnesses: [
          [
            "prevData = TRUE",
            "data = FALSE",
            'setting = "unset"',
            'last = "upFlag"',
            "running = FALSE",
          ],
          [
            "prevData = TRUE",
            "data = FALSE",
            'setting = "on"',
            'last = "upFlag"',
            "running = FALSE",
          ],
          [
            "prevData = TRUE",
            "data = FALSE",
            'setting = "unset"',
            'last = "install"',
            "running = FALSE",
          ],
          [
            "prevData = TRUE",
            "data = FALSE",
            'setting = "unset"',
            'last = "up"',
            "running = FALSE",
          ],
        ],
      },
      {
        // The first start does not save an existing home's choice: with its
        // logging directory moved aside, the next start turns it off.
        name: "decision-not-saved",
        negative: true,
        invariant: "ExistingHomeKept",
        fields: [
          "existing = TRUE",
          'setting = "unset"',
          "dir = FALSE",
          "running = FALSE",
        ],
      },
      {
        // A failed save of `--logging` that is not reported: the stack runs
        // with the setting still off, and nothing told the user.
        name: "unsaved-silent",
        negative: true,
        invariant: "OffMeansStopped",
        fields: ['setting = "off"', "unsaved = FALSE", "running = TRUE"],
      },
    ],
  },
  {
    // src/lib/process-exit.ts: the CLI never exits while held work runs or
    // before its output is flushed.
    name: "cli-process-exit",
    module: "ProcessExit",
    states: 298,
    invariant: "NoExitWithPendingHold",
    fields: ['phase = "flushing"', "snap = {}", "buffered = FALSE"],
    alternativeWitnesses: [
      ['phase = "flushing"', "snap = {}", "buffered = TRUE"],
    ],
    additionalControls: [
      {
        name: "no-end",
        negative: true,
        invariant: "NoLostOutput",
        fields: ['phase = "exited"', "buffered = TRUE"],
      },
    ],
  },
  {
    // src/lib/proxy-ingress-addresses.ts: a record `hack run` trusts names
    // the running address unless an outside change followed its read.
    name: "ingress-address-record",
    module: "IngressRecord",
    states: 922_875,
    invariant: "TrustedRecordIsCurrent",
    // Addresses and changers are symmetric, so a two-worker search may end
    // on either; the pinned fields are the ones every first witness shares.
    fields: ["gen = 1", "settled = FALSE", "extSinceWrite = FALSE"],
    additionalControls: [
      {
        name: "unsettled",
        negative: true,
      },
      {
        // Overlapping changes: one settles while the other still moves the
        // containers, and a read in between is trusted.
        name: "unlocked",
        negative: true,
        fields: ["gen = 3", "settled = TRUE", "extSinceWrite = FALSE"],
      },
    ],
  },
  {
    name: "dependency-auto-refresh",
    module: "AutoRefresh",
    states: 141,
    invariant: "NoReplayAfterUnconfirmed",
    fields: [...unconfirmedRefreshReplayFields, "attempts = 2"],
    // Earlier attempts may complete or refuse before an unconfirmed refresh.
    // The negative config allows up to five attempts.
    alternativeWitnesses: [3, 4, 5].map((attempts) => [
      ...unconfirmedRefreshReplayFields,
      `attempts = ${attempts}`,
    ]),
  },
  {
    name: "relay-lifecycle-barrier",
    module: "Barrier",
    states: 1590,
    invariant: "NoUnretiredTarget",
    fields: [
      "unsafeCommit = TRUE",
      'phase = "effect-started"',
      "journal = TRUE",
      "ownerAlive = TRUE",
      "connections = {1, 2}",
    ],
    alternativeWitnesses: [
      [
        "unsafeCommit = TRUE",
        'phase = "effect-started"',
        "journal = TRUE",
        "ownerAlive = TRUE",
        "connections = {2}",
      ],
      [
        "unsafeCommit = TRUE",
        'phase = "effect-started"',
        "journal = TRUE",
        "ownerAlive = TRUE",
        "connections = {1}",
      ],
    ],
  },
  {
    name: "relay-authorization",
    module: "Authorization",
    states: 7,
    invariant: "NoLateWrite",
    fields: ["active = FALSE", "lateWrite = TRUE", 'phase = "done"'],
  },
  {
    name: "mcp-startup-cancellation",
    module: "Cancellation",
    states: 10,
    invariant: "NoLatePublication",
    fields: ["cancelled = TRUE", "latePublication = TRUE"],
  },
  {
    name: "mcp-startup",
    module: "Startup",
    states: 27,
    invariant: "NoRevokedGrant",
    fields: ["granted = TRUE", "killed = TRUE"],
  },
  {
    name: "authority-snapshot",
    module: "Routing",
    states: 11,
    invariant: "NoWrongReservation",
    fields: ["observed = 1", "delivered = 2"],
  },
  {
    name: "authority-lifetime",
    module: "Lifetime",
    states: 9,
    invariant: "NoAuthorityAfterDown",
    fields: ["running = FALSE", "authority = TRUE"],
  },
  {
    name: "publication-journal",
    module: "Journal",
    states: 50,
    invariant: "Safe",
    fields: ["alive = TRUE", "recoveredLive = TRUE"],
  },
  {
    // HACK-2442: one batch of route/port bridges, its fences and its release;
    // see tests/models/tla/bridge-batch/COVERAGE.md.
    name: "bridge-batch",
    module: "BridgeBatch",
    states: 14_674,
    invariant: "Safe",
    fields: ['opc = "late"', 'relay = [r |-> "running", p |-> "running"]'],
    additionalControls: [
      {
        name: "child-fence",
        negative: true,
        fields: ["staleLaunch = TRUE", 'lease = "free"'],
      },
      {
        name: "release-order",
        negative: true,
        fields: ['rpc = "late"', 'lease = "cleanup"'],
      },
      {
        name: "ready-reachable",
        negative: true,
        invariant: "NeverReady",
        fields: ['opc = "ready"', 'cpc = [r |-> "done", p |-> "done"]'],
      },
      {
        name: "release-reachable",
        negative: true,
        invariant: "NeverReleased",
        fields: ['rpc = "done"', 'lease = "free"'],
      },
      {
        name: "release-after-ready",
        negative: true,
        invariant: "NeverReleasedAfterReady",
        fields: ['rpc = "done"', "everReady = TRUE"],
      },
      {
        name: "stale-stop-reachable",
        negative: true,
        invariant: "NeverStaleStop",
        fields: ['opc = "failed"', 'lease = "free"'],
      },
    ],
  },
  {
    name: "per-service-publication",
    module: "PerServicePublication",
    states: 811,
    invariant: "Safe",
    fields: [
      'recorded = {"first"}',
      'child = [first |-> "gated", second |-> "absent"]',
    ],
    alternativeWitnesses: [
      [
        'recorded = {"second"}',
        'child = [first |-> "absent", second |-> "gated"]',
      ],
      [
        'recorded = {"second"}',
        'child = [first |-> "gated", second |-> "gated"]',
      ],
      [
        'recorded = {"second"}',
        'child = [first |-> "committed", second |-> "gated"]',
      ],
    ],
    additionalControls: [
      {
        name: "bind-before-commit",
        negative: true,
        fields: [
          'child = [first |-> "uncommitted-bind", second |-> "absent"]',
          "recorded = {}",
        ],
        alternativeWitnesses: [
          [
            'child = [first |-> "absent", second |-> "uncommitted-bind"]',
            "recorded = {}",
          ],
          [
            'child = [first |-> "gated", second |-> "uncommitted-bind"]',
            "recorded = {}",
          ],
          [
            'child = [first |-> "committed", second |-> "uncommitted-bind"]',
            "recorded = {}",
          ],
        ],
      },
      {
        name: "dead-authorization",
        negative: true,
        invariant: "NoDeadAuthorizedBind",
        fields: ["lateBind = TRUE", 'phase = "dead"'],
      },
    ],
  },
  {
    // Loopback TCP publication of Compose `ports`: one listener per host
    // port, no forwarding to a replaced container, no recovery of a live
    // owner, no listener after acknowledged stop; see tests/models/tla/README.md.
    name: "loopback-port-publication",
    module: "LoopbackPort",
    states: 1008,
    invariant: "Safe",
    fields: ["retiredLive = TRUE", "alive = [a |-> TRUE, b |-> TRUE]"],
    alternativeWitnesses: [
      ["retiredLive = TRUE", "alive = [a |-> FALSE, b |-> TRUE]"],
      ["retiredLive = TRUE", "alive = [a |-> TRUE, b |-> FALSE]"],
    ],
    additionalControls: [
      {
        name: "no-probe",
        negative: true,
        fields: ["shared = TRUE", 'holders = {"a", "foreign"}'],
        // TLC's two workers may report either owner as the second listener.
        alternativeWitnesses: [["shared = TRUE", 'holders = {"b", "foreign"}']],
      },
      {
        name: "stale-target",
        negative: true,
        fields: ["staleForward = TRUE", "target = [a |-> 0, b |-> 0]"],
      },
      {
        name: "ack-before-close",
        negative: true,
        fields: ["ackedListening = TRUE", 'holders = {"a"}'],
        alternativeWitnesses: [["ackedListening = TRUE", 'holders = {"b"}']],
      },
    ],
  },
  {
    // HACK-2576: one run's recovery history across repeated pool stops. Positive:
    // the oldest proven finished record makes room, and files that cannot be
    // proven finished are not counted. `negative` is the refusal at the bound
    // (counting every file with the prefix), which strands the stopped run.
    name: "recovery-archive-bound",
    module: "ArchiveBound",
    states: 75,
    invariant: "AlwaysRecoverable",
    fields: ['phase = "stopped"', 'intent = "complete"'],
  },
  {
    name: "publication",
    module: "Publication",
    states: 16,
    invariant: "Safe",
    fields: ['process = "native"', "intent = FALSE"],
  },
  {
    name: "fence-first",
    module: "First",
    negativeModule: "FirstBroken",
    states: 24,
    invariant: "Safe",
    fields: ["occupied = TRUE", "recovered = TRUE"],
  },
  {
    name: "fence-pending",
    module: "Fence",
    negativeModule: "FenceBroken",
    states: 7,
    invariant: "Safe",
    fields: ['phase = "stopped"', "alive = TRUE"],
  },
  {
    name: "relay-staging",
    module: "Stage",
    negativeModule: "StageBroken",
    states: 9,
    invariant: "Safe",
    fields: ['phase = "discarded"', "alive = TRUE"],
  },
  {
    // Shared helper instance lifecycle-session ownership (HACK-1142): the
    // controller's session decision, the locked creation transaction
    // (revalidate, publish, create, environment, record) and its failure
    // outcomes and cleanup, fenced process launches, the locked conditional
    // finalize, bounded mux calls that settle under the lock (with controls
    // for abandoned calls and timeouts read as absence), creator cleanup by
    // session epoch, and a down whose session stop fails; see
    // tests/models/tla/README.md.
    name: "shared-helper-instance",
    module: "Instance",
    states: 7649,
    invariant: "SessionSafe",
    fields: [
      'session = "absent"',
      'epoch = <<"b", "adopted">>',
      'pc = [a |-> "done", b |-> "succeeded"]',
    ],
    // TLC's two workers may report either up as the adopter, and the kill
    // may land after the adopter's Succeed (reported at Cleanup).
    alternativeWitnesses: [
      [
        'session = "absent"',
        'epoch = <<"a", "adopted">>',
        'pc = [a |-> "succeeded", b |-> "done"]',
      ],
    ],
    additionalControls: [
      {
        name: "no-revalidation",
        negative: true,
        invariant: "Reclaimable",
        fields: ['session = "alive"', 'token = "a"', 'entry = "b"'],
        alternativeWitnesses: [
          ['session = "alive"', 'token = "b"', 'entry = "a"'],
        ],
      },
      {
        name: "epoch-failure-unstopped",
        negative: true,
        invariant: "Reclaimable",
        fields: ['session = "alive"', 'token = "a"', 'entry = "none"'],
        alternativeWitnesses: [
          ['session = "alive"', 'token = "b"', 'entry = "none"'],
        ],
      },
      {
        name: "stale-finalize",
        negative: true,
        invariant: "Reclaimable",
        fields: ['session = "alive"', 'token = "b"', 'entry = "a"'],
        // TLC's two workers may report either up as the displaced one.
        alternativeWitnesses: [
          ['session = "alive"', 'token = "a"', 'entry = "b"'],
        ],
      },
      {
        name: "abandoned-create",
        negative: true,
        invariant: "Reclaimable",
        fields: ['session = "alive"', 'token = "a"', 'entry = "none"'],
        alternativeWitnesses: [
          ['session = "alive"', 'token = "b"', 'entry = "none"'],
          ['session = "alive"', 'token = "a"', 'entry = "b"'],
          ['session = "alive"', 'token = "b"', 'entry = "a"'],
        ],
      },
      {
        name: "abandoned-replace",
        negative: true,
        invariant: "SessionSafe",
        fields: [
          'session = "absent"',
          'pc = [a |-> "succeeded", b |-> "done"]',
        ],
        // The stale kill can land before or after the victim's Succeed;
        // either up can be the victim.
        alternativeWitnesses: [
          ['session = "absent"', 'pc = [a |-> "done", b |-> "succeeded"]'],
        ],
      },
      {
        name: "unlocked-failure-cleanup",
        negative: true,
        invariant: "SessionSafe",
        fields: [
          'session = "absent"',
          'pc = [a |-> "done", b |-> "succeeded"]',
        ],
        // The stale kill can land before or after the victim's Succeed;
        // either up can be the victim.
        alternativeWitnesses: [
          ['session = "absent"', 'pc = [a |-> "succeeded", b |-> "done"]'],
        ],
      },
      {
        name: "unfenced-launch",
        negative: true,
        invariant: "NoForeignLaunch",
        fields: ["foreign = TRUE", 'token = "b"', 'entry = "b"'],
        alternativeWitnesses: [
          ["foreign = TRUE", 'token = "a"', 'entry = "a"'],
        ],
      },
      {
        name: "release-on-failed-stop",
        negative: true,
        invariant: "HelpersKeptForSession",
        fields: ['down = "failed"', "released = TRUE", 'session = "alive"'],
      },
      {
        name: "timeout-as-absence",
        negative: true,
        invariant: "Reclaimable",
        fields: ['session = "alive"', 'token = "a"', 'entry = "b"'],
        alternativeWitnesses: [
          ['session = "alive"', 'token = "b"', 'entry = "a"'],
        ],
      },
    ],
  },
  {
    name: "service-restart-policy",
    module: "RestartPolicy",
    states: 134,
    invariant: "NoIncarnationAfterStop",
    fields: [
      'phase = "stopping"',
      'policy = "armed"',
      'engine = "running"',
      "lateStart = TRUE",
    ],
    // DaemonRestart needs a present container, so a stop-requested phase is
    // either stopping or, after terminal proof, stopped.
    alternativeWitnesses: [
      [
        'phase = "stopped"',
        'policy = "armed"',
        'engine = "running"',
        "lateStart = TRUE",
      ],
    ],
    additionalControls: [
      {
        name: "rebind-reachable",
        negative: true,
        invariant: "NeverRebound",
        fields: ['phase = "serving"', 'engine = "running"', "bound = 2"],
        alternativeWitnesses: [
          ['phase = "serving"', 'engine = "running"', "bound = 3"],
        ],
      },
      {
        name: "unproved-terminal",
        negative: true,
        invariant: "TerminalProof",
        fields: [
          'phase = "stopped"',
          'engine = "running"',
          "cancelled = TRUE",
          "unsafeTerminal = TRUE",
        ],
        // A non-terminal engine is either running or has a pending restart.
        alternativeWitnesses: [
          [
            'phase = "stopped"',
            'engine = "restarting"',
            "cancelled = TRUE",
            "unsafeTerminal = TRUE",
          ],
        ],
      },
      {
        name: "stale-generation",
        negative: true,
        invariant: "NoStaleIncarnation",
        fields: [
          'phase = "serving"',
          'engine = "restarting"',
          "bound = 1",
          "staleUse = TRUE",
        ],
        alternativeWitnesses: restartPolicyStaleUses
          .slice(1)
          .map((use) => [
            'phase = "serving"',
            `engine = "${use.engine}"`,
            `bound = ${use.bound}`,
            "staleUse = TRUE",
          ]),
      },
      {
        name: "completion-reachable",
        negative: true,
        invariant: "NeverRemoved",
        fields: [
          'phase = "removed"',
          'engine = "absent"',
          'policy = "no"',
          "unsafeTerminal = FALSE",
          "lateStart = FALSE",
        ],
      },
    ],
  },
  {
    name: "native-build-base-scheduling",
    module: "BaseScheduling",
    states: 12,
    invariant: "NoForegroundImport",
    fields: ['phase = "solving"', "foregroundDownload = TRUE"],
    additionalControls: [
      {
        name: "unsafe-overlap",
        negative: true,
        invariant: "OnlyIdleRetention",
        fields: ['phase = "stopping"', "retention = TRUE"],
      },
    ],
  },
  {
    name: "native-build-alias",
    module: "BuildAlias",
    states: 23,
    invariant: "BaseSurvives",
    fields: ["base = FALSE", "alias = FALSE"],
    additionalControls: [
      {
        name: "old-order",
        negative: true,
        invariant: "CanRecover",
        fields: ['phase = "blocked"', "keeper = FALSE", "alias = TRUE"],
      },
      {
        name: "unsafe-remote",
        negative: true,
        invariant: "NoRegistryFallback",
        fields: ["wire = TRUE", 'phase = "solving"'],
      },
      {
        name: "unsafe-sweep",
        negative: true,
        invariant: "NoLiveSweep",
        fields: ["sweptLive = TRUE", "alias = FALSE"],
      },
    ],
  },
  {
    name: "native-keeper-reclaim",
    module: "KeeperReclaim",
    states: 5,
    invariant: "PinPreservesImage",
    fields: ['fence = "pinning"', "keeper = FALSE"],
  },
  {
    name: "native-build-batch",
    module: "BuildBatch",
    states: 296,
    invariant: "NoLiveReturn",
    fields: ["result = -2"],
    additionalControls: [
      {
        name: "cancel-wins",
        negative: true,
        invariant: "FirstOutcome",
        fields: ["active = {}"],
      },
    ],
  },
  {
    name: "native-build-retention",
    module: "BuildRetention",
    states: 6181,
    invariant: "NoReclaimReferenced",
    fields: ["refs = {1}", "removed = 1", "fence = FALSE"],
    // Two-worker TLC can first reclaim image 2; require the same exact
    // referenced-image violation rather than accepting an arbitrary failure.
    alternativeWitnesses: [["refs = {2}", "removed = 2", "fence = FALSE"]],
    additionalControls: [
      {
        name: "foreign-adoption",
        negative: true,
        invariant: "NoForeignAdoption",
        fields: [
          'receipt = [phase |-> "verified", image |-> 2, inc |-> 1]',
          "owner = <<1, 0, 0>>",
        ],
        alternativeWitnesses: [
          [
            'receipt = [phase |-> "verified", image |-> 1, inc |-> 1]',
            "owner = <<0, 1, 0>>",
          ],
          [
            'receipt = [phase |-> "verified", image |-> 3, inc |-> 1]',
            "owner = <<1, 0, 0>>",
          ],
          [
            'receipt = [phase |-> "verified", image |-> 3, inc |-> 1]',
            "owner = <<0, 1, 0>>",
          ],
          [
            'receipt = [phase |-> "verified", image |-> 1, inc |-> 1]',
            "owner = <<0, 0, 1>>",
          ],
          [
            'receipt = [phase |-> "verified", image |-> 2, inc |-> 1]',
            "owner = <<0, 0, 1>>",
          ],
          [
            'receipt = [phase |-> "verified", image |-> 2, inc |-> 1]',
            "owner = <<1, 0, 1>>",
          ],
          [
            'receipt = [phase |-> "verified", image |-> 3, inc |-> 1]',
            "owner = <<1, 1, 0>>",
          ],
          [
            'receipt = [phase |-> "verified", image |-> 2, inc |-> 2]',
            "owner = <<2, 0, 0>>",
          ],
          [
            'receipt = [phase |-> "verified", image |-> 1, inc |-> 2]',
            "owner = <<0, 2, 0>>",
          ],
        ],
      },
      {
        name: "down-under-build",
        negative: true,
        invariant: "DownNotUnderBuild",
        fields: ['build = "running"', "engineUp = FALSE", "fence = TRUE"],
      },
    ],
  },
  {
    name: "relay-fence",
    module: "RelayFence",
    negativeModule: "RelayFenceBroken",
    states: 16,
    invariant: "Safe",
    fields: ["retired = <<1>>", "alive = 1"],
    alternativeWitnesses: [
      ["retired = <<1, 2>>", "alive = 1"],
      ["retired = <<1, 2>>", "alive = 2"],
    ],
  },
  {
    // HACK-2097: `down --recover` after a lost foreground whose graph owner
    // still runs and then stops itself (its publication reading `uncertain`
    // mid-retirement), dies at any point of its run or its stop, or loses its
    // publication. `negative` is the code before: a running selection whose
    // stop found the owner gone refused without naming a working step.
    // `no-settle` reselects without the bounded wait and refuses an owner
    // still exiting. `unconfirmed-absent` accepts a retired publication
    // without the stopped-receipt check and reports a false success.
    name: "native-down-lost-frontend",
    module: "DownLostFrontend",
    states: 57,
    invariant: "NoDeadEnd",
    fields: ['pc = "refused"', 'why = "unnamed"', "reselected = FALSE"],
    additionalControls: [
      {
        name: "no-settle",
        negative: true,
        invariant: "NoDeadEnd",
        fields: ['pc = "refused"', 'why = "unnamed"', "reselected = TRUE"],
      },
      {
        name: "unconfirmed-absent",
        negative: true,
        invariant: "DoneIsStopped",
        fields: ['pc = "done"', 'graph = "ready"', "vanished = TRUE"],
      },
    ],
  },
  {
    // HACK-2456: a pool that stops or dies under a live run. Positive: the
    // stopped-pool recovery plus recovery from any earlier boot of the pool,
    // with every fault (other boots, a stop between a recovery's boot and its
    // graph recovery). The failing controls document the old predecessor-only
    // rule: `negative` is `next` before HACK-2456, `by-hand` adds an unnamed
    // `runtime up`, `strict` keeps predecessor-only recovery while something
    // else boots the pool, `crash-in-recovery` lets the pool stop between the
    // recovery's boot and its graph recovery: each reaches a dead end.
    name: "native-pool-stop",
    module: "PoolStop",
    states: 210,
    invariant: "NoDeadEnd",
    fields: [
      'pool = "stopped"',
      'run = "ready"',
      'owner = "dead"',
      "pub = TRUE",
    ],
    additionalControls: [
      {
        name: "by-hand",
        negative: true,
        fields: [
          'pool = "running"',
          "runBoot = 1",
          "boot = 3",
          'owner = "dead"',
        ],
        // TLC's two workers may report the same dead end one boot later, after
        // an extra `runtime up` and stop before the start (fault bound 3).
        alternativeWitnesses: [
          ['pool = "running"', "runBoot = 2", "boot = 4", 'owner = "dead"'],
          ['pool = "running"', "runBoot = 1", "boot = 4", 'owner = "dead"'],
        ],
      },
      {
        name: "strict",
        negative: true,
        fields: [
          'pool = "running"',
          "runBoot = 1",
          "boot = 3",
          'owner = "dead"',
        ],
      },
      {
        name: "crash-in-recovery",
        negative: true,
        fields: [
          'pool = "running"',
          "runBoot = 1",
          "boot = 3",
          "recovering = TRUE",
        ],
        alternativeWitnesses: [
          ['pool = "running"', "runBoot = 2", "boot = 4", "recovering = TRUE"],
        ],
      },
      // The shared HTTPS owner (HACK-2456, seen on a real VM). `https` is this
      // change for a project with HTTPS routes. Each control turns one part off:
      // the owner never retires when its boot ends, the previous-boot archive
      // cannot prove quiescence, or down --recover does not start a stopped pool
      // for a pending finalization. Each strands the recovered run's lease.
      { name: "https", negative: false, states: 608 },
      {
        name: "https-no-retire",
        negative: true,
        fields: ['https = "live"', "fin = TRUE", 'pool = "running"'],
      },
      {
        name: "https-archive",
        negative: true,
        fields: ['https = "records"', "fin = TRUE", 'pool = "running"'],
      },
      {
        // HACK-2550: a completed recovery whose archive could not run before its
        // boot ended (z338, z282) is stranded when the archive stays bound to
        // the recovery's own boot.
        name: "https-finish-bound",
        negative: true,
        fields: ['https = "records"', "fin = TRUE", 'pool = "running"'],
      },
      {
        name: "https-stopped",
        negative: true,
        // All first violations have a retired HTTPS owner and a free port.
        fields: stoppedHttpsWitnessFields,
      },
      {
        // HACK-2550: the archive's port claim binds with address reuse so the
        // retired Caddy's TIME_WAIT does not block it; binding the wildcard alone,
        // without the exact claim of every local address, it would archive over
        // a live specific-address listener.
        name: "reuse-no-check",
        negative: true,
        invariant: "NoArchiveOverListener",
        fields: ['port = "listener"', "overListener = TRUE", 'https = "none"'],
      },
      // HACK-2535: another project's `up` stops an idle running pool to add its
      // share. A run that became live before that stop is never stopped by it;
      // without the second idle check right before the guest stops, a start
      // between the two checks is.
      { name: "idle-restart", negative: false, states: 302 },
      {
        name: "idle-restart-one-check",
        negative: true,
        invariant: "NoRestartOverLiveRun",
        fields: ["stoppedLive = TRUE", 'pool = "stopped"', 'run = "ready"'],
      },
      // HACK-2477: a plain `runtime down` refuses while a run is live; only
      // `--force` stops the pool under it. Without the refusal the plain down
      // stops the pool under a ready run.
      {
        name: "down-no-refusal",
        negative: true,
        invariant: "NoDownOverLiveRun",
        fields: ["downOverLive = TRUE", 'pool = "stopped"', 'run = "ready"'],
      },
    ],
  },
  {
    // HACK-2524: release a checkout's run mapping whose native home is gone. The
    // positive control releases when the path no longer holds the home and no
    // process names it; `negative` is today (the clean-stop release from the
    // home's own records), which strands a deleted, moved or replaced home.
    // The recorded path can be replaced before the old processes exit.
    // `path-only` ignores the
    // process scan and releases while the home's run is still alive.
    name: "native-run-mapping-release",
    module: "MappingRelease",
    states: 21,
    invariant: "NoStrandedMapping",
    fields: ['home = "deleted"', 'mapping = "held"', "procs = FALSE"],
    alternativeWitnesses: [
      ['home = "moved"', 'mapping = "held"', "procs = FALSE"],
      ['home = "replaced"', 'mapping = "held"', "procs = FALSE"],
    ],
    additionalControls: [
      {
        name: "path-only",
        negative: true,
        invariant: "NeverReleaseLive",
        fields: ['mapping = "released"', "procs = TRUE", "unsafe = TRUE"],
      },
    ],
  },
  {
    name: "detached-pool-watch",
    module: "DetachedPoolWatch",
    states: 53,
    invariant: "NoStaleCleanup",
    fields: ['phase = "Settled"', "grace = 1", "graph = 2", "stopped = 2"],
    additionalControls: [
      {
        name: "unfenced-serve",
        negative: true,
        fields: [
          'phase = "Settled"',
          "selected = 2",
          "grace = 2",
          "graph = 3",
          "stopped = 3",
        ],
      },
    ],
  },
  {
    // HACK-2440 (c, d), HACK-2416: a patient first request, no failure on one
    // doubtful reading, and a host-side bound on "starting". Slow, refusing and
    // hanging apps; `legacy` runs the steady cadence before the first success.
    name: "probe-readiness",
    module: "ProbeReadiness",
    states: 175_757,
    invariant: "OneCompile",
    fields: ["restarts = 1", 'app = "slow"'],
    alternativeWitnesses: [["restarts = 1", 'app = "hanging"']],
    additionalControls: [
      { name: "legacy", negative: false, states: 132_615 },
      {
        name: "no-host-bound",
        negative: true,
        invariant: "BoundedStarting",
        fields: ['verdict = "starting"', "skewed = TRUE", "vt = 15"],
      },
      {
        name: "no-tolerance",
        negative: true,
        invariant: "NoFalseFailure",
        fields: ['verdict = "unhealthy"', 'app = "slow"'],
      },
      {
        // Reachability: the positive run does exhaust retries.
        name: "exhausts",
        negative: true,
        invariant: "NeverExhausted",
        fields: ['health = "unhealthy"', "failures = 2"],
      },
      {
        name: "tight-bound",
        negative: true,
        invariant: "NoPrematureFailure",
        fields: ['verdict = "unhealthy"', 'vh = "starting"'],
      },
    ],
  },
  {
    name: "pool-emulation",
    module: "Emulation",
    states: 13,
    invariant: "NoUntranslatedAmd64",
    fields: [
      "amd64 = TRUE",
      "intent = TRUE",
      "config = FALSE",
      "registered = FALSE",
      "engine = TRUE",
    ],
    additionalControls: [
      {
        name: "running-upgrade",
        negative: true,
        invariant: "EngineMatchesIntent",
        fields: [
          'phase = "running"',
          "intent = TRUE",
          "config = FALSE",
          "engine = TRUE",
        ],
      },
    ],
  },
  {
    name: "targeted-start",
    module: "TargetedStart",
    states: 1229,
    invariant: "OwnedEffects",
    fields: [
      'phase = "Extending"',
      'receipt = {"web", "redis"}',
      "containers = [web |-> 1, cache |-> 2, redis |-> 0, api |-> 0, unused |-> 0]",
    ],
    additionalControls: [
      {
        name: "replace-existing",
        negative: true,
        invariant: "PreserveExisting",
        fields: [
          'phase = "Extending"',
          "containers = [web |-> 2, cache |-> 0, redis |-> 0, api |-> 0, unused |-> 0]",
        ],
      },
      {
        name: "unproved-cancellation",
        negative: true,
        invariant: "ConfirmedCancelHasReply",
        fields: [
          'phase = "Extending"',
          'client = "Confirmed"',
          'reply = "None"',
        ],
      },
    ],
  },
  // The CI tier bounds one VM boot with two specs; positive-reboot covers two
  // boots with one spec. Witnesses omit `cur` and `intents`: the initial spec
  // value is free and two-worker TLC reports either one.
  {
    name: "start-graph",
    module: "StartGraph",
    states: 1_656_372,
    invariant: "NoEffectWithoutIntent",
    fields: ["intents = {}", "acted = TRUE", 'up = "running"'],
    additionalControls: [
      { name: "positive-reboot", negative: false, states: 81_534 },
      {
        name: "ignore-deps",
        negative: true,
        invariant: "DepsBeforeStart",
        fields: [
          startGraphBad("start"),
          "rgen = [a |-> 0, b |-> 1]",
          'up = "running"',
        ],
      },
      {
        name: "no-publish-fence",
        negative: true,
        invariant: "NoPublishToReplaced",
        fields: [startGraphBad("publish"), "route = [a |-> 1, b |-> 0]"],
      },
      {
        name: "reuse-by-name",
        negative: true,
        invariant: "ReturnIsCurrent",
        fields: [startGraphBad("return"), "boot = 1", 'up = "returned"'],
      },
      {
        name: "no-unpublish",
        negative: true,
        invariant: "NoReplaceWhileRouted",
        fields: [
          startGraphBad("replace"),
          "route = [a |-> 1, b |-> 0]",
          "nextGen = [a |-> 3, b |-> 1]",
        ],
      },
      {
        name: "keep-across-boot",
        negative: true,
        invariant: "ReturnIsCurrent",
        // Without the boot fence a dependent may also start on a stale
        // dependency, so both flags are set.
        fields: [
          startGraphBad("start", "return"),
          "boot = 2",
          'up = "returned"',
        ],
        alternativeWitnesses: [
          [startGraphBad("return"), "boot = 2", 'up = "returned"'],
        ],
      },
      {
        name: "blind-retry",
        negative: true,
        invariant: "OneContainerPerService",
        fields: ["rgen = [a |-> 2, b |-> 0]", "nextGen = [a |-> 3, b |-> 1]"],
        alternativeWitnesses: [
          ["rgen = [a |-> 0, b |-> 2]", "nextGen = [a |-> 1, b |-> 3]"],
        ],
      },
      {
        // Reachability: an `up` that began on a current, ready and routed
        // project (`base`) returns without planning anything.
        name: "reachable-noop",
        negative: true,
        invariant: "NeverNoOpUp",
        fields: ["base = TRUE", "acted = FALSE", 'up = "returned"'],
      },
    ],
  },
  {
    // HACK-2461: when a stored step result may replace the work, when garbage
    // collection may delete it, and which digest a command uses for a tag.
    // `positive` is the boot class with drift; the slot and cas classes are
    // the two other positives. Each control removes one guard, except
    // `no-epoch`, which removes the boot id together with the observation (the
    // observation alone keeps boot skips sound). A `bad` flag is set only by the
    // action that breaks its invariant, so the flag identifies the failure.
    // `no-epoch` also pins the second boot to tell it from no-verify.
    name: "step-store",
    module: "StepStore",
    states: 1_082_240,
    invariant: "NoUnsoundSkip",
    fields: [
      "bad = [pull |-> FALSE, skip |-> TRUE, use |-> FALSE, mixed |-> FALSE, stale |-> FALSE]",
      "done = TRUE",
    ],
    additionalControls: [
      { name: "positive-slot", negative: false, states: 284_160 },
      { name: "positive-cas", negative: false, states: 184_320 },
      {
        name: "no-verify-slot",
        negative: true,
        fields: [
          "bad = [pull |-> FALSE, skip |-> TRUE, use |-> FALSE, mixed |-> FALSE, stale |-> FALSE]",
          "done = TRUE",
        ],
      },
      {
        name: "no-verify-boot",
        negative: true,
        fields: [
          "bad = [pull |-> FALSE, skip |-> TRUE, use |-> FALSE, mixed |-> FALSE, stale |-> FALSE]",
          "done = TRUE",
        ],
      },
      {
        name: "no-epoch",
        negative: true,
        fields: [
          "bad = [pull |-> FALSE, skip |-> TRUE, use |-> FALSE, mixed |-> FALSE, stale |-> FALSE]",
          "boot = 2",
          "world = {}",
        ],
      },
      {
        name: "late-key",
        negative: true,
        fields: [
          "bad = [pull |-> FALSE, skip |-> TRUE, use |-> FALSE, mixed |-> FALSE, stale |-> FALSE]",
          "done = TRUE",
        ],
      },
      {
        name: "no-pin",
        negative: true,
        invariant: "NoPruneInUse",
        fields: [
          "bad = [pull |-> FALSE, skip |-> FALSE, use |-> TRUE, mixed |-> FALSE, stale |-> FALSE]",
          "pruning = <<0, 0>>",
        ],
      },
      {
        name: "object-first",
        negative: true,
        fields: [
          "bad = [pull |-> FALSE, skip |-> TRUE, use |-> FALSE, mixed |-> FALSE, stale |-> FALSE]",
          "done = TRUE",
        ],
      },
      {
        name: "ignore-ttl",
        negative: true,
        invariant: "NoSilentStaleTag",
        fields: [
          "bad = [pull |-> FALSE, skip |-> FALSE, use |-> FALSE, mixed |-> FALSE, stale |-> TRUE]",
          "resolved = FALSE",
          "offline = FALSE",
        ],
      },
      {
        name: "resolve-per-use",
        negative: true,
        invariant: "OneDigestPerCommand",
        fields: [
          "bad = [pull |-> FALSE, skip |-> FALSE, use |-> FALSE, mixed |-> TRUE, stale |-> FALSE]",
          'cmd = "running"',
        ],
      },
    ],
  },
  {
    // HACK-2461: a file hash reused by stat key under the racy rule. `negative`
    // drops the racy check; `reachability` shows a reused hash is reachable.
    // Witnesses are the violating states themselves (see statKeyedHits).
    name: "stat-keyed-hash",
    module: "StatKeyedHash",
    states: 108_942,
    invariant: "HitIsFresh",
    ...statKeyedHits({ withCtime: true, stale: true }),
    additionalControls: [
      {
        name: "mtime-only",
        negative: true,
        ...statKeyedHits({ withCtime: false, stale: true }),
      },
      {
        name: "racy-at-store",
        negative: true,
        ...statKeyedHits({ withCtime: true, stale: true }),
      },
      {
        name: "reachability",
        negative: true,
        invariant: "NeverHits",
        ...statKeyedHits({ withCtime: true, stale: false }),
      },
    ],
  },
  {
    name: "native-image-batch",
    module: "ImageBatch",
    states: 3233,
    invariant: "Safe",
    ...imageBatchImportOverlap(),
  },
  {
    name: "native-image-presence",
    module: "ImagePresence",
    states: 7712,
    invariant: "Safe",
    fields: [
      'phase = "ready"',
      'source = "cached"',
      'receipt = "complete"',
      "observed = FALSE",
    ],
    additionalControls: [
      {
        name: "expired-tag",
        negative: true,
        invariant: "TagSafe",
        fields: [
          'mode = "normal"',
          'recorded = "expired"',
          'chose = "recorded"',
        ],
      },
      {
        // HACK-2534. Restores the separate digest pass a cached archive took
        // before import; import's validation already hashes every byte.
        name: "early-digest",
        negative: true,
        invariant: "CachedSingleRead",
        fields: ['source = "cached"', "reads = 2"],
      },
      {
        name: "eviction",
        negative: true,
        invariant: "NeverEvictionRefusal",
        fields: [
          'phase = "create_refused"',
          'guest = "absent"',
          "observed = TRUE",
        ],
      },
      {
        name: "reachability",
        negative: true,
        invariant: "NeverSkipsRead",
        fields: [
          'phase = "ready"',
          'receipt = "complete"',
          'guest = "present"',
          "verified = FALSE",
          "observed = TRUE",
        ],
        alternativeWitnesses: [
          [
            'phase = "ready"',
            'receipt = "loading"',
            'guest = "present"',
            "verified = FALSE",
            "observed = TRUE",
          ],
          [
            'phase = "ready"',
            'receipt = "none"',
            'guest = "present"',
            "verified = FALSE",
            "observed = TRUE",
          ],
        ],
      },
    ],
  },
  {
    // HACK-2460. One runtime service per native home. The negative control
    // binds the socket without holding service.lock.
    name: "runtime-service",
    module: "RuntimeService",
    states: 1_006_849,
    invariant: "LockedOwner",
    fields: ["lock = 0", "svcLease = 0"],
    alternativeWitnesses: ["lock = 1", "lock = 2"].map((lock) => [
      lock,
      "svcLease = 0",
    ]),
    additionalControls: [
      {
        // The effect runs before the durable intent record: a crash after
        // the effect and a resend run it again.
        name: "effect-before-accept",
        negative: true,
        invariant: "AtMostOnce",
        ...runtimeServiceEither((me) => [
          pairOf("effects", me, "2", "0"),
          'intent = (c1 :> "none" @@ c2 :> "none")',
        ]),
      },
      {
        // A resent intent id is admitted again instead of answered.
        name: "no-dedupe",
        negative: true,
        invariant: "AtMostOnce",
        ...runtimeServiceEither((me) => [
          pairOf("effects", me, "2", "0"),
          "oneLease = NoClient",
        ]),
      },
      {
        // The one-shot fallback while a written frame is still unsure. The
        // second effect is either the one-shot start or the buffered frame's.
        name: "fallback-after-send",
        negative: true,
        invariant: "AtMostOnce",
        ...runtimeServiceEither(
          (me) => [pairOf("effects", me, "2", "0"), "svcLease = 0"],
          (me) => [pairOf("effects", me, "2", "0"), "oneLease = NoClient"]
        ),
      },
      {
        // A service of another build admits a mutation.
        name: "ignore-skew",
        negative: true,
        invariant: "SameBuild",
        fields: ["svcLease = 0", "effects = (c1 :> 0 @@ c2 :> 0)"],
      },
      {
        // One-shot inspection while a service process still holds the lock:
        // after "not done", the service reads the buffered frame and starts it.
        name: "inspect-while-held",
        negative: true,
        invariant: "ReportHonest",
        ...runtimeServiceEither((me) => [
          pairOf("report", me, '"notdone"', '"none"'),
          pairOf("world", me, '"started"', '"none"'),
        ]),
      },
      {
        // Reachability: the "outcome unknown" answer happens.
        name: "reach-unknown",
        negative: true,
        invariant: "NeverUnknown",
        fields: ["svcLease = 0", "effects = (c1 :> 0 @@ c2 :> 0)"],
      },
      {
        // Reachability: an honest "not done" after inspection happens.
        name: "reach-not-done",
        negative: true,
        invariant: "NeverNotDone",
        fields: ["lock = 0", "effects = (c1 :> 0 @@ c2 :> 0)"],
      },
      {
        // Reachability: a one-shot fallback completes and frees the lease.
        name: "reach-one-shot",
        negative: true,
        invariant: "NeverOneShotDone",
        fields: [
          "svcLease = 0",
          "oneLease = NoClient",
          'intent = (c1 :> "none" @@ c2 :> "none")',
        ],
      },
      {
        // Reachability: inspection of work that started and did not
        // complete reports "unknown".
        name: "reach-inconclusive",
        negative: true,
        invariant: "NeverInconclusive",
        ...runtimeServiceEither((me) => [
          pairOf("report", me, '"unknown"', '"none"'),
          pairOf("world", me, '"started"', '"none"'),
        ]),
      },
    ],
  },
];

/** A first parallel-import violation has two importers among four jobs. */
function imageBatchImportOverlap(): {
  readonly fields: WitnessFields;
  readonly alternativeWitnesses: readonly WitnessFields[];
} {
  // A failed job may have stopped before or after its archive was verified.
  const jobStates = [
    { phase: "queued", verified: false, worker: false },
    { phase: "fetch", verified: false, worker: true },
    { phase: "ready", verified: true, worker: true },
    { phase: "import", verified: true, worker: true },
    { phase: "confirmed", verified: true, worker: false },
    { phase: "failed", verified: false, worker: false },
    { phase: "failed", verified: true, worker: false },
  ] as const;
  const combinations = [1, 2, 3, 4].reduce<(typeof jobStates)[number][][]>(
    (prefixes) =>
      prefixes.flatMap((prefix) => jobStates.map((job) => [...prefix, job])),
    [[]]
  );
  const [fields, ...alternativeWitnesses] = combinations
    .filter(
      (jobs) =>
        jobs.filter(({ phase }) => phase === "import").length === 2 &&
        jobs.filter(({ worker }) => worker).length <= 3
    )
    .map((jobs) => [
      `phase = <<${jobs.map(({ phase }) => `"${phase}"`).join(", ")}>>`,
      `verified = {${jobs.flatMap(({ verified }, index) => (verified ? [index + 1] : [])).join(", ")}}`,
    ]);
  if (!fields) {
    throw new Error("Missing image batch import overlap states.");
  }
  return { fields, alternativeWitnesses };
}

/**
 * StatKeyedHash witnesses: every state in which a lookup would hit, written out
 * over the controls' finite bounds (times 0..4, contents "A"/"B"). A hit is a
 * valid entry whose key equals the current stat key; with `stale` its hash also
 * differs from the content, which is exactly a `HitIsFresh` violation.
 */
function statKeyedHits(opts: {
  readonly withCtime: boolean;
  readonly stale: boolean;
}): {
  readonly fields: WitnessFields;
  readonly alternativeWitnesses: readonly WitnessFields[];
} {
  const times = [0, 1, 2, 3, 4];
  const other = (hash: string): string => (hash === "A" ? "B" : "A");
  const [fields, ...alternativeWitnesses] = times.flatMap((mtime) =>
    (opts.withCtime ? times : [0]).flatMap((ctime) =>
      ["A", "B"].map((hash) => [
        `entry = [valid |-> TRUE, key |-> <<${mtime}, ${ctime}>>, hash |-> "${hash}"]`,
        `mtime = ${mtime}`,
        ...(opts.withCtime ? [`ctime = ${ctime}`] : []),
        ...(opts.stale ? [`content = "${other(hash)}"`] : []),
      ])
    )
  );
  if (!fields) {
    throw new Error("Missing stat-keyed hash witness states.");
  }
  return { fields, alternativeWitnesses };
}

export const runtimeModels = contracts.map((contract) => ({
  ...contract,
  verify: (result: ModelResult) =>
    verifyFiniteModelResult({ ...result, ...contract }),
  additionalControls: (contract.additionalControls ?? []).map((control) => {
    const selected = {
      ...control,
      states: control.states ?? contract.states,
      invariant: control.invariant ?? contract.invariant,
      fields: control.fields ?? contract.fields,
    };
    return {
      ...selected,
      verify: (result: ModelResult) =>
        verifyFiniteModelResult({ ...selected, ...result }),
    };
  }),
}));

/** Config names are fixed case metadata, never filesystem paths. */
export function runtimeModelControlConfig(name: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error("Invalid runtime model control name.");
  }
  return `${name}.cfg`;
}
