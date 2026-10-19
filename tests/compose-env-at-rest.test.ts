import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import { buildDoctorRemediationPlanLines } from "../src/commands/doctor.ts";
import {
  composeEnvOverrideNeedsRemoval,
  composeEnvOverridePath,
  describeComposeEnvOverrideAtRest,
  inspectComposeEnvOverrideAtRest,
  removePlaintextComposeEnvOverride,
  writeComposeEnvOverride,
} from "../src/lib/compose-env-at-rest.ts";
import {
  classifyComposeEnvOverrideText,
  composeEnvReferenceName,
  renderComposeEnvReferenceOverride,
  renderManagedComposeEnvOverride,
} from "../src/lib/compose-managed-env.ts";

const CANARY = "g5-unit-canary";
let root: string;
let projectDir: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-env-at-rest-")));
  projectDir = join(root, ".hack");
  await mkdir(projectDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const serviceEnv = {
  web: { SECRET: `${CANARY}-web`, DOLLAR: `${CANARY}-$HOME-$$`, EMPTY: "" },
  worker: { SECRET: `${CANARY}-worker` },
};

test("reference projection keeps selection and order, holds no value and maps every reference", () => {
  const rendered = renderComposeEnvReferenceOverride({
    targetServices: ["worker", "web", "fallback"],
    globalEnv: { GLOBAL: `${CANARY}-global` },
    serviceEnv,
  });
  if (!rendered) {
    throw new Error("expected a reference projection");
  }
  expect(rendered.text).not.toContain(CANARY);
  const parsed = YAML.parse(rendered.text) as {
    services: Record<string, { environment: Record<string, string> }>;
  };
  expect(Object.keys(parsed.services)).toEqual(["worker", "web", "fallback"]);
  expect(Object.keys(parsed.services.web?.environment ?? {})).toEqual([
    "SECRET",
    "DOLLAR",
    "EMPTY",
  ]);
  for (const [service, values] of Object.entries({
    ...serviceEnv,
    fallback: { GLOBAL: `${CANARY}-global` },
  })) {
    for (const [key, value] of Object.entries(values)) {
      const name = composeEnvReferenceName({ service, key });
      expect(name).toMatch(/^HACK_ENV_[0-9A-F]{12}_[A-Z_]+$/);
      expect(parsed.services[service]?.environment[key]).toBe(`\${${name}}`);
      // The literal value, `$` included, travels only through the env map.
      expect(rendered.env[name]).toBe(value);
    }
  }
  expect(classifyComposeEnvOverrideText(rendered.text)).toEqual({
    kind: "references",
  });
});

test("reference text does not depend on values and names do not collide across services", () => {
  const first = renderComposeEnvReferenceOverride({
    targetServices: ["web", "worker"],
    globalEnv: {},
    serviceEnv,
  });
  const second = renderComposeEnvReferenceOverride({
    targetServices: ["web", "worker"],
    globalEnv: {},
    serviceEnv: {
      web: { SECRET: "other", DOLLAR: "other", EMPTY: "x" },
      worker: { SECRET: "other" },
    },
  });
  expect(first?.text).toBe(second?.text ?? "");
  expect(composeEnvReferenceName({ service: "web", key: "SECRET" })).not.toBe(
    composeEnvReferenceName({ service: "worker", key: "SECRET" })
  );
  expect(composeEnvReferenceName({ service: "web", key: "a.b" })).toMatch(
    /^HACK_ENV_[0-9A-F]{12}$/
  );
  expect(
    renderComposeEnvReferenceOverride({
      targetServices: ["web"],
      globalEnv: {},
      serviceEnv: {},
    })
  ).toBeNull();
});

test("classifier counts literal values without returning them", () => {
  const literal = renderManagedComposeEnvOverride({
    targetServices: ["web", "worker"],
    globalEnv: {},
    serviceEnv,
  });
  const result = classifyComposeEnvOverrideText(literal ?? "");
  expect(result).toEqual({ kind: "plaintext", services: 2, values: 4 });
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(
    classifyComposeEnvOverrideText(
      "services:\n  web:\n    environment:\n      - A=${A}\n      - B\n      - C=literal\n"
    )
  ).toEqual({ kind: "plaintext", services: 1, values: 1 });
  expect(
    classifyComposeEnvOverrideText(
      'services:\n  web:\n    environment:\n      A: "${A:-fallback}"\n      B: 42\n      C: null\n'
    )
  ).toEqual({ kind: "plaintext", services: 1, values: 2 });
  expect(classifyComposeEnvOverrideText("services: [\n")).toEqual({
    kind: "unverifiable",
  });
  expect(classifyComposeEnvOverrideText("services:\n  web: 3\n")).toEqual({
    kind: "unverifiable",
  });
  expect(classifyComposeEnvOverrideText("")).toEqual({ kind: "references" });
});

test("writer leaves a value-free 0600 file and tightens an existing loose mode", async () => {
  const rendered = renderComposeEnvReferenceOverride({
    targetServices: ["web"],
    globalEnv: {},
    serviceEnv,
  });
  const path = composeEnvOverridePath({ projectDir });
  await mkdir(join(projectDir, ".internal"));
  await writeFile(path, rendered?.text ?? "");
  await chmod(path, 0o644);
  expect(
    await writeComposeEnvOverride({ projectDir, text: rendered?.text ?? "" })
  ).toBe(path);
  const info = await lstat(path);
  expect(info.mode & 0o777).toBe(0o600);
  expect(info.uid).toBe(process.getuid?.() ?? info.uid);
  expect(await readFile(path, "utf8")).toBe(rendered?.text ?? "");
});

test("writer refuses literal text and a symlinked path without writing or naming a value", async () => {
  const literal = renderManagedComposeEnvOverride({
    targetServices: ["web"],
    globalEnv: {},
    serviceEnv,
  });
  const refusal = await writeComposeEnvOverride({
    projectDir,
    text: literal ?? "",
  }).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(Error);
  expect(String(refusal)).not.toContain(CANARY);
  expect(
    await lstat(composeEnvOverridePath({ projectDir })).catch(() => null)
  ).toBeNull();

  const target = join(root, "elsewhere.yml");
  await writeFile(target, "outside\n");
  await mkdir(join(projectDir, ".internal"), { recursive: true });
  await symlink(target, composeEnvOverridePath({ projectDir }));
  const rendered = renderComposeEnvReferenceOverride({
    targetServices: ["web"],
    globalEnv: {},
    serviceEnv,
  });
  await expect(
    writeComposeEnvOverride({ projectDir, text: rendered?.text ?? "" })
  ).rejects.toThrow("values omitted");
  expect(await readFile(target, "utf8")).toBe("outside\n");
});

test("inspection and removal act only on literal or unverifiable overrides", async () => {
  expect(await inspectComposeEnvOverrideAtRest({ projectDir })).toEqual({
    kind: "absent",
    path: composeEnvOverridePath({ projectDir }),
  });
  const path = composeEnvOverridePath({ projectDir });
  await mkdir(join(projectDir, ".internal"));

  const rendered = renderComposeEnvReferenceOverride({
    targetServices: ["web"],
    globalEnv: {},
    serviceEnv,
  });
  await writeComposeEnvOverride({ projectDir, text: rendered?.text ?? "" });
  const kept = await removePlaintextComposeEnvOverride({
    projectDir,
    includeUnverifiable: true,
  });
  expect(kept.removed).toBe(false);
  expect(kept.state.kind).toBe("references");
  expect(await lstat(path).catch(() => null)).not.toBeNull();

  await writeFile(
    path,
    renderManagedComposeEnvOverride({
      targetServices: ["web"],
      globalEnv: {},
      serviceEnv,
    }) ?? ""
  );
  const state = await inspectComposeEnvOverrideAtRest({ projectDir });
  expect(composeEnvOverrideNeedsRemoval(state)).toBe(true);
  const described = describeComposeEnvOverrideAtRest({
    state,
    projectDirName: ".hack",
  });
  expect(described.status).toBe("warn");
  expect(described.message).toContain(
    ".hack/.internal/compose.env.override.yml holds 3 literal env value(s) for 1 service(s)"
  );
  expect(described.message).not.toContain(CANARY);
  const removed = await removePlaintextComposeEnvOverride({ projectDir });
  expect(removed.removed).toBe(true);
  expect(await lstat(path).catch(() => null)).toBeNull();

  // A symlink is never followed: it is unverifiable, removed only on request,
  // and its target is untouched.
  const target = join(root, "target.yml");
  await writeFile(target, `A: ${CANARY}\n`);
  await symlink(target, path);
  const linked = await removePlaintextComposeEnvOverride({ projectDir });
  expect(linked).toEqual({
    removed: false,
    state: { kind: "unverifiable", path },
  });
  expect(
    (
      await removePlaintextComposeEnvOverride({
        projectDir,
        includeUnverifiable: true,
      })
    ).removed
  ).toBe(true);
  expect(await lstat(path).catch(() => null)).toBeNull();
  expect(await readFile(target, "utf8")).toContain(CANARY);
});

test("doctor --fix plan offers removal only while a literal override is at rest", async () => {
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  web:\n    image: alpine:3.22\n"
  );
  const step = ".hack/.internal/compose.env.override.yml, which may hold";
  const plan = async () =>
    (
      await buildDoctorRemediationPlanLines({
        startDir: root,
        migrateEnvConfig: false,
      })
    ).join("\n");
  expect(await plan()).not.toContain(step);
  await mkdir(join(projectDir, ".internal"));
  await writeFile(
    composeEnvOverridePath({ projectDir }),
    renderManagedComposeEnvOverride({
      targetServices: ["web"],
      globalEnv: {},
      serviceEnv,
    }) ?? ""
  );
  const withLiteral = await plan();
  expect(withLiteral).toContain(step);
  expect(withLiteral).not.toContain(CANARY);
});

test("doctor descriptions are ok for absent and reference-only files", () => {
  const path = "/unused";
  expect(
    describeComposeEnvOverrideAtRest({
      state: { kind: "absent", path },
      projectDirName: ".hack",
    }).status
  ).toBe("ok");
  expect(
    describeComposeEnvOverrideAtRest({
      state: { kind: "references", path },
      projectDirName: ".hack",
    }).status
  ).toBe("ok");
  expect(
    describeComposeEnvOverrideAtRest({
      state: { kind: "unverifiable", path },
      projectDirName: ".hack",
    }).message
  ).toContain("hack doctor --fix");
});
