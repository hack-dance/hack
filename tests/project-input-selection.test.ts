import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  updateProjectConfig,
  updateProjectConfigBatch,
} from "../src/lib/config.ts";
import {
  inspectLegacyComposeAdoptionSelection,
  LegacyComposeAdoptionSelectionError,
  legacyComposeAdoptionSelectionDiagnostic,
} from "../src/lib/native-compose-adoption-marker.ts";
import {
  findProjectContext,
  findProjectContextAtRoot,
  findRepoRootForInit,
  readProjectConfig,
} from "../src/lib/project.ts";
import {
  discoverProjectInputs,
  inspectProjectInputsAtRoot,
  NATIVE_PROJECT_FILENAME,
  ProjectInputAccessError,
  projectInputAccessDiagnostic,
  projectInputAccessFault,
} from "../src/lib/project-input-selection.ts";

const roots: string[] = [];
afterEach(async () => {
  mock.restore();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

test("adoption marker reconstructs fixed errors from a forged typed argument getter", async () => {
  const canary = "synthetic-private-marker-diagnostic",
    forged = new LegacyComposeAdoptionSelectionError();
  forged.message = canary;
  try {
    await inspectLegacyComposeAdoptionSelection({
      get projectRoot(): string {
        throw forged;
      },
    });
    throw new Error("unexpected adoption marker success");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(LegacyComposeAdoptionSelectionError);
    expect(error).not.toBe(forged);
    expect(String(error)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
  }
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-input-selection-"));
  roots.push(root);
  return root;
}

async function file(
  root: string,
  relative: string,
  text = "services: {}\n"
): Promise<string> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

async function native(
  root: string,
  text = '{"schema_version":1,"name":"test"}'
): Promise<string> {
  return await file(root, `.hack/${NATIVE_PROJECT_FILENAME}`, text);
}

test("native nested discovery refuses ancestor Compose without registration or writes", async () => {
  const outer = await fixture();
  await file(outer, ".hack/docker-compose.yml");
  const inner = join(outer, "native");
  const marker = await native(inner);
  const nested = join(inner, "src/deep");
  await mkdir(nested, { recursive: true });
  expect((await discoverProjectInputs({ startDir: nested }))?.projectRoot).toBe(
    inner
  );
  await expect(findProjectContext(nested)).rejects.toThrow(
    "E_NATIVE_PROJECT_UNSUPPORTED"
  );
  expect(await readFile(marker, "utf8")).toBe(
    '{"schema_version":1,"name":"test"}'
  );
  expect(await Bun.file(join(inner, ".hack/hack.config.json")).exists()).toBe(
    false
  );
});

for (const directory of [".hack", ".dev"]) {
  for (const filename of [
    "docker-compose.yml",
    "hack.config.json",
    "hack.toml",
  ]) {
    test(`native plus active ${directory}/${filename} conflicts before parsing`, async () => {
      const root = await fixture();
      await native(root);
      await file(root, `${directory}/${filename}`, "not parseable input");
      expect(
        (await inspectProjectInputsAtRoot({ projectRoot: root })).kind
      ).toBe("conflict");
      await expect(findProjectContext(root)).rejects.toThrow(
        "E_NATIVE_PROJECT_CONFLICT"
      );
    });
  }
}

test("generated backend files, backups and root Compose are not authored legacy inputs", async () => {
  const root = await fixture();
  await native(root);
  for (const name of [
    "docker-compose.yml",
    ".hack/.internal/docker-compose.yml",
    ".hack/.branch/dev/docker-compose.yml",
    ".hack/hack.config.json.backup",
    ".hack/docker-compose.yml.old",
  ]) {
    await file(root, name);
  }
  expect((await inspectProjectInputsAtRoot({ projectRoot: root })).kind).toBe(
    "native"
  );
});

for (const text of ["{broken", '{"schema_version":999}', "null"]) {
  test(`native presence stops discovery independently of parsed contents ${text}`, async () => {
    const outer = await fixture();
    await file(outer, ".dev/docker-compose.yml");
    const inner = join(outer, "child");
    await native(inner, text);
    await expect(findProjectContext(inner)).rejects.toThrow(
      "E_NATIVE_PROJECT_UNSUPPORTED"
    );
  });
}

test("directory and dangling-link native markers never disappear into absence", async () => {
  const outer = await fixture();
  await file(outer, ".hack/docker-compose.yml");
  const directoryRoot = join(outer, "directory");
  await mkdir(join(directoryRoot, ".hack", NATIVE_PROJECT_FILENAME), {
    recursive: true,
  });
  await expect(findProjectContext(directoryRoot)).rejects.toThrow(
    "E_NATIVE_PROJECT_UNSUPPORTED"
  );
  const linkRoot = join(outer, "link");
  await mkdir(join(linkRoot, ".hack"), { recursive: true });
  await symlink(
    join(outer, "missing"),
    join(linkRoot, ".hack", NATIVE_PROJECT_FILENAME)
  );
  await expect(findProjectContext(linkRoot)).rejects.toThrow(
    "E_NATIVE_PROJECT_UNSUPPORTED"
  );
});

test("unreadable native input remains a boundary without reading its values", async () => {
  const root = await fixture();
  const marker = await native(root);
  await chmod(marker, 0);
  try {
    await expect(findProjectContext(root)).rejects.toThrow(
      "E_NATIVE_PROJECT_UNSUPPORTED"
    );
  } finally {
    await chmod(marker, 0o600);
  }
});

test.each([
  ".hack",
  ".hack/.internal",
])("invalid project directory %s refuses rather than selecting ancestor Compose", async (path) => {
  const outer = await fixture();
  await file(outer, ".hack/docker-compose.yml");
  const inner = join(outer, "child");
  await file(inner, path, "not a directory");
  await expect(findProjectContext(inner)).rejects.toThrow(
    "Cannot inspect Hack project inputs"
  );
});

async function inputAccessFault(root: string): Promise<unknown> {
  try {
    await inspectProjectInputsAtRoot({ projectRoot: root });
  } catch (error: unknown) {
    return error;
  }
  throw new Error("unexpected input selection success");
}

/**
 * The access refusal keeps its fault only as a non-enumerable, value-free
 * class/code diagnostic: never a `cause`, an enumerable field, the path or the
 * OS message.
 */
function expectValueFreeDiagnostic(
  error: unknown,
  root: string,
  diagnostic: string,
  read: (error: unknown) => string | undefined = projectInputAccessDiagnostic
): void {
  expect(read(error)).toBe(diagnostic);
  expect((error as Error).cause).toBeUndefined();
  expect(Object.keys(error as object)).not.toContain("diagnosticCause");
  const code = diagnostic.split(":")[1] ?? diagnostic;
  for (const rendered of [String(error), JSON.stringify(error)]) {
    expect(rendered).not.toContain(root);
    expect(rendered).not.toContain(code);
  }
}

test("a .dev file beside valid .hack inputs is a typed, value-free access refusal", async () => {
  const root = await fixture();
  await file(root, ".hack/docker-compose.yml");
  await file(root, ".dev", "not a directory");
  const error = await inputAccessFault(root);
  expect(error).toBeInstanceOf(ProjectInputAccessError);
  expect((error as ProjectInputAccessError).access).toBe("unreadable");
  expect((error as ProjectInputAccessError).code).toBe("E_CONFIG_INVALID");
  // HACK-1390: the fault's class/code stays attached for tests and debugging.
  expectValueFreeDiagnostic(error, root, "Error:ENOTDIR");
});

test("EPERM and EACCES classify as permission; other faults as unreadable", () => {
  // A fixture cannot produce EPERM (a mode-000 directory gives EACCES), so the
  // classifier inputPresent() uses is exercised through its seam.
  const fault = (code: string) =>
    Object.assign(
      new Error(`${code}: operation failed, lstat '/private/fixture/.dev'`),
      { code, syscall: "lstat", path: "/private/fixture/.dev" }
    );
  for (const [code, access] of [
    ["EPERM", "permission"],
    ["EACCES", "permission"],
    ["ENOTDIR", "unreadable"],
    ["EIO", "unreadable"],
  ] as const) {
    const error = projectInputAccessFault(fault(code));
    expect(error).toBeInstanceOf(ProjectInputAccessError);
    expect({ code, access: error.access }).toEqual({ code, access });
    expect(error.code).toBe("E_CONFIG_INVALID");
    expectValueFreeDiagnostic(error, "/private/fixture", `Error:${code}`);
  }
  // Anything that is not an identifier-shaped class or code is dropped.
  expect(
    projectInputAccessDiagnostic(
      projectInputAccessFault(
        Object.assign(new Error("x"), { code: "/private/fixture/.dev" })
      )
    )
  ).toBe("Error");
  expect(
    projectInputAccessDiagnostic(projectInputAccessFault("/private/fixture"))
  ).toBe("string");
  expect(
    projectInputAccessDiagnostic(
      new ProjectInputAccessError("unreadable", "/private/fixture/.dev")
    )
  ).toBe("ProjectInputAccessError");
  expect(projectInputAccessDiagnostic(new Error("other"))).toBeUndefined();
});

/** A synthetic filesystem fault shaped like Bun's, with a path in its message. */
function fsFault(code: string, path: string): Error {
  return Object.assign(
    new Error(`${code}: operation failed, lstat '${path}'`),
    {
      code,
      syscall: "lstat",
      path,
    }
  );
}

/** Make `lstat` of exactly `path` fail with `code`; other paths are real. */
function failLstat(path: string, code: string): void {
  const realLstat = fs.lstat;
  spyOn(fs, "lstat").mockImplementation(((
    ...args: Parameters<typeof fs.lstat>
  ) =>
    args[0] === path
      ? Promise.reject(fsFault(code, path))
      : realLstat(...args)) as typeof fs.lstat);
}

test("input presence checks classify through the projectInputAccessFault seam", async () => {
  // HACK-1415: the seam test above proves the classifier, not that
  // inputPresent() uses it. Fault the real presence check of one input so a
  // re-inlined classifier that drops EPERM (or the diagnostic) fails here.
  for (const [code, access] of [
    ["EPERM", "permission"],
    ["EACCES", "permission"],
    ["EIO", "unreadable"],
  ] as const) {
    const root = await fixture();
    await file(root, ".hack/docker-compose.yml");
    failLstat(join(root, ".dev", "docker-compose.yml"), code);
    const error = await inputAccessFault(root);
    mock.restore();
    expect(error).toBeInstanceOf(ProjectInputAccessError);
    expect({
      code,
      access: (error as ProjectInputAccessError).access,
    }).toEqual({ code, access });
    expectValueFreeDiagnostic(error, root, `Error:${code}`);
  }
});

async function adoptionSelectionFault(root: string): Promise<unknown> {
  try {
    await inspectLegacyComposeAdoptionSelection({ projectRoot: root });
  } catch (error: unknown) {
    return error;
  }
  throw new Error("unexpected adoption selection success");
}

test("a file where .hack belongs keeps a value-free adoption marker diagnostic", async () => {
  // HACK-1415: the adoption marker's filesystem refusals carry the same
  // class/code diagnostic as ProjectInputAccessError.
  const root = await fixture();
  await file(root, ".hack", "not a directory");
  for (const error of [
    await adoptionSelectionFault(root),
    await inputAccessFault(root),
  ]) {
    expect(error).toBeInstanceOf(LegacyComposeAdoptionSelectionError);
    expect((error as LegacyComposeAdoptionSelectionError).kind).toBe(
      "input-access"
    );
    expectValueFreeDiagnostic(
      error,
      root,
      "Error:ENOTDIR",
      legacyComposeAdoptionSelectionDiagnostic
    );
  }
});

test("EPERM on the adoption state root is a permission refusal with its diagnostic", async () => {
  // A fixture cannot produce EPERM, so fault the marker's state-root lstat.
  const root = await fixture();
  await file(root, ".hack/docker-compose.yml");
  failLstat(join(root, ".hack/.internal/legacy-compose-adoption-v1"), "EPERM");
  const error = await adoptionSelectionFault(root);
  expect(error).toBeInstanceOf(LegacyComposeAdoptionSelectionError);
  expect((error as LegacyComposeAdoptionSelectionError).kind).toBe(
    "permission"
  );
  expect((error as LegacyComposeAdoptionSelectionError).code).toBe(
    "E_PERMISSION"
  );
  expectValueFreeDiagnostic(
    error,
    root,
    "Error:EPERM",
    legacyComposeAdoptionSelectionDiagnostic
  );
});

test("only filesystem adoption marker refusals carry a diagnostic", () => {
  expect(
    legacyComposeAdoptionSelectionDiagnostic(
      new LegacyComposeAdoptionSelectionError()
    )
  ).toBeUndefined();
  expect(
    legacyComposeAdoptionSelectionDiagnostic(
      new LegacyComposeAdoptionSelectionError(
        "permission",
        "/private/fixture/.hack"
      )
    )
  ).toBe("LegacyComposeAdoptionSelectionError");
  expect(
    legacyComposeAdoptionSelectionDiagnostic(
      new LegacyComposeAdoptionSelectionError("input-access")
    )
  ).toBe("LegacyComposeAdoptionSelectionError");
  expect(
    legacyComposeAdoptionSelectionDiagnostic(
      new ProjectInputAccessError("permission", "Error:EACCES")
    )
  ).toBeUndefined();
});

// Root can search a mode-000 or mode-0644 directory, so this fault cannot be
// produced.
test.skipIf(process.getuid?.() === 0)(
  "an unsearchable .hack or .hack/.internal keeps a value-free adoption marker diagnostic",
  async () => {
    for (const [dir, mode] of [
      [".hack", 0o000],
      [".hack", 0o644],
      [".hack/.internal", 0o000],
      [".hack/.internal", 0o644],
    ] as const) {
      const root = await fixture();
      await file(root, ".hack/docker-compose.yml");
      await mkdir(join(root, ".hack/.internal"));
      const locked = join(root, dir);
      await chmod(locked, mode);
      try {
        const error = await inputAccessFault(root);
        expect(error).toBeInstanceOf(LegacyComposeAdoptionSelectionError);
        expect({
          dir,
          mode,
          kind: (error as LegacyComposeAdoptionSelectionError).kind,
        }).toEqual({ dir, mode, kind: "permission" });
        expectValueFreeDiagnostic(
          error,
          root,
          "Error:EACCES",
          legacyComposeAdoptionSelectionDiagnostic
        );
      } finally {
        await chmod(locked, 0o755);
      }
    }
  }
);

// Root can search a mode-000 directory, so this fault cannot be produced.
test.skipIf(process.getuid?.() === 0)(
  "an unsearchable .dev beside valid .hack inputs is a typed permission refusal",
  async () => {
    const root = await fixture();
    await file(root, ".hack/docker-compose.yml");
    const dev = join(root, ".dev");
    await mkdir(dev);
    await chmod(dev, 0);
    try {
      const error = await inputAccessFault(root);
      expect(error).toBeInstanceOf(ProjectInputAccessError);
      expect((error as ProjectInputAccessError).access).toBe("permission");
      expectValueFreeDiagnostic(error, root, "Error:EACCES");
    } finally {
      await chmod(dev, 0o700);
    }
  }
);

test("supported legacy discovery keeps primary-before-legacy precedence", async () => {
  const outer = await fixture();
  await file(outer, ".hack/docker-compose.yml");
  const child = join(outer, "child");
  await file(child, ".dev/docker-compose.yml");
  expect((await findProjectContext(child))?.projectRoot).toBe(outer);
});

test("dangling legacy Compose is not a discovery candidate but still conflicts with native", async () => {
  const outer = await fixture();
  await file(outer, ".hack/docker-compose.yml");
  const child = join(outer, "child");
  await mkdir(join(child, ".hack"), { recursive: true });
  await symlink(
    join(child, "missing"),
    join(child, ".hack/docker-compose.yml")
  );
  expect((await findProjectContext(child))?.projectRoot).toBe(outer);
  await native(child);
  await expect(findProjectContext(child)).rejects.toThrow(
    "E_NATIVE_PROJECT_CONFLICT"
  );
});

test("a nested legacy project can run below a native ancestor without crossing it", async () => {
  const outer = await fixture();
  await native(outer);
  const child = join(outer, "child");
  await file(child, ".dev/docker-compose.yml");
  expect((await findProjectContext(child))?.projectRoot).toBe(child);
});

test("exact-root lookup never adopts an ancestor project", async () => {
  const outer = await fixture();
  await file(outer, ".hack/docker-compose.yml");
  const child = join(outer, "child");
  await mkdir(child);
  expect(await findProjectContextAtRoot({ projectRoot: child })).toBeNull();
  await native(child);
  await expect(
    findProjectContextAtRoot({ projectRoot: child })
  ).rejects.toThrow("E_NATIVE_PROJECT_UNSUPPORTED");
});

test("init cannot cross an intervening native root to an ancestor package", async () => {
  const outer = await fixture();
  await file(outer, "package.json", "{}");
  const inner = join(outer, "native");
  await native(inner);
  const child = join(inner, "child");
  await file(child, ".dev/docker-compose.yml");
  await expect(findRepoRootForInit(child)).rejects.toThrow(
    "E_NATIVE_PROJECT_UNSUPPORTED"
  );
  await file(child, ".git", "gitdir: unused");
  expect(await findRepoRootForInit(child)).toBe(child);
  await file(child, "package.json", "{}");
  expect(await findRepoRootForInit(child)).toBe(child);
});

test("constructed-context read and both project update helpers refuse without changing bytes", async () => {
  const root = await fixture();
  await native(root);
  const configFile = await file(
    root,
    ".hack/hack.config.json",
    '{"name":"keep"}'
  );
  const projectDir = join(root, ".hack");
  const context = {
    projectRoot: root,
    projectDirName: ".hack" as const,
    projectDir,
    configFile,
    composeFile: join(projectDir, "docker-compose.yml"),
    envFile: join(projectDir, ".env"),
  };
  await expect(readProjectConfig(context)).rejects.toThrow(
    "E_NATIVE_PROJECT_CONFLICT"
  );
  await expect(
    updateProjectConfig({ projectDir, path: "name", value: "overwrite" })
  ).rejects.toThrow("E_NATIVE_PROJECT_CONFLICT");
  await expect(
    updateProjectConfigBatch({
      projectDir,
      values: [{ path: "name", value: "overwrite" }],
    })
  ).rejects.toThrow("E_NATIVE_PROJECT_CONFLICT");
  expect(await readFile(configFile, "utf8")).toBe('{"name":"keep"}');
});

test("native-only project update cannot create a competing legacy definition", async () => {
  const root = await fixture();
  await native(root);
  const projectDir = join(root, ".hack");
  await expect(
    updateProjectConfig({ projectDir, path: "name", value: "legacy" })
  ).rejects.toThrow("E_NATIVE_PROJECT_UNSUPPORTED");
  expect(await Bun.file(join(projectDir, "hack.config.json")).exists()).toBe(
    false
  );
});
