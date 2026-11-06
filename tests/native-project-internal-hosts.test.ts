import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeHostDependency } from "../src/backends/native-project-dependencies.ts";
import type { NativeProjectInput } from "../src/backends/native-project-input.ts";
import {
  applyNativeInternalHostAliases,
  NATIVE_INTERNAL_HOST_ALIAS_REFUSAL,
  NATIVE_INTERNAL_HOSTS_CHANGED_REFUSAL,
  NATIVE_INTERNAL_HOSTS_UNREADABLE_REFUSAL,
  NATIVE_UNBOUND_HOST_ALIAS_REFUSAL,
  nativeServiceHostAliases,
  requireNativeHostAliasBindings,
  requireNativeInternalExtraHostsUnchanged,
  requireNativeProjectInternalExtraHostsUnchanged,
  resolveNativeInternalExtraHosts,
} from "../src/backends/native-project-internal-hosts.ts";
import {
  readLocalExtraHosts,
  resolveExtraHostsPath,
  resolveInternalExtraHosts,
  UNREADABLE_EXTRA_HOSTS_MAP,
} from "../src/lib/internal-extra-hosts.ts";
import { type ProjectContext, readProjectConfig } from "../src/lib/project.ts";
import {
  expectCodedRefusal,
  expectCodedThrow,
} from "./helpers/closed-refusal.ts";

function input(services: Record<string, unknown>): NativeProjectInput {
  return {
    originalSha256: "d".repeat(64),
    normalizedComposeJson: JSON.stringify({ services }),
    managedEnvironment: {},
    lifecycleHostEnvironment: {},
    environmentFiles: [],
    effectiveEnvName: null,
    serviceNames: Object.keys(services),
  };
}
function services(result: NativeProjectInput): Record<string, any> {
  return JSON.parse(result.normalizedComposeJson).services;
}
function binding(service: string, aliases: string[]): NativeHostDependency {
  return {
    service,
    binding: "api",
    slot: 0,
    guest_port: 443,
    aliases,
    host_pid: 123,
    host_port: 8443,
  };
}

test("no project-wide aliases leaves the normalized input byte-identical", () => {
  const original = input({ web: { image: "nginx" } });
  for (const hosts of [undefined, {}]) {
    expect(
      applyNativeInternalHostAliases({
        input: original,
        hosts,
        hasDependencySelection: false,
      })
    ).toBe(original);
  }
});

test("project-wide aliases are declared on every service like the Compose override", () => {
  const result = applyNativeInternalHostAliases({
    input: input({
      web: { image: "nginx" },
      worker: {
        image: "nginx",
        extra_hosts: ["own.example.test:host-gateway"],
      },
      map: {
        image: "nginx",
        extra_hosts: { "api.example.test": "host-gateway" },
      },
      later: { image: "nginx", profiles: ["later"] },
    }),
    hosts: {
      "api.example.test": "host-gateway",
      "auth.example.test": "host-gateway",
    },
    hasDependencySelection: true,
  });
  expect(services(result)).toEqual({
    web: {
      image: "nginx",
      extra_hosts: [
        "api.example.test:host-gateway",
        "auth.example.test:host-gateway",
      ],
    },
    worker: {
      image: "nginx",
      extra_hosts: [
        "own.example.test:host-gateway",
        "api.example.test:host-gateway",
        "auth.example.test:host-gateway",
      ],
    },
    map: {
      image: "nginx",
      extra_hosts: {
        "api.example.test": "host-gateway",
        "auth.example.test": "host-gateway",
      },
    },
    later: {
      image: "nginx",
      profiles: ["later"],
      extra_hosts: [
        "api.example.test:host-gateway",
        "auth.example.test:host-gateway",
      ],
    },
  });
});

test("project-wide aliases without any dependency selection refuse instead of being ignored", () => {
  expectCodedThrow(
    () =>
      applyNativeInternalHostAliases({
        input: input({ web: { image: "nginx" } }),
        hosts: { "api.example.test": "host-gateway" },
        hasDependencySelection: false,
      }),
    "E_NATIVE_PROJECT_UNSUPPORTED",
    NATIVE_UNBOUND_HOST_ALIAS_REFUSAL
  );
});

test("project-wide aliases native cannot honor refuse value-free", () => {
  for (const hosts of [
    { "api.example.test": "10.0.0.5" },
    { "api.example.test": "Host-Gateway" },
    { "API.example.test": "host-gateway" },
    { "*.example.test": "host-gateway" },
    { localhost: "host-gateway" },
    { "app.localhost": "host-gateway" },
    { "127.0.0.1": "host-gateway" },
    Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [
        `h${i}.example.test`,
        "host-gateway",
      ])
    ),
  ]) {
    const error = expectCodedThrow(
      () =>
        applyNativeInternalHostAliases({
          input: input({ web: { image: "nginx" } }),
          hosts,
          hasDependencySelection: true,
        }),
      "E_NATIVE_PROJECT_UNSUPPORTED",
      NATIVE_INTERNAL_HOST_ALIAS_REFUSAL
    );
    expect(error.message).not.toContain("example");
    expect(error.message).not.toContain("10.0.0.5");
  }
});

