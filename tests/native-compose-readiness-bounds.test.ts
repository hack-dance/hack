/**
 * HACK-1305: pins the Compose startup readiness bounds that #362 (HACK-1279) added in
 * `waitNativeComposeStartupOwned` and `queryNativeComposeOwned`:
 *
 * 1. A readiness timeout never becomes success, even when the post-deadline `settled`
 *    check finds every member owned and ready.
 * 2. The `transient` flag (`first.transient || second.transient || recheck placeholders`,
 *    latched per observation) runs the `settled` check exactly when the last in-loop
 *    observation depended on a shape that `settled` refuses.
 * 3. Every read that does not opt into `transient` membership keeps the strict behavior:
 *    strict and saved reads refuse every restart-race shape, and `settled` refuses the
 *    `running` shapes while still admitting `restarting` shapes exactly as before #362.
 *
 * The fake Docker serves one scripted scan per inspect call, so each query's first scan
 * and recheck are exact. The readiness clock is virtual: `Bun.sleep` (the poll interval)
 * advances `Date.now` past the deadline after a chosen number of in-loop observations, so
 * the number of observations and the presence of the `settled` query are deterministic.
 * No engine, HOME or Docker socket is reached: PATH holds only the fake.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNativeComposeOwned,
  NativeComposeOwnershipError,
  type NativeComposeOwnershipObservation,
  type NativeComposeOwnershipOptions,
  type NativeComposeTopologyPredicate,
  nativeComposeOwnershipRefusal,
  nativeComposeTopologyPredicate,
  observeNativeComposeStartupOwned,
  observeSavedNativeComposeOwned,
  waitNativeComposeStartupOwned,
} from "../src/lib/native-compose-ownership.ts";
import { restoreEnv } from "./helpers/env.ts";

const PROJECT = "hack-fixture-instance";
const NETWORK = `${PROJECT}_default`;
const OWNER = "0".repeat(32);
const GENERATION = "a".repeat(32);
const WEB_ID = "c".repeat(64);
const RETRY_ID = "3".repeat(64);
const NETWORK_ID = "d".repeat(64);
const PLACEHOLDER_KEY = `ep-${"9".repeat(64)}`;
/**
 * Every query spawns about a dozen cold fake Docker processes, and one scenario runs up to
 * sixteen queries. Budget host start-up on a loaded runner, not the product: each query gets
 * the largest probe budget, and each test several of them.
 */
const PROBE_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 300_000;
/** Far beyond any scenario: only the virtual clock ever passes it. */
const DEADLINE_MS = 600_000;

const options: NativeComposeOwnershipOptions = {
  composeProject: PROJECT,
  runtimeIdentity: PROJECT,
  ownerToken: OWNER,
  generationIds: [GENERATION],
  expectedServices: ["web", "retry"],
  expectedNetwork: NETWORK,
  timeoutMs: PROBE_TIMEOUT_MS,
};
/** `retry` is the only selected on-failure service, as in the process-policy fixture. */
const ON_FAILURE = ["retry"];

/**
 * How one scan observes `retry` (inspected state, bridge key). `web` is always a running,
 * healthy container-ID member.
 */
type RetryScan =
  | "member"
  | "absent-running"
  | "absent-restarting"
  | "placeholder-running"
  | "placeholder-restarting";
type Scan = {
  readonly container: Record<string, unknown>[];
  readonly network: Record<string, unknown>[];
};
/** One startup query: its first scan, then its recheck. */
type Query = readonly [RetryScan, RetryScan];

let root: string;
let path: string | undefined;
let restoreClock: (() => void) | undefined;

beforeEach(async () => {
  path = process.env.PATH;
  root = await mkdtemp(join(tmpdir(), "native-compose-readiness-bounds-"));
  process.env.PATH = root;
  // Inspect call N of a kind serves scans[N] (clamped to the last scan). `ls` serves the
  // fixed inventory, so only inspected state and bridge keys change between scans.
  await Bun.write(
    join(root, "docker"),
    `#!${process.execPath}
import {appendFileSync, existsSync, readFileSync, writeFileSync} from "node:fs";
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
appendFileSync(root + "/commands", JSON.stringify(args) + "\\n");
const {scans} = JSON.parse(readFileSync(root + "/fixture.json", "utf8"));
const [kind, action] = args;
if (!["container","volume","network"].includes(kind) || !["ls","inspect"].includes(action) || !args.includes("--format")) {
 writeFileSync(root + "/mutated", "unexpected engine mutation"); process.exit(99);
}
if (kind === "volume") process.exit(0);
if (action === "ls") {
 for (const row of scans[0][kind]) console.log(JSON.stringify({id: row.id, name: row.name.replace(/^\\//, ""), project: row.project}));
 process.exit(0);
}
const counter = root + "/inspects-" + kind;
const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
writeFileSync(counter, String(count + 1));
const rows = scans[Math.min(count, scans.length - 1)][kind];
for (const id of args.slice(args.indexOf("--format") + 2)) {
 const row = rows.find(row => row.id === id); if (!row) process.exit(1); console.log(JSON.stringify(row));
}
`
  );
  await chmod(join(root, "docker"), 0o700);
});

