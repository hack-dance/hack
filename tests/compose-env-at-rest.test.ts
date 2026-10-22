import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
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
  composeEnvAtRestRepairs,
  composeEnvOverridePath,
  describeComposeEnvAtRest,
  inspectComposeEnvAtRest,
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
  const report = await inspectComposeEnvAtRest({ projectDir });
  expect(report.adoptionBound).toBe(false);
  expect(composeEnvAtRestRepairs(report)).toEqual({
    override: true,
    asides: false,
  });
  const described = describeComposeEnvAtRest({
    report,
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

  // A symlink is never followed and never removed, even on request: it is
  // refused (HACK-1316), and both it and its target are left in place.
  const target = join(root, "target.yml");
  await writeFile(target, `A: ${CANARY}\n`);
  await symlink(target, path);
  for (const includeUnverifiable of [false, true]) {
    expect(
      await removePlaintextComposeEnvOverride({
        projectDir,
        includeUnverifiable,
      })
    ).toEqual({
      removed: false,
      state: { kind: "refused", path },
      adoptionBound: false,
      asidesRemoved: 0,
    });
  }
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  expect(await readFile(target, "utf8")).toContain(CANARY);
});

test("removal keeps a value-free override that replaced the inspected literal file", async () => {
  const path = composeEnvOverridePath({ projectDir });
  await mkdir(join(projectDir, ".internal"));
  const projection = { targetServices: ["web"], globalEnv: {}, serviceEnv };
  await writeFile(path, renderManagedComposeEnvOverride(projection) ?? "");
  const references = renderComposeEnvReferenceOverride(projection)?.text ?? "";
  // A concurrent Compose command rewrites the override after the scrub saw
  // the literal file and before it removes anything.
  const raced = await removePlaintextComposeEnvOverride({
    projectDir,
    afterInspect: async () => {
      await writeComposeEnvOverride({ projectDir, text: references });
    },
  });
  expect(raced.removed).toBe(false);
  expect(raced.state.kind).toBe("references");
  expect(await readFile(path, "utf8")).toBe(references);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect(
    (await readdir(join(projectDir, ".internal"))).filter((name) =>
      name.endsWith(".remove")
    )
  ).toEqual([]);
  expect(JSON.stringify(raced)).not.toContain(CANARY);
});

test("removal sweeps an aside left by a crashed removal once it is stale", async () => {
  const internal = join(projectDir, ".internal");
  await mkdir(internal);
  const literal =
    renderManagedComposeEnvOverride({
      targetServices: ["web"],
      globalEnv: {},
      serviceEnv,
    }) ?? "";
  // A removal that crashed between its move and its unlink left this behind.
  const aside =
    ".compose.env.override.yml.0f8c2a4e-1b3d-4c5e-8f9a-0b1c2d3e4f5a.remove";
  await writeFile(join(internal, aside), literal, { mode: 0o600 });
  // Not an aside of this module: wrong suffix shape, or not a regular file.
  const unrelated = ".compose.env.override.yml.backup.remove";
  await writeFile(join(internal, unrelated), "kept\n");
  const directory =
    ".compose.env.override.yml.11111111-2222-3333-4444-555555555555.remove";
  await mkdir(join(internal, directory));

  // A fresh aside may still belong to a concurrent removal: it is kept.
  const fresh = await removePlaintextComposeEnvOverride({ projectDir });
  expect(fresh.state.kind).toBe("absent");
  expect((await readdir(internal)).sort()).toEqual(
    [aside, directory, unrelated].sort()
  );

  const stale = await removePlaintextComposeEnvOverride({
    projectDir,
    now: () => Date.now() + 61_000,
  });
  expect(stale).toEqual({
    removed: false,
    state: { kind: "absent", path: composeEnvOverridePath({ projectDir }) },
    adoptionBound: false,
    asidesRemoved: 1,
  });
  expect((await readdir(internal)).sort()).toEqual(
    [directory, unrelated].sort()
  );
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
  const describe = (
    override: Parameters<
      typeof describeComposeEnvAtRest
    >[0]["report"]["override"]
  ) =>
    describeComposeEnvAtRest({
      report: {
        override,
        adoptionBound: false,
        asides: { stale: 0, fresh: 0 },
      },
      projectDirName: ".hack",
    });
  expect(describe({ kind: "absent", path }).status).toBe("ok");
  expect(describe({ kind: "references", path }).status).toBe("ok");
  expect(describe({ kind: "unverifiable", path }).message).toContain(
    "hack doctor --fix"
  );
});