test("a service that maps the alias to another target conflicts", () => {
  for (const extra_hosts of [
    ["api.example.test:10.0.0.5"],
    ["api.example.test=10.0.0.5"],
    { "api.example.test": "10.0.0.5" },
    "api.example.test:host-gateway",
    Array.from({ length: 32 }, (_, i) => `h${i}.example.test:host-gateway`),
  ]) {
    expectCodedThrow(
      () =>
        applyNativeInternalHostAliases({
          input: input({ web: { image: "nginx", extra_hosts } }),
          hosts: { "api.example.test": "host-gateway" },
          hasDependencySelection: true,
        }),
      "E_CONFIG_INVALID",
      "Native host alias selection conflicts with declared configuration; values omitted."
    );
  }
});

test("host aliases are collected only for profile-active services", () => {
  expect(
    nativeServiceHostAliases({
      services: {
        web: { extra_hosts: ["api.example.test:host-gateway"] },
        eq: { extra_hosts: ["eq.example.test=host-gateway"] },
        map: {
          extra_hosts: {
            "map.example.test": "host-gateway",
            "fixed.example.test": "10.0.0.5",
          },
        },
        plain: {},
        later: {
          profiles: ["later"],
          extra_hosts: ["api.example.test:host-gateway"],
        },
        selected: {
          profiles: ["debug"],
          extra_hosts: ["api.example.test:host-gateway"],
        },
      },
      profiles: ["debug"],
    })
  ).toEqual({
    web: ["api.example.test"],
    eq: ["eq.example.test"],
    map: ["map.example.test"],
    plain: [],
    selected: ["api.example.test"],
  });
});

test("service aliases are canonicalized like native review before matching bindings", () => {
  const hostAliases = nativeServiceHostAliases({
    services: {
      web: { extra_hosts: ["API.Example.:host-gateway"] },
      map: { extra_hosts: { "Search.EXAMPLE.test.": "host-gateway" } },
      both: {
        extra_hosts: ["api.example:host-gateway", "API.EXAMPLE.=host-gateway"],
      },
      // Resolved by the runtime later; admission checks these exactly.
      later: { extra_hosts: ["${ALIAS}:host-gateway", "1.2.3.4:host-gateway"] },
    },
    profiles: [],
  });
  expect(hostAliases).toEqual({
    web: ["api.example"],
    map: ["search.example.test"],
    both: ["api.example"],
    later: [],
  });
  requireNativeHostAliasBindings({
    dependencies: [
      binding("web", ["api.example"]),
      binding("map", ["search.example.test"]),
      binding("both", ["api.example"]),
    ],
    hostAliases,
  });
  // A genuinely different name is still unbound.
  expectCodedThrow(
    () =>
      requireNativeHostAliasBindings({
        dependencies: [binding("web", ["api.example.test"])],
        hostAliases: { web: hostAliases.web ?? [] },
      }),
    "E_NATIVE_PROJECT_UNSUPPORTED",
    NATIVE_UNBOUND_HOST_ALIAS_REFUSAL
  );
});

test("a project-wide alias another spelling already declares is not duplicated", () => {
  const result = applyNativeInternalHostAliases({
    input: input({
      web: { image: "nginx", extra_hosts: ["API.Example.Test.:host-gateway"] },
      map: {
        image: "nginx",
        extra_hosts: { "Api.example.test": "host-gateway" },
      },
    }),
    hosts: { "api.example.test": "host-gateway" },
    hasDependencySelection: true,
  });
  expect(services(result)).toEqual({
    web: { image: "nginx", extra_hosts: ["API.Example.Test.:host-gateway"] },
    map: {
      image: "nginx",
      extra_hosts: { "Api.example.test": "host-gateway" },
    },
  });
  expectCodedThrow(
    () =>
      applyNativeInternalHostAliases({
        input: input({
          web: { image: "nginx", extra_hosts: ["API.Example.Test.:10.0.0.5"] },
        }),
        hosts: { "api.example.test": "host-gateway" },
        hasDependencySelection: true,
      }),
    "E_CONFIG_INVALID",
    "Native host alias selection conflicts with declared configuration; values omitted."
  );
});

test("every active declared alias needs a binding of that same service", () => {
  const hostAliases = {
    web: ["api.example.test", "auth.example.test"],
    worker: ["api.example.test"],
    plain: [],
  };
  requireNativeHostAliasBindings({
    dependencies: [
      binding("web", ["api.example.test", "auth.example.test"]),
      binding("worker", ["api.example.test"]),
    ],
    hostAliases,
  });
  for (const dependencies of [
    [],
    [binding("web", ["api.example.test", "auth.example.test"])],
    [
      binding("web", ["api.example.test"]),
      binding("worker", ["api.example.test", "auth.example.test"]),
    ],
  ]) {
    expectCodedThrow(
      () => requireNativeHostAliasBindings({ dependencies, hostAliases }),
      "E_NATIVE_PROJECT_UNSUPPORTED",
      NATIVE_UNBOUND_HOST_ALIAS_REFUSAL
    );
  }
});