afterEach(async () => {
  restoreClock?.();
  restoreClock = undefined;
  restoreEnv("PATH", path);
  await rm(root, { recursive: true, force: true });
});

function container(
  id: string,
  service: string,
  state: string
): Record<string, unknown> {
  return {
    id,
    name: `/${PROJECT}-${service}-1`,
    project: PROJECT,
    version: "1",
    instance: PROJECT,
    owner: OWNER,
    generation: GENERATION,
    service,
    oneoff: "False",
    state,
    exitCode: state === "restarting" ? 17 : 0,
    health: service === "web" ? "healthy" : null,
    networks: {
      [NETWORK]: {
        NetworkID: NETWORK_ID,
        Aliases: [`${PROJECT}-${service}-1`, service],
      },
    },
  };
}

function scan(retry: RetryScan): Scan {
  const members: Record<string, unknown> = {
    [WEB_ID]: { Name: `${PROJECT}-web-1` },
  };
  if (retry === "member") {
    members[RETRY_ID] = { Name: `${PROJECT}-retry-1` };
  } else if (retry.startsWith("placeholder-")) {
    members[PLACEHOLDER_KEY] = { Name: `${PROJECT}-retry-1` };
  }
  return {
    container: [
      container(WEB_ID, "web", "running"),
      container(
        RETRY_ID,
        "retry",
        retry.endsWith("restarting") ? "restarting" : "running"
      ),
    ],
    network: [
      {
        id: NETWORK_ID,
        name: NETWORK,
        project: PROJECT,
        version: "1",
        instance: PROJECT,
        owner: OWNER,
        driver: "bridge",
        internal: false,
        containers: members,
      },
    ],
  };
}

/** Script the queries in call order; the last scan repeats for any further inspect. */
async function serve(...queries: readonly Query[]): Promise<void> {
  await Promise.all(
    ["container", "network"].map((kind) =>
      rm(join(root, `inspects-${kind}`), { force: true })
    )
  );
  await rm(join(root, "commands"), { force: true });
  await Bun.write(
    join(root, "fixture.json"),
    JSON.stringify({ scans: queries.flat().map(scan) })
  );
}

/** Inspect calls so far; a complete query inspects each kind twice (4 calls). */
async function inspects(): Promise<number> {
  if (!(await Bun.file(join(root, "commands")).exists())) {
    return 0;
  }
  return (await readFile(join(root, "commands"), "utf8"))
    .trim()
    .split("\n")
    .filter((line) => (JSON.parse(line) as string[])[1] === "inspect").length;
}

/**
 * Virtual readiness clock: the poll interval (`Bun.sleep`) returns at once, and the
 * `observations`-th poll advances `Date.now` past {@link DEADLINE_MS}. The wait then makes
 * exactly `observations` in-loop observations. The clock only moves between queries, so
 * each query's own probe deadline is unaffected.
 */
function virtualDeadline(observations: number): void {
  const realNow = Date.now;
  let offset = 0;
  let polls = 0;
  const now = spyOn(Date, "now").mockImplementation(
    () => realNow.call(Date) + offset
  );
  const sleep = spyOn(Bun, "sleep").mockImplementation(async () => {
    polls++;
    if (polls >= observations) {
      offset += 2 * DEADLINE_MS;
    }
  });
  restoreClock = () => {
    now.mockRestore();
    sleep.mockRestore();
  };
}

async function waitStartup(opts: {
  readonly observations: number;
  readonly ready?: (state: NativeComposeOwnershipObservation) => boolean;
  readonly observed?: NativeComposeOwnershipObservation[];
}): Promise<NativeComposeOwnershipObservation | null> {
  virtualDeadline(opts.observations);
  try {
    return await waitNativeComposeStartupOwned({
      ownership: options,
      restartingServices: ON_FAILURE,
      deadline: Date.now() + DEADLINE_MS,
      ready: opts.ready ?? (() => true),
      observed: (state) => opts.observed?.push(state),
    });
  } finally {
    restoreClock?.();
    restoreClock = undefined;
  }
}

function expectTopologyRefusal(
  error: unknown,
  predicate: NativeComposeTopologyPredicate
): void {
  expect(error).toBeInstanceOf(NativeComposeOwnershipError);
  expect(error).toMatchObject({ code: "E_NATIVE_COMPOSE_OWNERSHIP" });
  expect(nativeComposeOwnershipRefusal(error)).toBe("topology");
  expect(nativeComposeTopologyPredicate(error)).toBe(predicate);
  expect(String(error)).not.toContain(PLACEHOLDER_KEY);
}

