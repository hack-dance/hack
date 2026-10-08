import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LegacyAdoptionManagedEnvAdmission } from "../src/lib/native-compose-adoption-env-inputs.ts";
import {
  legacyAdoptionLocalRefusalFields,
  mapLegacyAdoptionLocalInput,
} from "../src/lib/native-compose-adoption-local.ts";
import { previewLegacyComposeAdoption } from "../src/lib/native-compose-adoption-preview.ts";
import {
  LegacyComposeAdoptionProjection,
  readSavedLegacyComposeAdoptionProjection,
} from "../src/lib/native-compose-adoption-projection.ts";
import {
  acquireLegacyAdoptionSourceInputs,
  acquireNativeConfigImportInputs,
  privateNativeConfigImportLocalInput,
} from "../src/lib/native-config-import-inputs.ts";
import { restoreEnv } from "./helpers/env.ts";
import { managedEnvCompilerFixture } from "./helpers/managed-env-compiler.ts";

const CANARY = "synthetic-typed-local-private-canary";
const KEYS = [
  "CI",
  "HACK_EXECUTION_MODE",
  "HACK_ENV_SECRET_KEY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
] as const;
let root: string;
let binary: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
  root = await realpath(await mkdtemp(join(tmpdir(), "adoption-local-")));
  await mkdir(join(root, ".hack"));
  await writeFile(
    join(root, ".hack/hack.config.json"),
    '{"name":"fixture","env":{"default_overlay":"qa"}}'
  );
  await writeFile(
    join(root, ".hack/docker-compose.yml"),
    '{"name":"fixture","services":{"web":{"image":"alpine:3.22","volumes":["data:/data"]}},"volumes":{"data":{}}}'
  );
  binary = await managedEnvCompilerFixture(join(root, "compiler"));
});
afterEach(async () => {
  for (const key of KEYS) {
    restoreEnv(key, saved[key]);
  }
  await rm(root, { recursive: true, force: true });
});
function localPath(projectRoot = root) {
  return join(projectRoot, ".hack/hack.local.json");
}
async function local(environment: unknown, projectRoot = root) {
  await writeFile(
    localPath(projectRoot),
    JSON.stringify({ schema_version: 1, environment }),
    { mode: 0o600 }
  );
}
async function source(projectRoot = root, signal?: AbortSignal) {
  return await acquireLegacyAdoptionSourceInputs({
    projectRoot,
    signal,
    allowLinkedWorktree: true,
  });
}
async function admission(projectRoot = root, signal?: AbortSignal) {
  return await LegacyAdoptionManagedEnvAdmission.acquire({
    source: await source(projectRoot, signal),
    signal,
    binary,
  });
}
async function refusal(run: () => Promise<unknown>) {
  let error: unknown;
  try {
    await run();
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) {
    throw new Error("Expected local refusal");
  }
  expect(error.message).toContain("values omitted");
  expect(error.message).not.toContain(root);
  expect(error.message).not.toContain(CANARY);
  expect(error.cause).toBeUndefined();
  return error;
}
async function git(args: readonly string[]) {
  const child = Bun.spawn(["/usr/bin/git", "-C", root, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  expect(await child.exited).toBe(0);
}
async function linked() {
  await git(["init", "--quiet", "-b", "main"]);
  await git(["add", ".hack/hack.config.json", ".hack/docker-compose.yml"]);
  await git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const checkout = join(root, "linked");
  await git(["worktree", "add", "--quiet", "-b", "fixture", checkout]);
  return checkout;
}

test("ordinary preview refuses locals while adoption captures private same-issued optional input", async () => {
  await local({ default_overlay: "qa" });
  expect(await acquireNativeConfigImportInputs({ projectRoot: root })).toEqual({
    ok: false,
    code: "local_or_dotenv_input_outside_first_slice",
  });
  const input = await source();
  expect(input.ok).toBe(true);
  const snapshot = privateNativeConfigImportLocalInput(input);
  expect(snapshot?.text).toBe(await readFile(localPath(), "utf8"));
  expect(snapshot?.proof?.info.nlink).toBe(1);
  expect(JSON.stringify(input)).toBe('{"ok":true}');
  expect(JSON.stringify(snapshot)).toBe("{}");
  expect(() =>
    privateNativeConfigImportLocalInput({ ok: false, code: CANARY })
  ).toThrow("values omitted");
});

for (const environment of [{}, { default_overlay: "qa" }]) {
  test(`unchanged named selection admits empty or explicit local environment ${JSON.stringify(environment)}`, async () => {
    await local(environment);
    const owned = await admission();
    expect(owned.selection.overlay).toBe("qa");
    expect(owned.localFields.map((field) => field.document)).toContain(
      "checkout_local"
    );
    expect(JSON.stringify(owned)).toBe("{}");
    expect(JSON.stringify(owned.localFields)).not.toContain('"qa"');
    await owned.assertRoot({ projectRoot: root });
  });
}
test("explicit base null qualifies only when legacy already selects base", async () => {
  await writeFile(join(root, ".hack/hack.config.json"), '{"name":"fixture"}');
  await local({ default_overlay: null });
  expect((await admission()).selection.overlay).toBeNull();
});
test("different named selection and null base refuse before managed values or engine probes", async () => {
  for (const overlay of [null, "changed"]) {
    await local({ default_overlay: overlay });
    const error = await refusal(() => admission());
    expect(
      legacyAdoptionLocalRefusalFields(error).some(
        (field) => field.code === "local_selection_would_change_legacy"
      )
    ).toBe(true);
  }
});
test("Rust precedence allows changed primary only when checkout restores the exact legacy selection", async () => {
  const checkout = await linked();
  await local({ default_overlay: "changed" });
  await local({ default_overlay: "qa" }, checkout);
  const owned = await admission(checkout);
  expect(owned.selection.overlay).toBe("qa");
  expect(new Set(owned.localFields.map((field) => field.document))).toEqual(
    new Set(["primary_local", "checkout_local"])
  );
  await local({}, checkout);
  await refusal(() => admission(checkout));
});
for (const exclusion of ["ci", "slim", "optout"]) {
  test(`excluded primary local is not acquired: ${exclusion}`, async () => {
    const checkout = await linked();
    await writeFile(
      localPath(),
      `{ "schema_version":1,"routes":{"domain":"${CANARY}"} }`
    );
    await local({ default_overlay: "qa" }, checkout);
    if (exclusion === "ci") {
      process.env.CI = "true";
    }
    if (exclusion === "slim") {
      process.env.HACK_EXECUTION_MODE = "slim";
    }
    if (exclusion === "optout") {
      await writeFile(
        join(checkout, ".hack/hack.config.json"),
        '{"name":"fixture","env":{"default_overlay":"qa"},"worktree":{"inherit_local":false}}'
      );
    }
    const owned = await admission(checkout);
    expect(
      owned.localFields.every((field) => field.document === "checkout_local")
    ).toBe(true);
    await writeFile(localPath(), CANARY);
    await owned.assertRoot({ projectRoot: checkout });
  });
}
for (const text of [
  '{"schema_version":2}',
  '{"schema_version":1,"routes":{}}',
  '{"schema_version":1,"open":{}}',
  '{"schema_version":1,"host_bindings":{}}',
  '{"schema_version":1,"environment":{"unknown":"value"}}',
  '{"schema_version":1,"environment":{"default_overlay":1}}',
  '{"schema_version":1,"environment":null}',
  '{"schema_version":1,"schema_version":1}',
  '{"schema_version":1,"environment":{"default_overlay":null,"default_overlay":"qa"}}',
  '{"schema_version":1,"environment":{"default_overlay":"qa","default_\\u006fverlay":"qa"}}',
  '{"schema_version":1,"services":{}}',
  '{"schema_version":1,"environment":{},"worktree":{}}',
  "schema_version: 1",
  "{}",
]) {
  test(`closed local slice refuses unsupported or duplicate input ${text}`, async () => {
    await writeFile(localPath(), text);
    const error = await refusal(() => admission());
    expect(
      legacyAdoptionLocalRefusalFields(error).every(
        (field) => field.document === "checkout_local"
      )
    ).toBe(true);
  });
}
test("unsupported primary refuses even if checkout shadows its effective selection", async () => {
  const checkout = await linked();
  await writeFile(localPath(), '{"schema_version":1,"routes":{}}');
  await local({ default_overlay: "qa" }, checkout);
  await refusal(() => admission(checkout));
});
test("refusal report preserves duplicate role/pointer without literal selection or private candidate", async () => {
  await writeFile(
    localPath(),
    `{"schema_version":1,"environment":{"default_overlay":"${CANARY}","default_overlay":"qa"}}`
  );
  const report = await previewLegacyComposeAdoption({
    projectRoot: root,
    binary,
  });
  expect(report.complete).toBe(false);
  expect(
    report.fields.some(
      (field) =>
        field.document === "checkout_local" && field.code === "duplicate_key"
    )
  ).toBe(true);
  expect(JSON.stringify(report)).not.toContain(CANARY);
  expect(JSON.stringify(report)).not.toContain('"candidate"');
});
for (const change of [
  "whitespace",
  "remove",
  "replace",
  "unsafe",
  "symlink",
  "hardlink",
] as const) {
  test(`same-issued local freshness refuses ${change}`, async () => {
    await local({ default_overlay: "qa" });
    const owned = await admission();
    const path = localPath();
    const text = await readFile(path, "utf8");
    if (change === "whitespace") {
      await writeFile(path, `${text}\n`);
    }
    if (change === "remove") {
      await rm(path);
    }
    if (change === "replace") {
      await rename(path, `${path}.old`);
      await writeFile(path, text);
    }
    if (change === "unsafe") {
      await chmod(path, 0o666);
    }
    if (change === "symlink") {
      await rename(path, `${path}.old`);
      await symlink(`${path}.old`, path);
    }
    if (change === "hardlink") {
      await link(path, `${path}.linked`);
    }
    await refusal(() => owned.assertRoot({ projectRoot: root }));
  });
}
test("optional absence is pinned; a later local addition refuses", async () => {
  const owned = await admission();
  await local({});
  await refusal(() => owned.assertRoot({ projectRoot: root }));
});

test("held inherited local bytes and Git family refuse primary drift or a competing marker", async () => {
  const checkout = await linked();
  await local({ default_overlay: "qa" });
  const owned = await admission(checkout);
  await writeFile(localPath(), `${await readFile(localPath(), "utf8")}\n`);
  await refusal(() => owned.assertRoot({ projectRoot: checkout }));
  await writeFile(join(root, ".hack/hack.project.json"), CANARY);
  await refusal(() => admission(checkout));
});

test("changed Git pointer refuses despite unchanged effective local selection", async () => {
  const checkout = await linked();
  await local({ default_overlay: "qa" }, checkout);
  const owned = await admission(checkout);
  const path = join(checkout, ".git");
  await writeFile(path, `${await readFile(path, "utf8")}\n`);
  await refusal(() => owned.assertRoot({ projectRoot: checkout }));
});

test("a newly enabled inherited scope cannot replace captured CI exclusion", async () => {
  const checkout = await linked();
  process.env.CI = "1";
  await local({}, checkout);
  const owned = await admission(checkout);
  Reflect.deleteProperty(process.env, "CI");
  await refusal(() => owned.assertRoot({ projectRoot: checkout }));
});
test("initial unsafe, symlink or hardlink local inputs refuse", async () => {
  await local({});
  await chmod(localPath(), 0o666);
  await refusal(() => source());
  await chmod(localPath(), 0o600);
  await link(localPath(), `${localPath()}.link`);
  await refusal(() => source());
  await rm(`${localPath()}.link`);
  await rename(localPath(), `${localPath()}.old`);
  await symlink(`${localPath()}.old`, localPath());
  await refusal(() => source());
});

test("oversized and invalid UTF-8 optional local inputs refuse without excerpts", async () => {
  await writeFile(localPath(), Buffer.alloc(1024 * 1024 + 1, 120));
  await refusal(() => source());
  await writeFile(localPath(), Buffer.from([0xff, 0x00]));
  await refusal(() => source());
});

test("local raw source race during compiler resolution refuses after its reply", async () => {
  await local({ default_overlay: "qa" });
  const slow = join(root, "slow-compiler");
  const marker = join(root, "compiler-resolving");
  await writeFile(
    slow,
    `#!${process.execPath}\nconst input=process.argv[2]==="--protocol"?undefined:await Bun.stdin.text();
if(input){await Bun.write(${JSON.stringify(marker)}, "started");await Bun.sleep(300);}
const child=Bun.spawn([${JSON.stringify(binary)},...process.argv.slice(2)],{stdin:input===undefined?"ignore":"pipe",stdout:"pipe",stderr:"pipe"});
if(input!==undefined){child.stdin.write(input);child.stdin.end();}
await Promise.all([Bun.write(Bun.stdout,child.stdout),Bun.write(Bun.stderr,child.stderr)]);process.exit(await child.exited);\n`,
    { mode: 0o700 }
  );
  const input = await source();
  const pending = LegacyAdoptionManagedEnvAdmission.acquire({
    source: input,
    binary: slow,
  });
  for (
    let attempt = 0;
    attempt < 200 && !(await Bun.file(marker).exists());
    attempt++
  ) {
    await Bun.sleep(5);
  }
  expect(await Bun.file(marker).exists()).toBe(true);
  await writeFile(localPath(), `${await readFile(localPath(), "utf8")}\n`);
  await refusal(() => pending);
});
test("captured cancellation cannot be replaced by a fresh caller signal", async () => {
  await local({});
  const controller = new AbortController();
  const owned = await admission(root, controller.signal);
  controller.abort(CANARY);
  await refusal(() =>
    owned.assertRoot({
      projectRoot: root,
      signal: new AbortController().signal,
    })
  );
});
test("typed-local projection proof2 saved rechecks are key-free and JSON-private", async () => {
  await local({ default_overlay: "qa" });
  const input = await source();
  const projection = await LegacyComposeAdoptionProjection.acquire({
    source: input,
    binary,
  });
  const resolved = await projection.resolve();
  expect(resolved.projectionProof.projection_version).toBe(2);
  expect(
    projection.report.local_fields?.every(
      (field) => field.document === "checkout_local"
    )
  ).toBe(true);
  expect(JSON.stringify(resolved)).toBe("{}");
  expect(JSON.stringify(projection.report)).not.toContain(
    resolved.projectionProof.localInputs?.checkout?.hash ?? "not-present"
  );
  if (!input.ok) {
    throw new Error("Expected source");
  }
  const opts = {
    projectRoot: root,
    configText: input.configText,
    composeText: input.composeText,
    proof: resolved.projectionProof,
    checkOwner: async () => {
      await input.assertFresh();
    },
  };
  await mkdir(join(root, ".hack.secret.key"));
  const savedProjection = await readSavedLegacyComposeAdoptionProjection(opts);
  expect(savedProjection.candidate).toEqual(resolved.candidate);
  expect(savedProjection.composeFiles).toEqual([...resolved.composeFiles]);
  expect(JSON.stringify(savedProjection)).toBe("{}");
  await writeFile(localPath(), `${await readFile(localPath(), "utf8")}\n`);
  await refusal(() => readSavedLegacyComposeAdoptionProjection(opts));
});
test("old projection1 refuses a newly present local instead of retroactively widening v3", async () => {
  const input = await source();
  const projection = await LegacyComposeAdoptionProjection.acquire({
    source: input,
    binary,
  });
  const resolved = await projection.resolve();
  expect(resolved.projectionProof.projection_version).toBe(1);
  await local({});
  if (!input.ok) {
    throw new Error("Expected source");
  }
  await refusal(() =>
    readSavedLegacyComposeAdoptionProjection({
      projectRoot: root,
      configText: input.configText,
      composeText: input.composeText,
      proof: resolved.projectionProof,
      checkOwner: async () => {},
    })
  );
});
test("pure map reports positions and roles only; forged error diagnostic fields are ignored", () => {
  const report = mapLegacyAdoptionLocalInput({
    text: '{\n "schema_version":1,\n "environment":{"default_overlay":"qa"}\n}',
    document: "primary_local",
  });
  expect(report.complete).toBe(true);
  expect(
    report.fields.some(
      (field) =>
        field.pointer === "/environment/default_overlay" && field.line === 3
    )
  ).toBe(true);
  expect(JSON.stringify(report)).not.toContain('"qa"');
  expect(
    legacyAdoptionLocalRefusalFields(
      Object.assign(new Error(CANARY), { fields: [{ pointer: CANARY }] })
    )
  ).toEqual([]);
});
