import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LegacyComposeRetainedFileError,
  type LegacyComposeRetainedFileProof,
  legacyComposeRetainedFileGrants,
  normalizeLegacyComposeRetainedFileCandidate,
  observeLegacyComposeRetainedFileProof,
  observeLegacyComposeRetainedFileSources,
  readLegacyComposeRetainedFileProof,
} from "../src/lib/native-compose-adoption-files.ts";
import {
  mapLegacyNativeAdoptionBaseline,
  mapLegacyNativeImport,
  mapLegacyNativeRetainedFileStorage,
  mapLegacyNativeStorageAdoption,
} from "../src/lib/native-config-import-plan.ts";

const ID = "a".repeat(64);
const CANARY = "synthetic-retained-protected-material\0binary";
let root: string;
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "retained-permission-proof-"))
  );
  await mkdir(join(root, "material"));
  await writeFile(join(root, "material/config"), "public-fixture", {
    mode: 0o444,
  });
  await writeFile(join(root, "material/secret"), CANARY, { mode: 0o600 });
});
afterEach(async () => await rm(root, { recursive: true, force: true }));

function source(mode?: unknown) {
  return {
    configText: '{"name":"fixture"}',
    composeText: JSON.stringify({
      name: "fixture",
      services: {
        app: {
          image: "example:pinned",
          configs: ["settings"],
          secrets: [
            {
              source: "token",
              target: "/run/token",
              ...(mode === undefined ? {} : { mode }),
            },
          ],
          volumes: ["data:/data"],
        },
      },
      configs: { settings: { file: "../material/config" } },
      secrets: { token: { file: "../material/secret" } },
      volumes: { data: { name: "fixture_data" } },
    }),
  };
}
function candidate(mode?: unknown) {
  const mapped = mapLegacyNativeRetainedFileStorage(source(mode));
  if (!mapped.candidate) {
    throw new Error("test candidate not issued");
  }
  return mapped.candidate;
}
function containers(running = true) {
  return [{ id: ID, service: "app", running }];
}
async function observed(opts: {
  readonly candidate: unknown;
  readonly mode: "0400" | "0600";
  readonly uid?: number;
  readonly gid?: number;
  readonly saved?: LegacyComposeRetainedFileProof;
  readonly running?: boolean;
  readonly wrongMode?: string;
}) {
  const sources = await observeLegacyComposeRetainedFileSources({
    projectRoot: root,
    candidate: opts.candidate,
  });
  const calls: string[][] = [];
  const proof = await observeLegacyComposeRetainedFileProof({
    projectRoot: root,
    candidate: opts.candidate,
    containers: containers(opts.running),
    ...(opts.saved === undefined ? {} : { saved: opts.saved }),
    probe: async (args) => {
      calls.push([...args]);
      expect(args[0]).toBe("exec");
      expect(args[1]).toBe(ID);
      const target = args.at(-1);
      const material = sources.find(
        (entry) =>
          entry.kind === (target === "/run/token" ? "secret" : "config")
      );
      if (!material) {
        throw new Error("unselected target");
      }
      const mode =
        target === "/run/token"
          ? (opts.wrongMode ?? opts.mode.slice(1))
          : "444";
      if (args[2] === "stat") {
        return `7:31:${opts.uid ?? 123}:${opts.gid ?? 321}:${material.size}:${(0o10_0000 | Number.parseInt(mode, 8)).toString(16)}:${mode}\n`;
      }
      expect(args[2]).toBe("sha256sum");
      return `${material.digest}  ${target}\n`;
    },
  });
  return { proof, calls };
}

test.each([
  "0400",
  "0600",
] as const)("omitted original secret mode earns exact %s only through private proof2", async (mode) => {
  const path = join(root, "material/secret");
  await chmod(path, Number.parseInt(mode, 8));
  const before = await stat(path);
  const input = candidate();
  const { proof, calls } = await observed({ candidate: input, mode });
  expect(proof.file_proof_version).toBe(2);
  if (proof.file_proof_version !== 2) {
    throw new Error("proof version missing");
  }
  expect(
    proof.policies.find((entry) => entry.kind === "secret")?.declaredMode
  ).toBeNull();
  expect(
    proof.guests.find((entry) => entry.target === "/run/token")
  ).toMatchObject({ mode, uid: 123, gid: 321 });
  const normalized = normalizeLegacyComposeRetainedFileCandidate({
    candidate: input,
    proof,
    containers: containers(),
  });
  expect(normalized.services).toMatchObject({
    app: {
      mounts: expect.arrayContaining([
        { secret: "token", target: "/run/token", access: "read-only", mode },
      ]),
    },
  });
  expect(input.services).toMatchObject({
    app: {
      mounts: expect.arrayContaining([
        {
          secret: "token",
          target: "/run/token",
          access: "read-only",
          mode: "0444",
        },
      ]),
    },
  });
  const after = await stat(path);
  expect([after.dev, after.ino, after.uid, after.gid, after.mode]).toEqual([
    before.dev,
    before.ino,
    before.uid,
    before.gid,
    before.mode,
  ]);
  expect(await readFile(path, "utf8")).toBe(CANARY);
  expect(calls).toHaveLength(6);
  expect(
    JSON.stringify(mapLegacyNativeRetainedFileStorage(source()).report)
  ).not.toContain(CANARY);
  expect(JSON.stringify(proof)).not.toContain(CANARY);
});