test("aliases changed by lifecycle hooks refuse after hook cleanup", async () => {
  const reviewed = { "api.example.test": "host-gateway" };
  let cleaned = 0;
  const cleanup = async () => {
    cleaned++;
  };
  await requireNativeInternalExtraHostsUnchanged({
    reviewed,
    current: async () => ({ "api.example.test": "host-gateway" }),
    cleanup,
  });
  expect(cleaned).toBe(0);
  for (const current of [
    async () => ({}),
    async () => ({ "api.example.test": "10.0.0.5" }),
    async () => ({ ...reviewed, "auth.example.test": "host-gateway" }),
    async () => {
      throw new Error("synthetic unreadable map");
    },
  ]) {
    await expectCodedRefusal(
      requireNativeInternalExtraHostsUnchanged({ reviewed, current, cleanup }),
      "E_NATIVE_PROJECT_UNSUPPORTED",
      NATIVE_INTERNAL_HOSTS_CHANGED_REFUSAL
    );
  }
  expect(cleaned).toBe(4);
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/** A plain (non-Git) project checkout, so no primary aliases are inherited. */
async function projectFixture(config: unknown): Promise<ProjectContext> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-internal-hosts-"))
  );
  roots.push(root);
  const projectDir = join(root, ".hack");
  await mkdir(join(projectDir, ".internal"), { recursive: true });
  const configFile = join(projectDir, "hack.config.json");
  await writeFile(configFile, JSON.stringify(config));
  return {
    projectRoot: root,
    projectDirName: ".hack",
    projectDir,
    composeFile: join(projectDir, "docker-compose.yml"),
    envFile: join(projectDir, ".env"),
    configFile,
  };
}

test("a hook that edits hack.config.json extra_hosts refuses after cleanup", async () => {
  const config = {
    name: "hosts-fixture",
    internal: { extra_hosts: { "api.example.test": "host-gateway" } },
  };
  const project = await projectFixture(config);
  // Startup resolves the reviewed aliases from the configuration it read
  // before `up.before` ran.
  const cfg = await readProjectConfig(project);
  const reviewed = await resolveNativeInternalExtraHosts({ project, cfg });
  expect(reviewed).toEqual({ "api.example.test": "host-gateway" });
  let cleaned = 0;
  const cleanup = async () => {
    cleaned++;
  };
  await requireNativeProjectInternalExtraHostsUnchanged({
    project,
    reviewed,
    cleanup,
  });
  expect(cleaned).toBe(0);

  for (const edited of [
    JSON.stringify({
      ...config,
      internal: {
        extra_hosts: {
          "api.example.test": "host-gateway",
          "auth.example.test": "host-gateway",
        },
      },
    }),
    JSON.stringify({ ...config, internal: {} }),
    "{ not json",
  ]) {
    // The hook rewrites the file; the stale `cfg` snapshot still matches.
    await writeFile(project.configFile, edited);
    expect(await resolveNativeInternalExtraHosts({ project, cfg })).toEqual(
      reviewed
    );
    await expectCodedRefusal(
      requireNativeProjectInternalExtraHostsUnchanged({
        project,
        reviewed,
        cleanup,
      }),
      "E_NATIVE_PROJECT_UNSUPPORTED",
      NATIVE_INTERNAL_HOSTS_CHANGED_REFUSAL
    );
  }
  expect(cleaned).toBe(3);
});

test("an unreadable checkout-local alias map refuses; an absent one is empty", async () => {
  const project = await projectFixture({
    name: "hosts-fixture",
    internal: { extra_hosts: { "api.example.test": "host-gateway" } },
  });
  const path = resolveExtraHostsPath(project.projectDir);
  expect(await readLocalExtraHosts(path)).toEqual({});
  expect(await resolveNativeInternalExtraHosts({ project })).toEqual({
    "api.example.test": "host-gateway",
  });

  // A directory exists but cannot be read as a file, even when tests run as
  // root (unlike a mode-000 file).
  await mkdir(path);
  await expectCodedRefusal(
    readLocalExtraHosts(path),
    "E_CONFIG_INVALID",
    UNREADABLE_EXTRA_HOSTS_MAP
  );
  await expectCodedRefusal(
    resolveInternalExtraHosts(project),
    "E_CONFIG_INVALID",
    UNREADABLE_EXTRA_HOSTS_MAP
  );
  await expectCodedRefusal(
    resolveNativeInternalExtraHosts({ project }),
    "E_CONFIG_INVALID",
    NATIVE_INTERNAL_HOSTS_UNREADABLE_REFUSAL
  );
  // A post-hook map that became unreadable refuses rather than dropping it.
  await rm(path, { recursive: true });
  const reviewed = await resolveNativeInternalExtraHosts({ project });
  await mkdir(path);
  let cleaned = 0;
  await expectCodedRefusal(
    requireNativeProjectInternalExtraHostsUnchanged({
      project,
      reviewed,
      cleanup: async () => {
        cleaned++;
      },
    }),
    "E_NATIVE_PROJECT_UNSUPPORTED",
    NATIVE_INTERNAL_HOSTS_CHANGED_REFUSAL
  );
  expect(cleaned).toBe(1);
});
