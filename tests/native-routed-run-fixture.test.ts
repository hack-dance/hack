import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeRoutedRunPinnedOriginCheck,
  nativeRoutedRunRemovalScript,
} from "./e2e/scenarios/native-config-routed-run.ts";
import {
  nativeRoutingFixtureVolumeMatches,
  nativeRoutingFixtureVolumeSelectionMatches,
} from "./e2e/scenarios/native-config-routing.ts";

const roots: string[] = [];
const MAIN = "a".repeat(64);
const ONE = "b".repeat(64);
const OWNER = "c".repeat(32);
const GENERATION = "d".repeat(32);
const PROJECT = "fixture-routed-removal";
const FACTS = `${OWNER}|${PROJECT}|${GENERATION}|True|exited|17`;

test("pending routed-run checks use exact preverified origins without CLI origin selection", async () => {
  const origins = ["https://primary.test", "https://oauth.test"];
  const calls: string[][] = [];
  let ingress = 0;
  const check = nativeRoutedRunPinnedOriginCheck({
    checkouts: [
      { root: "/primary", marker: "primary", origins },
      {
        root: "/sibling",
        marker: "sibling",
        origins: ["https://sibling.test"],
      },
    ],
    tls: async (origin, marker) => {
      calls.push([origin, marker]);
    },
    assertIngress: async () => {
      ingress += 1;
    },
  });
  origins.push("https://changed.test");
  await check({ root: "/primary", marker: "primary" });
  await check({ root: "/sibling", marker: "sibling" });
  expect(calls).toEqual([
    ["https://primary.test", "primary"],
    ["https://oauth.test", "primary"],
    ["https://sibling.test", "sibling"],
  ]);
  expect(ingress).toBe(2);
  await expect(check({ root: "/foreign", marker: "primary" })).rejects.toThrow(
    "unpinned"
  );
  await expect(check({ root: "/primary", marker: "foreign" })).rejects.toThrow(
    "unpinned"
  );
  expect(calls).toHaveLength(3);
  expect(() =>
    nativeRoutedRunPinnedOriginCheck({
      checkouts: [
        { root: "/primary", marker: "primary", origins: [] },
        { root: "/primary", marker: "sibling", origins: [] },
      ],
      tls: async () => {},
      assertIngress: async () => {},
    })
  ).toThrow("distinct");
});
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture(
  opts: { readonly facts?: string; readonly block?: boolean } = {}
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-routed-removal-fence-"))
  );
  roots.push(root);
  const engine = join(root, "engine");
  const mutated = join(root, "engine-mutation");
  await Bun.write(
    engine,
    `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==="container"&&args[1]==="inspect") {console.log(${JSON.stringify(opts.facts ?? FACTS)});process.exit(0);}
await Bun.write(${JSON.stringify(mutated)},JSON.stringify(args));
`
  );
  await chmod(engine, 0o700);
  const receipt = join(root, "owned-id");
  const shim = join(root, "shim");
  await Bun.write(
    shim,
    nativeRoutedRunRemovalScript({
      engine,
      receipt,
      owner: OWNER,
      project: PROJECT,
      generationId: GENERATION,
      mainId: MAIN,
      block: opts.block ?? false,
    })
  );
  await chmod(shim, 0o700);
  const invoke = async (args: readonly string[]) => {
    const child = Bun.spawn([shim, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exit: await child.exited, output: (await output).join("") };
  };
  return { receipt, mutated, invoke };
}

test("fixture removal permits only the completed exact one-off ID and forwards unchanged argv", async () => {
  const { receipt, mutated, invoke } = await fixture();
  expect((await invoke(["container", "rm", ONE])).exit).toBe(0);
  expect((await Bun.file(receipt).text()).trim()).toBe(ONE);
  expect(await Bun.file(mutated).json()).toEqual(["container", "rm", ONE]);
  expect((await invoke(["container", "rm", ONE])).exit).toBe(98);
});

test.each(
  [
    ["container", "rm", "--force", ONE],
    ["container", "rm", "-f", ONE],
    ["container", "rm", ONE, MAIN],
    ["container", "rm", MAIN],
    ["container", "rm", "short-id"],
    ["container", "rm", "x".repeat(64)],
    ["container", "rm"],
  ].map((args) => ({ args }))
)("fixture rejects unsafe rm argv $args without any engine mutation", async ({
  args,
}) => {
  const { receipt, mutated, invoke } = await fixture();
  expect((await invoke(args)).exit).toBe(98);
  expect(await Bun.file(receipt).exists()).toBe(false);
  expect(await Bun.file(mutated).exists()).toBe(false);
});

test.each([
  FACTS.replace(OWNER, "e".repeat(32)),
  FACTS.replace(PROJECT, "foreign-project"),
  FACTS.replace(GENERATION, "e".repeat(32)),
  FACTS.replace("True", "False"),
  FACTS.replace("exited", "running"),
  FACTS.replace("|17", "|0"),
  "malformed private-canary",
])("fixture refuses forged or incomplete one-off facts without mutation", async (facts) => {
  const { receipt, mutated, invoke } = await fixture({ facts });
  const result = await invoke(["container", "rm", ONE]);
  expect(result.exit).toBe(98);
  expect(result.output).not.toContain("private-canary");
  expect(await Bun.file(receipt).exists()).toBe(false);
  expect(await Bun.file(mutated).exists()).toBe(false);
});

test("fixture failed-removal control records only its proven exited one-off and never forwards rm", async () => {
  const { receipt, mutated, invoke } = await fixture({
    block: true,
    facts: FACTS.replace("|17", "|0"),
  });
  expect((await invoke(["container", "rm", ONE])).exit).toBe(71);
  expect((await Bun.file(receipt).text()).trim()).toBe(ONE);
  expect(await Bun.file(mutated).exists()).toBe(false);
});

test("fixture volume cleanup requires its declared physical name, storage and valid creation identity", () => {
  const owner = { composeProject: PROJECT, ownerToken: OWNER };
  const value = {
    name: "fixture-state",
    createdAt: "2026-10-08T01:00:00Z",
    labels: {
      "io.hack.native-config.owner": OWNER,
      "io.hack.native-config.instance": PROJECT,
      "com.docker.compose.project": PROJECT,
      "io.hack.native-config.storage": "state",
    },
  };
  const matches = (candidate: unknown) =>
    nativeRoutingFixtureVolumeMatches({
      value: candidate,
      name: value.name,
      owner,
    });
  expect(matches(value)).toBe(true);
  expect(matches({ ...value, name: "extra-same-owner" })).toBe(false);
  expect(matches({ ...value, createdAt: null })).toBe(false);
  expect(matches({ ...value, createdAt: "invalid" })).toBe(false);
  for (const label of Object.keys(value.labels)) {
    expect(
      matches({ ...value, labels: { ...value.labels, [label]: "foreign" } })
    ).toBe(false);
  }
  const pin = { name: value.name, createdAt: value.createdAt };
  expect(nativeRoutingFixtureVolumeSelectionMatches([], pin)).toBe(false);
  expect(nativeRoutingFixtureVolumeSelectionMatches([], undefined)).toBe(true);
  expect(nativeRoutingFixtureVolumeSelectionMatches([value.name], pin)).toBe(
    true
  );
  expect(
    nativeRoutingFixtureVolumeSelectionMatches(
      [value.name, "extra-same-owner"],
      pin
    )
  ).toBe(false);
  expect(nativeRoutingFixtureVolumeSelectionMatches(["replacement"], pin)).toBe(
    false
  );
  expect(
    nativeRoutingFixtureVolumeSelectionMatches([value.name], undefined)
  ).toBe(false);
});