async function expectNoEngineMutation(): Promise<void> {
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
}

test(
  "the virtual readiness clock makes exactly the chosen number of in-loop observations",
  async () => {
    // Harness control: an owned, never-ready observation polls until the virtual deadline.
    for (const observations of [1, 3]) {
      await serve(["member", "member"]);
      const observed: NativeComposeOwnershipObservation[] = [];
      expect(
        await waitStartup({ observations, ready: () => false, observed })
      ).toBeNull();
      expect(observed).toHaveLength(observations);
      expect(await inspects()).toBe(4 * observations);
    }
    await expectNoEngineMutation();
  },
  TEST_TIMEOUT_MS
);

test(
  "a readiness timeout never becomes success, even when the settled check finds the member rejoined",
  async () => {
    // The last in-loop observation is the restart-backoff race (case 2): `retry` read
    // `running` and absent from its bridge. After the deadline the settled check reads
    // `retry` rejoined, so its observation is owned and every member is ready.
    await serve(["absent-running", "absent-running"], ["member", "member"]);
    const observed: NativeComposeOwnershipObservation[] = [];
    expect(await waitStartup({ observations: 1, observed })).toBeNull();
    // The settled query ran (two complete queries) but reported nothing as readiness.
    expect(await inspects()).toBe(8);
    expect(observed).toHaveLength(0);
    // The same holds for a case-1 recheck placeholder that has joined by the settled check.
    await serve(["member", "placeholder-running"], ["member", "member"]);
    expect(await waitStartup({ observations: 1, observed })).toBeNull();
    expect(await inspects()).toBe(8);
    expect(observed).toHaveLength(0);
    // An owned observation that is never ready times out unready: no settled query, and
    // the last unready observation is never returned.
    await serve(["member", "member"]);
    expect(
      await waitStartup({ observations: 2, ready: () => false, observed })
    ).toBeNull();
    expect(observed).toHaveLength(2);
    expect(await inspects()).toBe(8);
    await expectNoEngineMutation();
  },
  TEST_TIMEOUT_MS
);

/**
 * Each row isolates one disjunct of the query's `transient` flag. In-loop, the startup
 * query admits the shape (unready). After the deadline the settled check reads the same
 * shape again and refuses with the original predicate after `inspects` calls in total.
 */
const TRANSIENT_TERMS: readonly {
  readonly term: string;
  readonly query: Query;
  readonly predicate: NativeComposeTopologyPredicate;
  readonly inspects: number;
}[] = [
  {
    // first.transient only: read `running` and absent, then rejoined in the recheck.
    term: "first-scan running member without membership",
    query: ["absent-running", "member"],
    predicate: "live-endpoint-membership",
    inspects: 4 + 2,
  },
  {
    // second.transient only: a member in the first scan, `running` and absent in the recheck.
    term: "recheck running member without membership",
    query: ["member", "absent-running"],
    predicate: "live-endpoint-membership",
    inspects: 4 + 4,
  },
  {
    // Recheck placeholders only: a member in the first scan, then read `restarting` with an
    // `ep-` key (case 1). `restarting` sets neither scan's `transient`; only the recheck
    // placeholder term does, because settled refuses every recheck placeholder.
    term: "recheck placeholder for a restarting member",
    query: ["member", "placeholder-restarting"],
    predicate: "network-member-id",
    inspects: 4 + 4,
  },
];

test(
  "each transient-flag term alone runs the settled check, which refuses the unchanged shape",
  async () => {
    for (const row of TRANSIENT_TERMS) {
      // In-loop the shape is only unready.
      await serve(row.query);
      expect(
        await observeNativeComposeStartupOwned(options, ON_FAILURE)
      ).toBeNull();
      // Past the deadline the settled check reads the same shape and refuses.
      await serve(row.query, row.query);
      const observed: NativeComposeOwnershipObservation[] = [];
      const error = await waitStartup({ observations: 1, observed }).catch(
        (caught: unknown) => caught
      );
      expect([row.term, nativeComposeTopologyPredicate(error)]).toEqual([
        row.term,
        row.predicate,
      ]);
      expectTopologyRefusal(error, row.predicate);
      expect([row.term, await inspects()]).toEqual([row.term, row.inspects]);
      expect(observed).toHaveLength(0);
    }
    await expectNoEngineMutation();
  },
  TEST_TIMEOUT_MS
);

