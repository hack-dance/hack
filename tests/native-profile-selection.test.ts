import { expect, test } from "bun:test";
import {
  declaredComposeProfiles,
  NATIVE_SECRET_PROFILE_SELECTOR_NOTICE,
  nativeInactiveServices,
  nativeLeftOutNotice,
  nativeNoticeProfileNames,
  nativeRetainedProfilesNotice,
  parseNativeProfileNotice,
  renderNativeProfileNotice,
  selectNativeProfiles,
} from "../src/backends/native-profile-selection.ts";

const declared = ["jobs", "ops", "search"];

test("--profile wins over every COMPOSE_PROFILES", () => {
  expect(
    selectNativeProfiles({
      cliProfiles: ["ops"],
      managedEnv: { COMPOSE_PROFILES: "jobs" },
      shellEnv: { COMPOSE_PROFILES: "search" },
      declaredProfiles: declared,
    })
  ).toMatchObject({ profiles: ["ops"], source: "cli" });
});

test("COMPOSE_PROFILES in the managed env overrides the shell, as Compose under Hack", () => {
  expect(
    selectNativeProfiles({
      cliProfiles: undefined,
      managedEnv: { COMPOSE_PROFILES: "jobs, search" },
      shellEnv: { COMPOSE_PROFILES: "ops" },
      declaredProfiles: declared,
    })
  ).toMatchObject({ profiles: ["jobs", "search"], source: "managed-env" });
  // An empty managed value still overrides the shell: no profiles.
  expect(
    selectNativeProfiles({
      cliProfiles: [],
      managedEnv: { COMPOSE_PROFILES: "" },
      shellEnv: { COMPOSE_PROFILES: "ops" },
      declaredProfiles: declared,
    })
  ).toMatchObject({ profiles: [], source: "managed-env" });
});

test("the shell is the last source, then none", () => {
  expect(
    selectNativeProfiles({
      cliProfiles: undefined,
      managedEnv: {},
      shellEnv: { COMPOSE_PROFILES: "ops" },
      declaredProfiles: declared,
    })
  ).toMatchObject({ profiles: ["ops"], source: "shell" });
  expect(
    selectNativeProfiles({
      cliProfiles: undefined,
      managedEnv: {},
      shellEnv: {},
      declaredProfiles: declared,
    })
  ).toMatchObject({ profiles: [], source: "none" });
});

test("* selects every declared profile by name", () => {
  expect(
    selectNativeProfiles({
      cliProfiles: undefined,
      managedEnv: { COMPOSE_PROFILES: "*" },
      shellEnv: {},
      declaredProfiles: declared,
    }).profiles
  ).toEqual(declared);
});

test("declared profiles are read from every service, deduplicated and sorted", () => {
  expect(
    declaredComposeProfiles({
      services: {
        web: {},
        worker: { profiles: ["jobs", "ops"] },
        search: { profiles: ["search", "jobs"] },
      },
    })
  ).toEqual(declared);
  expect(declaredComposeProfiles("not a document")).toEqual([]);
});

test("the left-out notice names inactive services, the selection and its source; none when all are active", () => {
  const services = nativeInactiveServices({
    services: {
      web: { active: true },
      worker: { active: false },
      search: { active: false },
    },
  });
  expect(services).toEqual(["search", "worker"]);
  expect(
    nativeLeftOutNotice({ services, profiles: ["ops"], source: "managed-env" })
  ).toBe(
    "Not starting 2 services whose Compose profiles are not selected: search, worker. Selected profiles: ops (from COMPOSE_PROFILES in the managed env). Select others with --profile or COMPOSE_PROFILES."
  );
  expect(
    nativeLeftOutNotice({ services: [], profiles: [], source: "none" })
  ).toBeNull();
});

test("a retained run that keeps other profiles than the env selects says so and how to change them", () => {
  expect(
    nativeRetainedProfilesNotice({
      retained: [],
      selected: ["jobs", "search"],
      source: "managed-env",
    })
  ).toBe(
    "COMPOSE_PROFILES in the managed env selects profiles jobs, search, but this instance's retained run uses none; it keeps those. To start it with the new profiles, stop it with hack down --remove-data (this deletes its data volumes) and run hack up again."
  );
});