const ASIDE =
  ".compose.env.override.yml.0f8c2a4e-1b3d-4c5e-8f9a-0b1c2d3e4f5a.remove";

function literalText(): string {
  return (
    renderManagedComposeEnvOverride({
      targetServices: ["web"],
      globalEnv: {},
      serviceEnv,
    }) ?? ""
  );
}

test("a rendering write sweeps stale removal asides and keeps fresh ones", async () => {
  const internal = join(projectDir, ".internal");
  await mkdir(internal);
  await writeFile(join(internal, ASIDE), literalText(), { mode: 0o600 });
  const text =
    renderComposeEnvReferenceOverride({
      targetServices: ["web"],
      globalEnv: {},
      serviceEnv,
    })?.text ?? "";
  // A fresh aside may still belong to a removal in progress.
  await writeComposeEnvOverride({ projectDir, text });
  expect(await readdir(internal)).toContain(ASIDE);
  await writeComposeEnvOverride({
    projectDir,
    text,
    now: () => Date.now() + 61_000,
  });
  expect(await readdir(internal)).toEqual(["compose.env.override.yml"]);
});

test("doctor reports leftover removal asides by count and --fix removes only stale ones", async () => {
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  web:\n    image: alpine:3.22\n"
  );
  const internal = join(projectDir, ".internal");
  await mkdir(internal);
  await writeFile(join(internal, ASIDE), literalText(), { mode: 0o600 });

  const fresh = await inspectComposeEnvAtRest({ projectDir });
  expect(fresh.override.kind).toBe("absent");
  expect(fresh.asides).toEqual({ stale: 0, fresh: 1 });
  expect(composeEnvAtRestRepairs(fresh)).toEqual({
    override: false,
    asides: false,
  });
  const described = describeComposeEnvAtRest({
    report: fresh,
    projectDirName: ".hack",
  });
  expect(described.status).toBe("warn");
  expect(described.message).toContain("1 leftover removal file(s)");
  expect(described.message).not.toContain(CANARY);
  expect(described.message).not.toContain(ASIDE);

  const stale = await inspectComposeEnvAtRest({
    projectDir,
    now: () => Date.now() + 61_000,
  });
  expect(stale.asides).toEqual({ stale: 1, fresh: 0 });
  expect(composeEnvAtRestRepairs(stale).asides).toBe(true);
  const removed = await removePlaintextComposeEnvOverride({
    projectDir,
    includeUnverifiable: true,
    now: () => Date.now() + 61_000,
  });
  expect(removed.asidesRemoved).toBe(1);
  expect(await readdir(internal)).toEqual([]);
  expect(
    describeComposeEnvAtRest({
      report: await inspectComposeEnvAtRest({ projectDir }),
      projectDirName: ".hack",
    }).status
  ).toBe("ok");
});

test("an override that an adoption state may pin is kept by removal and reported by doctor", async () => {
  const internal = join(projectDir, ".internal");
  await mkdir(internal);
  const path = composeEnvOverridePath({ projectDir });
  await writeFile(path, literalText(), { mode: 0o600 });
  // Adoption state Hack cannot read safely counts as pinning the override.
  const adoption = join(internal, "legacy-compose-adoption-v1");
  await mkdir(adoption);

  const kept = await removePlaintextComposeEnvOverride({
    projectDir,
    includeUnverifiable: true,
  });
  expect(kept.removed).toBe(false);
  expect(kept.adoptionBound).toBe(true);
  expect(await readFile(path, "utf8")).toBe(literalText());
  const report = await inspectComposeEnvAtRest({ projectDir });
  expect(report.adoptionBound).toBe(true);
  expect(composeEnvAtRestRepairs(report).override).toBe(false);
  const described = describeComposeEnvAtRest({
    report,
    projectDirName: ".hack",
  });
  expect(described.status).toBe("warn");
  expect(described.message).toContain("pins this file");
  expect(described.message).toContain("hack config adopt --rollback");
  expect(described.message).not.toContain(CANARY);

  // Without the adoption state the same file is removed.
  await rm(adoption, { recursive: true });
  const removed = await removePlaintextComposeEnvOverride({ projectDir });
  expect(removed).toMatchObject({ removed: true, adoptionBound: false });
  expect(await lstat(path).catch(() => null)).toBeNull();
});

