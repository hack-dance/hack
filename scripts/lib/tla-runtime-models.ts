import { verifyFiniteModelResult } from "./tla-result.ts";

// Bounds and witnesses are reviewed contracts, not learned from each run.
const contracts = [
  {
    name: "relay-lifecycle-barrier",
    module: "Barrier",
    states: 1590,
    invariant: "NoUnretiredTarget",
    action: "BeginEffect",
    fields: [
      "unsafeCommit = TRUE",
      'phase = "effect-started"',
      "journal = TRUE",
      "ownerAlive = TRUE",
      "connections = {1, 2}",
    ],
  },
  {
    name: "relay-authorization",
    module: "Authorization",
    states: 7,
    invariant: "NoLateWrite",
    action: "Write",
    fields: ["active = FALSE", "lateWrite = TRUE", 'phase = "done"'],
  },
  {
    name: "mcp-startup-cancellation",
    module: "Cancellation",
    states: 10,
    invariant: "NoLatePublication",
    action: "Publish",
    fields: ["cancelled = TRUE", "latePublication = TRUE"],
  },
  {
    name: "mcp-startup",
    module: "Startup",
    states: 27,
    invariant: "NoRevokedGrant",
    action: "Timeout",
    fields: ["granted = TRUE", "killed = TRUE"],
  },
  {
    name: "authority-snapshot",
    module: "Routing",
    states: 11,
    invariant: "NoWrongReservation",
    action: "Connect",
    fields: ["observed = 1", "delivered = 2"],
  },
  {
    name: "authority-lifetime",
    module: "Lifetime",
    states: 9,
    invariant: "NoAuthorityAfterDown",
    action: "StartBind",
    fields: ["running = FALSE", "authority = TRUE"],
  },
  {
    name: "publication-journal",
    module: "Journal",
    states: 50,
    invariant: "Safe",
    action: "Recover",
    fields: ["alive = TRUE", "recoveredLive = TRUE"],
  },
  {
    name: "publication",
    module: "Publication",
    states: 16,
    invariant: "Safe",
    action: "Retire",
    fields: ['process = "native"', "intent = FALSE"],
  },
  {
    name: "fence-first",
    module: "First",
    negativeModule: "FirstBroken",
    states: 24,
    invariant: "Safe",
    action: "Recover",
    fields: ["occupied = TRUE", "recovered = TRUE"],
  },
  {
    name: "fence-pending",
    module: "Fence",
    negativeModule: "FenceBroken",
    states: 7,
    invariant: "Safe",
    action: "Recover",
    fields: ['phase = "stopped"', "alive = TRUE"],
  },
  {
    name: "relay-staging",
    module: "Stage",
    negativeModule: "StageBroken",
    states: 9,
    invariant: "Safe",
    action: "Discard",
    fields: ['phase = "discarded"', "alive = TRUE"],
  },
  {
    name: "relay-fence",
    module: "RelayFence",
    negativeModule: "RelayFenceBroken",
    states: 16,
    invariant: "Safe",
    action: "Launch",
    fields: ["retired = <<1>>", "alive = 1"],
  },
];

export const runtimeModels = contracts.map((contract) => ({
  ...contract,
  verify: (result: {
    negative: boolean;
    exitCode: number | null;
    output: string;
  }) => verifyFiniteModelResult({ ...result, ...contract }),
}));
