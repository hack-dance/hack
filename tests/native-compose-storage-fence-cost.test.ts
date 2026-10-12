import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { openNativeComposeGenerationStore } from "../src/lib/native-compose-generation.ts";
import { fixture, invoke } from "./helpers/native-compose-command.ts";

const storage = { data: { kind: "persistent", scope: "worktree" } } as const;
const IDENTITY = JSON.stringify(["info", "--format", "{{json .ID}}"]);
// Every storage target observation lists volumes exactly twice (open and close).
const OBSERVATION = JSON.stringify([
  "volume",
  "ls",
  "--format",
  "{{json .Name}}",
]);
// Per storage proof (root, verify, root-after carriers) on this synthetic engine.
// Before X03: 86 engine-ID fences and 21 target observations per proof.
const PROOF_FENCES = 81;
const PROOF_OBSERVATIONS = 20;
// The command's saved file-engine observation reads the ID twice, unchanged.
const FILE_ENGINE_FENCES = 2;

const servers: Server[] = [];
const peers = new Set<Socket>();
afterEach(async () => {
  for (const peer of peers) {
    peer.destroy();
  }
  peers.clear();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
/** A real Unix `GET /info` endpoint for the same engine the synthetic CLI reports. */
async function engine(
  root: string,
  id: (request: number) => string = () => "fixture-engine"
) {
  const socket = join(root, "engine.sock");
  const client = join(root, "client");
  await mkdir(client, { mode: 0o700 });
  await writeFile(join(client, "config.json"), "{}\n", { mode: 0o600 });
  let served = 0;
  const server = createServer((req, res) => {
    const request = served++;
    if (req.method !== "GET" || req.url !== "/info") {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.end(JSON.stringify({ ID: id(request) }));
  });
  server.on("connection", (peer) => peers.add(peer));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  return {
    env: { DOCKER_HOST: `unix://${socket}`, DOCKER_CONFIG: client },
    served: () => served,
  };
}
async function lines(root: string, name: string): Promise<string[]> {
  const file = Bun.file(join(root, name));
  return (await file.exists())
    ? (await file.text()).trim().split("\n").filter(Boolean)
    : [];
}
async function counted(
  root: string,
  args: readonly string[],
  selected?: Awaited<ReturnType<typeof engine>>
) {
  const before = (await lines(root, "requests")).length;
  const direct = selected?.served() ?? 0;
  const result = await invoke(
    root,
    [...args],
    30_000,
    120_000,
    selected?.env ?? {}
  );
  const calls = (await lines(root, "requests")).slice(before);
  return {
    code: result.code,
    cli: calls.filter((line) => line === IDENTITY).length,
    direct: (selected?.served() ?? 0) - direct,
    observations: calls.filter((line) => line === OBSERVATION).length / 2,
  };
}
async function saved(root: string) {
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "saved",
  });
  try {
    return await store.loadCurrent();
  } finally {
    await store.close();
  }
}
async function enrolled() {
  const root = await fixture("", false, { storage, noHooks: true });
  expect((await invoke(root, undefined, 30_000, 120_000)).code).toBe(0);
  return root;
}

test("storage fence count per command: every proof kept, exact duplicates gone, one CLI admission", async () => {
  const root = await enrolled();
  // CLI transport (no explicit Unix selection): every fence is a `docker info`.
  expect(await counted(root, ["exec", "web", "--", "true"])).toEqual({
    code: 0,
    cli: FILE_ENGINE_FENCES + 2 * PROOF_FENCES,
    direct: 0,
    observations: 2 * PROOF_OBSERVATIONS,
  });
  expect(await counted(root, ["up", "--detach", "--json"])).toEqual({
    code: 0,
    cli: FILE_ENGINE_FENCES + 6 * PROOF_FENCES,
    direct: 0,
    observations: 6 * PROOF_OBSERVATIONS,
  });
  // Admitted Unix selection: the same fences, one fresh read each. Only the
  // first storage fence is a CLI read, checked against one extra direct read.
  const selected = await engine(root);
  expect(await counted(root, ["exec", "web", "--", "true"], selected)).toEqual({
    code: 0,
    cli: FILE_ENGINE_FENCES + 1,
    direct: 2 * PROOF_FENCES,
    observations: 2 * PROOF_OBSERVATIONS,
  });
  expect(await counted(root, ["up", "--detach", "--json"], selected)).toEqual({
    code: 0,
    cli: FILE_ENGINE_FENCES + 1,
    direct: 6 * PROOF_FENCES,
    observations: 6 * PROOF_OBSERVATIONS,
  });
}, 390_000);

test("a refused admission keeps every storage fence on the Docker CLI for the command", async () => {
  const root = await enrolled();
  // The socket answers for a different engine than the CLI's selection.
  const selected = await engine(root, () => "other-engine");
  expect(await counted(root, ["exec", "web", "--", "true"], selected)).toEqual({
    code: 0,
    cli: FILE_ENGINE_FENCES + 2 * PROOF_FENCES,
    direct: 1,
    observations: 2 * PROOF_OBSERVATIONS,
  });
}, 390_000);

test("a changed daemon ID between two admitted fences refuses before the workload", async () => {
  const root = await enrolled();
  const before = await saved(root);
  const carriers = await Bun.file(join(root, "carriers")).text();
  const operations = (await lines(root, "storage-operations")).length;
  // Admission reads the original ID; every later fence sees another engine.
  const selected = await engine(root, (request) =>
    request === 0 ? "fixture-engine" : "replacement-engine"
  );
  const requestsBefore = (await lines(root, "requests")).length;
  const result = await counted(root, ["up", "--detach", "--json"], selected);
  expect(result.code).toBe(1);
  // The admission and the next fence: the opening target observation refuses.
  expect(result.direct).toBe(2);
  const calls = (await lines(root, "requests")).slice(requestsBefore);
  expect(
    calls.some((line) => {
      const args: string[] = JSON.parse(line);
      return (
        args[0] === "compose" ||
        args[0] === "create" ||
        args[0] === "start" ||
        args[0] === "rm"
      );
    })
  ).toBe(false);
  expect((await lines(root, "storage-operations")).length).toBe(operations);
  expect(await Bun.file(join(root, "carriers")).text()).toBe(carriers);
  const after = await saved(root);
  expect(after.storageWitnesses).toEqual(before.storageWitnesses);
  expect(after.storageWitnessesPending).toBe(false);
  expect(after.pending).toBeNull();
}, 390_000);

test("a target change after the verify carrier's closing observation is still detected", async () => {
  const root = await enrolled();
  const events = (await lines(root, "storage-events")).length;
  // Change the selected volume right after the verify carrier's own closing
  // observation, where the witness's former duplicate re-observation stood.
  await writeFile(join(root, "fault-after-verify-close"), "0");
  const requestsBefore = (await lines(root, "requests")).length;
  const result = await counted(root, ["exec", "web", "--", "true"]);
  expect(await Bun.file(join(root, "fault-target-changed")).exists()).toBe(
    true
  );
  expect(result.code).not.toBe(0);
  // The carrier's closing observation (two listings, the change after the
  // second) completed; a later complete observation saw the change and refused.
  const calls = (await lines(root, "requests")).slice(requestsBefore);
  const removed = calls.findLastIndex(
    (line) => (JSON.parse(line) as string[])[0] === "rm"
  );
  expect(
    calls.slice(removed).filter((line) => line === OBSERVATION)
  ).toHaveLength(4);
  // The opening proof refused: no workload exec and no later proof ran.
  const after = (await lines(root, "storage-events")).slice(events);
  expect(after).not.toContain("exec");
  expect(after).toEqual(["root", "verify"]);
}, 390_000);