test("profile notices cross IPC as names only; anything else is dropped", () => {
  const leftOut = {
    kind: "left-out",
    services: ["worker"],
    profiles: [],
    source: "none",
  } as const;
  expect(parseNativeProfileNotice(leftOut)).toEqual(leftOut);
  expect(renderNativeProfileNotice(leftOut)).toContain("worker");
  const retained = {
    kind: "retained",
    retained: [],
    selected: ["jobs"],
    source: "shell",
  } as const;
  expect(parseNativeProfileNotice(retained)).toEqual(retained);
  for (const bad of [
    { ...leftOut, services: ["has space"] },
    { ...leftOut, source: "elsewhere" },
    { ...retained, source: "cli" },
    { ...leftOut, services: Array.from({ length: 300 }, (_, i) => `s${i}`) },
    "Not starting everything",
  ]) {
    expect(parseNativeProfileNotice(bad)).toBeNull();
  }
});

test("a project's managed env selects native profiles, overriding the shell (HACK-2338 item 8)", async () => {
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { findProjectContextAtRoot } = await import("../src/lib/project.ts");
  const { resolveNativeProfileSelectionForProject } = await import(
    "../src/backends/native-profile-selection.ts"
  );
  const root = await mkdtemp(join(tmpdir(), "native-profiles-"));
  const original = process.env.COMPOSE_PROFILES;
  try {
    const projectDir = join(root, ".hack");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "docker-compose.yml"),
      [
        "services:",
        "  web:",
        "    image: alpine:3.21",
        "  worker:",
        "    image: alpine:3.21",
        "    profiles: [jobs]",
        "  search:",
        "    image: alpine:3.21",
        "    profiles: [search]",
        "",
      ].join("\n")
    );
    await writeFile(
      join(projectDir, "hack.config.json"),
      '{"name":"native-profiles","dev_host":"native-profiles.hack"}\n'
    );
    await writeFile(
      join(projectDir, "hack.env.default.yaml"),
      [
        "version: 1",
        "environment: default",
        "secretsprovider: project_key",
        "values:",
        "  global:",
        '    COMPOSE_PROFILES: "jobs,search"',
        "",
      ].join("\n")
    );
    const project = await findProjectContextAtRoot({ projectRoot: root });
    if (!project) {
      throw new Error("Expected fixture project context");
    }
    process.env.COMPOSE_PROFILES = "ops";
    expect(
      await resolveNativeProfileSelectionForProject({
        project,
        envName: undefined,
        cliProfile: undefined,
      })
    ).toMatchObject({ profiles: ["jobs", "search"], source: "managed-env" });
    expect(
      await resolveNativeProfileSelectionForProject({
        project,
        envName: undefined,
        cliProfile: "ops",
      })
    ).toMatchObject({ profiles: ["ops"], source: "cli" });
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(process.env, "COMPOSE_PROFILES");
    } else {
      process.env.COMPOSE_PROFILES = original;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty --profile names no profile, so COMPOSE_PROFILES still applies, as on Compose", async () => {
  const { nativeProfileOption } = await import("../src/commands/project.ts");
  for (const empty of [undefined, "", " ", ",", " , "]) {
    expect(nativeProfileOption(empty)).toBeUndefined();
  }
  expect(nativeProfileOption("jobs")).toBe("jobs");
  expect(nativeProfileOption("jobs,ops")).toBe("jobs,ops");
});

