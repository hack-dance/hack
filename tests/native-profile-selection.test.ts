import { expect, test } from "bun:test";
import {
  declaredComposeProfiles,
  nativeInactiveProfileNotice,
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
  ).toEqual({ profiles: ["ops"], source: "cli" });
});

test("COMPOSE_PROFILES in the managed env overrides the shell, as Compose under Hack", () => {
  expect(
    selectNativeProfiles({
      cliProfiles: undefined,
      managedEnv: { COMPOSE_PROFILES: "jobs, search" },
      shellEnv: { COMPOSE_PROFILES: "ops" },
      declaredProfiles: declared,
    })
  ).toEqual({ profiles: ["jobs", "search"], source: "managed-env" });
  // An empty managed value still overrides the shell: no profiles.
  expect(
    selectNativeProfiles({
      cliProfiles: [],
      managedEnv: { COMPOSE_PROFILES: "" },
      shellEnv: { COMPOSE_PROFILES: "ops" },
      declaredProfiles: declared,
    })
  ).toEqual({ profiles: [], source: "managed-env" });
});

test("the shell is the last source, then none", () => {
  expect(
    selectNativeProfiles({
      cliProfiles: undefined,
      managedEnv: {},
      shellEnv: { COMPOSE_PROFILES: "ops" },
      declaredProfiles: declared,
    })
  ).toEqual({ profiles: ["ops"], source: "shell" });
  expect(
    selectNativeProfiles({
      cliProfiles: undefined,
      managedEnv: {},
      shellEnv: {},
      declaredProfiles: declared,
    })
  ).toEqual({ profiles: [], source: "none" });
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

test("the notice names inactive services, the selection and its source; none when all are active", () => {
  const plan = {
    services: {
      web: { active: true },
      worker: { active: false },
      search: { active: false },
    },
  };
  expect(
    nativeInactiveProfileNotice({
      plan,
      selection: { profiles: ["ops"], source: "managed-env" },
    })
  ).toBe(
    "Not starting 2 services whose Compose profiles are not selected: search, worker. Selected profiles: ops (from COMPOSE_PROFILES in the managed env). Select others with --profile or COMPOSE_PROFILES."
  );
  expect(
    nativeInactiveProfileNotice({
      plan: { services: { web: { active: true } } },
      selection: { profiles: [], source: "none" },
    })
  ).toBeNull();
});

test("a project's managed env selects native profiles, overriding the shell (HACK-2338 item 8)", async () => {
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { findProjectContextAtRoot } = await import("../src/lib/project.ts");
  const { resolveNativeProfileSelectionForProject } = await import(
    "../src/commands/project.ts"
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
    ).toEqual({ profiles: ["jobs", "search"], source: "managed-env" });
    expect(
      await resolveNativeProfileSelectionForProject({
        project,
        envName: undefined,
        cliProfile: "ops",
      })
    ).toEqual({ profiles: ["ops"], source: "cli" });
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(process.env, "COMPOSE_PROFILES");
    } else {
      process.env.COMPOSE_PROFILES = original;
    }
    await rm(root, { recursive: true, force: true });
  }
});