test(
  "restarting-only shapes are not transient: the wait times out unready without a settled check",
  async () => {
    for (const query of [
      // Restart backoff read `restarting` in both scans.
      ["absent-restarting", "absent-restarting"],
      // A first-scan placeholder for a `restarting` container that settled also admits; only
      // recheck placeholders are transient.
      ["placeholder-restarting", "absent-restarting"],
    ] as const satisfies readonly Query[]) {
      // If a settled check ran, it would read the case-2 race and refuse.
      await serve(query, ["absent-running", "absent-running"]);
      const observed: NativeComposeOwnershipObservation[] = [];
      expect(await waitStartup({ observations: 1, observed })).toBeNull();
      expect([query, await inspects()]).toEqual([query, 4]);
      expect(observed).toHaveLength(0);
    }
    await expectNoEngineMutation();
  },
  TEST_TIMEOUT_MS
);

test(
  "the transient flag follows the last in-loop observation, not an earlier one",
  async () => {
    // Transient first, then only `restarting` at the deadline: no settled check. A settled
    // check would read the case-2 race and refuse.
    await serve(
      ["absent-running", "absent-running"],
      ["absent-restarting", "absent-restarting"],
      ["absent-running", "absent-running"]
    );
    expect(await waitStartup({ observations: 2 })).toBeNull();
    expect(await inspects()).toBe(8);
    // Only `restarting` first, then transient at the deadline: the settled check runs and
    // refuses the race it reads.
    await serve(
      ["absent-restarting", "absent-restarting"],
      ["absent-running", "absent-running"],
      ["absent-running", "absent-running"]
    );
    const error = await waitStartup({ observations: 2 }).catch(
      (caught: unknown) => caught
    );
    expectTopologyRefusal(error, "live-endpoint-membership");
    expect(await inspects()).toBe(8 + 2);
    await expectNoEngineMutation();
  },
  TEST_TIMEOUT_MS
);

/** Restart-race shapes that only `transient` startup membership keeps unready. */
const RACE_SHAPES: readonly {
  readonly shape: string;
  readonly query: Query;
  readonly predicate: NativeComposeTopologyPredicate;
}[] = [
  {
    shape: "case 2: running and absent in both scans",
    query: ["absent-running", "absent-running"],
    predicate: "live-endpoint-membership",
  },
  {
    shape: "running placeholder in the first scan, rejoined in the recheck",
    query: ["placeholder-running", "member"],
    predicate: "network-member-id",
  },
  {
    shape: "case 1: member, then a running recheck placeholder",
    query: ["member", "placeholder-running"],
    predicate: "network-member-id",
  },
  {
    shape: "case 1: member, then a restarting recheck placeholder",
    query: ["member", "placeholder-restarting"],
    predicate: "network-member-id",
  },
];

test(
  "reads that do not opt into transient membership stay strict for every restart-race shape",
  async () => {
    for (const row of RACE_SHAPES) {
      await serve(row.query);
      expect(
        await observeNativeComposeStartupOwned(options, ON_FAILURE)
      ).toBeNull();
      const reads = [
        [
          "settled",
          () =>
            observeNativeComposeStartupOwned(options, ON_FAILURE, {
              membership: "settled",
            }),
        ],
        ["strict", () => assertNativeComposeOwned(options)],
        ["saved", () => observeSavedNativeComposeOwned(options)],
      ] as const;
      for (const [read, run] of reads) {
        await serve(row.query);
        const error = await run().catch((caught: unknown) => caught);
        expect([
          row.shape,
          read,
          nativeComposeTopologyPredicate(error),
        ]).toEqual([row.shape, read, row.predicate]);
        expectTopologyRefusal(error, row.predicate);
      }
    }
    await expectNoEngineMutation();
  },
  TEST_TIMEOUT_MS
);

test(
  "settled keeps the restarting admission from before #362 while strict and saved refuse it",
  async () => {
    for (const [query, predicate] of [
      [["absent-restarting", "absent-restarting"], "live-endpoint-membership"],
      [["placeholder-restarting", "absent-restarting"], "network-member-id"],
    ] as const satisfies readonly [Query, NativeComposeTopologyPredicate][]) {
      for (const membership of ["transient", "settled"] as const) {
        await serve(query);
        expect([
          query,
          membership,
          await observeNativeComposeStartupOwned(options, ON_FAILURE, {
            membership,
          }),
        ]).toEqual([query, membership, null]);
      }
      for (const run of [
        () => assertNativeComposeOwned(options),
        () => observeSavedNativeComposeOwned(options),
      ]) {
        await serve(query);
        expectTopologyRefusal(
          await run().catch((caught: unknown) => caught),
          predicate
        );
      }
    }
    // The startup default is `transient`; an unselected service is never admitted.
    await serve(["absent-running", "absent-running"]);
    expect(
      await observeNativeComposeStartupOwned(options, ON_FAILURE)
    ).toBeNull();
    await serve(["absent-running", "absent-running"]);
    expectTopologyRefusal(
      await observeNativeComposeStartupOwned(options, []).catch(
        (caught: unknown) => caught
      ),
      "live-endpoint-membership"
    );
    await expectNoEngineMutation();
  },
  TEST_TIMEOUT_MS
);
