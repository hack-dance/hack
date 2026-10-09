import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyComposeRetainedFileGrants } from "../src/lib/native-compose-adoption-files.ts";
import { planLegacyComposeRetainedFileAdoption } from "../src/lib/native-compose-adoption-plan.ts";
import { previewLegacyComposeAdoption } from "../src/lib/native-compose-adoption-preview.ts";
import { mapLegacyNativeRetainedFileStorage } from "../src/lib/native-config-import-plan.ts";
import {
  nativeProtectedFileModeRefusalInputs,
  nativeProtectedFileRetainedInputs,
} from "./e2e/scenarios/native-config-protected-files.ts";
import { restoreEnv } from "./helpers/env.ts";

const image = `sha256:${"a".repeat(64)}`;
function source(inputs: {
  readonly config: unknown;
  readonly compose: unknown;
}) {
  return {
    configText: JSON.stringify(inputs.config),
    composeText: JSON.stringify(inputs.compose),
  };
}
const retained = () =>
  nativeProtectedFileRetainedInputs({
    instance: {
      name: "fixture",
      grants: [
        { target: "/settings", mode: "0444", bytes: [1] },
        { target: "/run/secrets/owner", mode: "0400", bytes: [2] },
        { target: "/run/secrets/private", mode: "0600", bytes: [3] },
      ],
    },
    bun: image,
    db: image,
  });
test("maintained retained inputs are admitted by the canonical closed file8 mapper", () => {
  const inputs = retained();
  expect(Object.keys(inputs.config)).toEqual(["name"]);
  for (const service of Object.values(inputs.compose.services)) {
    expect(Object.hasOwn(service, "pull_policy")).toBe(false);
  }
  expect(
    planLegacyComposeRetainedFileAdoption(source(inputs)).intent
  ).toBeDefined();
  const mapped = mapLegacyNativeRetainedFileStorage(source(inputs));
  expect(mapped.report.complete).toBe(true);
  expect(
    legacyComposeRetainedFileGrants(mapped.candidate).map((row) => [
      row.service,
      row.name,
      row.target,
    ])
  ).toEqual([
    ["reader", "owner", "/run/secrets/owner"],
    ["reader", "private", "/run/secrets/private"],
    ["reader", "settings", "/settings"],
  ]);
});
test("historical and canonical worktree and authored pull policy remain refused by retained file8", () => {
  const inputs = retained();
  const raw = { ...inputs.config, worktree: { inherit: false } };
  const planned = planLegacyComposeRetainedFileAdoption(
    source({ ...inputs, config: raw })
  );
  expect(planned.intent).toBeUndefined();
  expect(planned.report.fields).toContainEqual(
    expect.objectContaining({
      document: "config",
      pointer: "/worktree/inherit",
      status: "refused",
    })
  );
  const canonical = mapLegacyNativeRetainedFileStorage(
    source({
      ...inputs,
      config: { ...inputs.config, worktree: { inherit_local: false } },
    })
  );
  expect(canonical.candidate).toBeDefined();
  expect(() => legacyComposeRetainedFileGrants(canonical.candidate)).toThrow();
  const withPull = structuredClone(inputs);
  Object.assign(withPull.compose.services.reader, { pull_policy: "never" });
  const mapped = mapLegacyNativeRetainedFileStorage(source(withPull));
  expect(mapped.candidate).toBeDefined();
  expect(() => legacyComposeRetainedFileGrants(mapped.candidate)).toThrow();
});

let root: string;
let savedEnv: Map<string, string | undefined>;
const keys = [
  "PATH",
  "HOME",
  "HACK_HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
];
beforeEach(async () => {
  savedEnv = new Map(keys.map((key) => [key, process.env[key]]));
  root = await realpath(await mkdtemp(join(tmpdir(), "protected-source-")));
  await chmod(root, 0o700);
});
afterEach(async () => {
  for (const [key, value] of savedEnv) {
    restoreEnv(key, value);
  }
  await rm(root, { recursive: true, force: true });
});
test("same legal0400 source reaches only the rejecting shim after the mismatched-mode refusal", async () => {
  const checkout = join(root, "checkout"),
    marker = join(root, "invoked");
  await mkdir(join(checkout, ".hack"), { recursive: true });
  await mkdir(join(checkout, ".git"));
  await mkdir(join(checkout, "material"));
  const material = join(checkout, "material/private");
  await writeFile(material, "synthetic-owned-material", {
    flag: "wx",
    mode: 0o400,
  });
  const before = await lstat(material);
  expect(before.mode & 0o777).toBe(0o400);
  const inputs = nativeProtectedFileModeRefusalInputs({
    name: "fixture",
    bun: image,
    db: image,
  });
  await writeFile(
    join(checkout, ".hack/hack.config.json"),
    JSON.stringify(inputs.config)
  );
  const composePath = join(checkout, ".hack/docker-compose.yml");
  await writeFile(composePath, JSON.stringify(inputs.compose));
  await writeFile(
    join(root, "docker"),
    `#!${process.execPath}\nimport {open} from 'node:fs/promises';const f=await open(${JSON.stringify(marker)},'wx',0o600);try{await f.writeFile(JSON.stringify(process.argv.slice(2)));await f.sync()}finally{await f.close()}process.exit(98);\n`,
    { flag: "wx", mode: 0o700 }
  );
  for (const key of keys) {
    restoreEnv(key, undefined);
  }
  process.env.PATH = `${root}:/usr/bin:/bin`;
  process.env.HOME = root;
  process.env.HACK_HOME = join(root, "hack-home");
  process.env.DOCKER_HOST = "unix:///synthetic-never-forwarded.sock";
  const denied = await previewLegacyComposeAdoption({
    projectRoot: checkout,
    stop: true,
  });
  expect(denied.complete).toBe(false);
  await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  inputs.compose.services.reader.secrets[0]!.mode = "0400";
  await writeFile(composePath, JSON.stringify(inputs.compose));
  const legal = await previewLegacyComposeAdoption({
    projectRoot: checkout,
    stop: true,
  });
  expect(legal.complete).toBe(false);
  expect(JSON.parse(await readFile(marker, "utf8"))).toEqual([
    "info",
    "--format",
    '{"id":{{json .ID}},"os":{{json .OSType}}}',
  ]);
  const after = await lstat(material);
  expect([after.dev, after.ino, after.mode, after.uid, after.gid]).toEqual([
    before.dev,
    before.ino,
    before.mode,
    before.uid,
    before.gid,
  ]);
  await expect(
    lstat(join(checkout, ".hack/.internal/legacy-compose-adoption-v1"))
  ).rejects.toMatchObject({ code: "ENOENT" });
}, 15_000);