test("explicit permission must agree with both original source and guest without overriding source mode", async () => {
  const input = candidate("0600");
  const { proof } = await observed({ candidate: input, mode: "0600" });
  expect(proof.file_proof_version).toBe(2);
  await expect(
    observed({ candidate: input, mode: "0600", wrongMode: "400" })
  ).rejects.toThrow(LegacyComposeRetainedFileError);
  await expect(
    observed({ candidate: candidate("0400"), mode: "0400" })
  ).rejects.toThrow(LegacyComposeRetainedFileError);
  await expect(
    observeLegacyComposeRetainedFileSources({
      projectRoot: root,
      candidate: candidate("0444"),
    })
  ).rejects.toThrow(LegacyComposeRetainedFileError);
  expect((await stat(join(root, "material/secret"))).mode & 0o777).toBe(0o600);
});

test("proof2 cannot swap omission with explicit mode, invent guest owner, downgrade or normalize an unissued candidate", async () => {
  const input = candidate();
  const { proof } = await observed({ candidate: input, mode: "0600" });
  expect(() =>
    readLegacyComposeRetainedFileProof({
      proof,
      candidate: candidate("0600"),
      containers: containers(),
    })
  ).toThrow(LegacyComposeRetainedFileError);
  for (const forged of [
    { ...proof, file_proof_version: 1 },
    { ...proof, file_proof_version: 3 },
    {
      ...proof,
      guests: proof.guests.map((entry) => ({ ...entry, mode: "0444" })),
    },
    { ...proof, policies: [] },
    { ...proof, extra: true },
  ]) {
    expect(() =>
      readLegacyComposeRetainedFileProof({
        proof: forged,
        candidate: input,
        containers: containers(),
      })
    ).toThrow(LegacyComposeRetainedFileError);
  }
  expect(() =>
    normalizeLegacyComposeRetainedFileCandidate({
      candidate: JSON.parse(JSON.stringify(input)),
      proof,
      containers: containers(),
    })
  ).toThrow(LegacyComposeRetainedFileError);
  await expect(
    observed({ candidate: input, mode: "0600", uid: 0, saved: proof })
  ).rejects.toThrow(LegacyComposeRetainedFileError);
  await expect(
    observed({ candidate: input, mode: "0600", gid: 0, saved: proof })
  ).rejects.toThrow(LegacyComposeRetainedFileError);
});

test("stopped originals require an exact prior proof; saved mode and owner remain checked on next running observation", async () => {
  const input = candidate();
  const { proof } = await observed({ candidate: input, mode: "0600" });
  const stopped = await observed({
    candidate: input,
    mode: "0600",
    saved: proof,
    running: false,
  });
  expect(stopped.calls).toEqual([]);
  expect(stopped.proof).toEqual(proof);
  await expect(
    observed({ candidate: input, mode: "0600", running: false })
  ).rejects.toThrow(LegacyComposeRetainedFileError);
  await chmod(join(root, "material/secret"), 0o400);
  await expect(
    observed({ candidate: input, mode: "0400", saved: proof })
  ).rejects.toThrow(LegacyComposeRetainedFileError);
});
test("proof2 rejects accessor policy fields and array elements without reading them", async () => {
  const input = candidate();
  const { proof } = await observed({ candidate: input, mode: "0600" });
  if (proof.file_proof_version !== 2) {
    throw new Error("protected proof missing");
  }
  let reads = 0;
  const getterPolicy = { ...proof.policies[0] };
  Object.defineProperty(getterPolicy, "declaredMode", {
    enumerable: true,
    get() {
      reads++;
      return null;
    },
  });
  const getterArray = [...proof.policies];
  Object.defineProperty(getterArray, "0", {
    enumerable: true,
    get() {
      reads++;
      return proof.policies[0];
    },
  });
  for (const policies of [
    [getterPolicy, ...proof.policies.slice(1)],
    getterArray,
  ]) {
    expect(() =>
      readLegacyComposeRetainedFileProof({
        proof: { ...proof, policies },
        candidate: input,
        containers: containers(),
      })
    ).toThrow(LegacyComposeRetainedFileError);
  }
  expect(reads).toBe(0);
});

test("preview defaults and ordinary adoption purposes acquire no retained secret permission authority", () => {
  expect(mapLegacyNativeImport(source("0600")).candidate).toBeUndefined();
  for (const mapper of [
    mapLegacyNativeAdoptionBaseline,
    mapLegacyNativeStorageAdoption,
  ]) {
    expect(mapper(source()).candidate).toBeUndefined();
    expect(mapper(source("0600")).candidate).toBeUndefined();
  }
  const pure = mapLegacyNativeImport({
    ...source(),
    composeText: source()
      .composeText.replace(',"volumes":["data:/data"]', "")
      .replace(',"volumes":{"data":{"name":"fixture_data"}}', ""),
  });
  expect(pure.report.complete).toBe(true);
  expect(pure.candidate?.services).toMatchObject({
    app: {
      mounts: expect.arrayContaining([
        {
          secret: "token",
          target: "/run/token",
          access: "read-only",
          mode: "0444",
        },
      ]),
    },
  });
  expect(() =>
    legacyComposeRetainedFileGrants({ ...candidate(), jobs: {} })
  ).toThrow(LegacyComposeRetainedFileError);
});