test("notices print only explicit --profile names; environment and retained names are counted", () => {
  const token = "synthetic-secret-token-value";
  // A project can declare guesses as profiles, so declaring a name does not
  // make an environment-selected value safe to print.
  for (const source of ["managed-env", "shell", "retained"] as const) {
    expect(
      nativeNoticeProfileNames({ profiles: ["jobs", token], source })
    ).toEqual({ shown: [], hidden: 2 });
  }
  expect(
    nativeNoticeProfileNames({ profiles: ["jobs"], source: "cli" })
  ).toEqual({ shown: ["jobs"], hidden: 0 });
  const notice = nativeRetainedProfilesNotice({
    retained: [],
    hiddenRetained: 1,
    selected: [],
    hiddenSelected: 2,
    source: "managed-env",
  });
  expect(notice).toContain(
    "selects profiles 2 profiles (names not shown), but this instance's retained run uses 1 profile (names not shown)"
  );
  expect(notice).not.toContain(token);
  const leftOut = nativeLeftOutNotice({
    services: ["worker"],
    profiles: [],
    hiddenProfiles: 2,
    source: "managed-env",
  });
  expect(leftOut).toContain("Selected profiles: 2 profiles (names not shown)");
  expect(
    parseNativeProfileNotice({
      kind: "retained",
      retained: [],
      selected: ["jobs"],
      hiddenSelected: 1,
      source: "managed-env",
    })
  ).toMatchObject({ hiddenSelected: 1 });
  expect(
    parseNativeProfileNotice({
      kind: "left-out",
      services: [],
      profiles: [],
      hiddenProfiles: -1,
      source: "none",
    })
  ).toBeNull();
});

test("an undeclared COMPOSE_PROFILES value is dropped before use, never just hidden", () => {
  const token = "synthetic-secret-token-value";
  for (const managedEnv of [{ COMPOSE_PROFILES: `jobs,${token}` }, {}]) {
    const selection = selectNativeProfiles({
      cliProfiles: undefined,
      managedEnv,
      shellEnv: { COMPOSE_PROFILES: `jobs,${token}` },
      declaredProfiles: ["jobs", "ops"],
    });
    expect(selection.profiles).toEqual(["jobs"]);
    expect(selection.ignoredUndeclared).toBe(1);
    expect(JSON.stringify(selection.profiles)).not.toContain(token);
  }
  // An explicit --profile is the caller's own text and is kept as typed.
  expect(
    selectNativeProfiles({
      cliProfiles: ["custom"],
      managedEnv: {},
      shellEnv: {},
      declaredProfiles: ["jobs"],
    }).profiles
  ).toEqual(["custom"]);
});

test("a COMPOSE_PROFILES stored as a secret in the managed env is never used as a selector", async () => {
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { findProjectContextAtRoot } = await import("../src/lib/project.ts");
  const { resolveNativeProfileSelectionForProject } = await import(
    "../src/backends/native-profile-selection.ts"
  );
  const root = await mkdtemp(join(tmpdir(), "native-profiles-secret-"));
  const original = process.env.COMPOSE_PROFILES;
  try {
    const projectDir = join(root, ".hack");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "docker-compose.yml"),
      "services:\n  web:\n    image: alpine:3.21\n  worker:\n    image: alpine:3.21\n    profiles: [jobs]\n"
    );
    await writeFile(
      join(projectDir, "hack.config.json"),
      '{"name":"native-profiles-secret","dev_host":"native-profiles-secret.hack"}\n'
    );
    const { setProjectEnvValue } = await import(
      "../src/lib/project-env-config.ts"
    );
    // Stored the way `hack env add --secret` stores it (encrypted).
    await setProjectEnvValue({
      projectRoot: root,
      projectDir,
      envName: null,
      scope: "global",
      key: "COMPOSE_PROFILES",
      value: "jobs",
      secret: true,
    });
    const project = await findProjectContextAtRoot({ projectRoot: root });
    if (!project) {
      throw new Error("Expected fixture project context");
    }
    // The managed secret overrides the shell, so the shell does not apply.
    process.env.COMPOSE_PROFILES = "jobs";
    const selection = await resolveNativeProfileSelectionForProject({
      project,
      envName: undefined,
      cliProfile: undefined,
    });
    expect(selection).toMatchObject({
      profiles: [],
      source: "none",
      secretIgnored: true,
    });
    expect(renderNativeProfileNotice({ kind: "secret-selector" })).toBe(
      NATIVE_SECRET_PROFILE_SELECTOR_NOTICE
    );
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(process.env, "COMPOSE_PROFILES");
    } else {
      process.env.COMPOSE_PROFILES = original;
    }
    await rm(root, { recursive: true, force: true });
  }
});