/** Names and contents of every entry in a directory outside the project. */
async function snapshotDirectory(
  directory: string
): Promise<Record<string, string>> {
  const names = (await readdir(directory)).sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        await readFile(join(directory, name), "utf8"),
      ])
    )
  );
}

/**
 * HACK-1316: a symlinked `.hack` or `.hack/.internal` points outside the
 * project, at a directory that holds a file named like the override (not one
 * Hack can verify, the reported case) and a stale-aged aside. Inspection, the
 * `--fix` removal, the aside sweep and the writer all refuse it, closed and
 * value-free, and nothing behind the link is listed, read or changed.
 */
for (const linked of [".hack", ".hack/.internal"] as const) {
  test(`a symlinked ${linked} is refused by inspection, removal, the sweep and the writer, and nothing behind it changes (HACK-1316)`, async () => {
    const behind = join(root, "outside", ".internal");
    await mkdir(behind, { recursive: true });
    await writeFile(join(behind, "compose.env.override.yml"), `${CANARY}\n`);
    await writeFile(join(behind, ASIDE), literalText());
    let dir = projectDir;
    if (linked === ".hack") {
      await mkdir(join(root, "linked-root"));
      dir = join(root, "linked-root", ".hack");
      await symlink(join(root, "outside"), dir);
    } else {
      await symlink(behind, join(projectDir, ".internal"));
    }
    const before = await snapshotDirectory(behind);
    // Old enough that a sweep through the link would take the aside.
    const later = () => Date.now() + 61_000;
    const path = composeEnvOverridePath({ projectDir: dir });

    const report = await inspectComposeEnvAtRest({
      projectDir: dir,
      now: later,
    });
    expect(report).toEqual({
      override: { kind: "refused", path },
      adoptionBound: false,
      asides: { stale: 0, fresh: 0 },
    });
    expect(composeEnvAtRestRepairs(report)).toEqual({
      override: false,
      asides: false,
    });
    const described = describeComposeEnvAtRest({
      report,
      projectDirName: ".hack",
    });
    expect(described).toEqual({
      status: "warn",
      message:
        "Refused to inspect .hack/.internal/compose.env.override.yml: it, .hack or .hack/.internal is a symlink or not a regular file or directory. Hack does not follow or change it, and 'hack doctor --fix' leaves it in place (values omitted). Replace it with a regular file or directory.",
    });

    expect(
      await removePlaintextComposeEnvOverride({
        projectDir: dir,
        includeUnverifiable: true,
        now: later,
      })
    ).toEqual({
      removed: false,
      state: { kind: "refused", path },
      adoptionBound: false,
      asidesRemoved: 0,
    });
    const references =
      renderComposeEnvReferenceOverride({
        targetServices: ["web"],
        globalEnv: {},
        serviceEnv,
      })?.text ?? "";
    const refusal = await writeComposeEnvOverride({
      projectDir: dir,
      text: references,
      now: later,
    }).catch((error: unknown) => error);
    expect(String(refusal)).toBe(
      "Error: Refused the generated Compose env override: it, .hack or .hack/.internal is a symlink or not a regular file or directory. Replace it with a regular file or directory and retry; values omitted."
    );

    expect(await snapshotDirectory(behind)).toEqual(before);
    expect(JSON.stringify([report, described, String(refusal)])).not.toContain(
      CANARY
    );
    expect(described.message).not.toContain(root);
  });
}

/**
 * HACK-1316: the writer refuses a symlinked `.hack` before its `mkdir`, so a
 * link to an outside directory without `.internal` gains nothing; the later
 * read and replace checks alone would refuse only after creating it.
 */
test("the writer refuses a symlinked .hack before creating .internal behind it (HACK-1316)", async () => {
  const outside = join(root, "outside");
  await mkdir(outside);
  await mkdir(join(root, "linked-root"));
  const dir = join(root, "linked-root", ".hack");
  await symlink(outside, dir);
  const references =
    renderComposeEnvReferenceOverride({
      targetServices: ["web"],
      globalEnv: {},
      serviceEnv,
    })?.text ?? "";

  const refusal = await writeComposeEnvOverride({
    projectDir: dir,
    text: references,
  }).catch((error: unknown) => error);
  expect(String(refusal)).toBe(
    "Error: Refused the generated Compose env override: it, .hack or .hack/.internal is a symlink or not a regular file or directory. Replace it with a regular file or directory and retry; values omitted."
  );
  expect(await readdir(outside)).toEqual([]);
});
