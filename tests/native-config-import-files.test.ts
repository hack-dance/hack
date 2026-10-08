import { expect, spyOn, test } from "bun:test";
import {
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
import { isRecord } from "../src/lib/guards.ts";
import { acquireLegacyComposeAdoptionBinding } from "../src/lib/native-compose-adoption-binding.ts";
import { planLegacyComposeAdoption } from "../src/lib/native-compose-adoption-plan.ts";
import { compileNativeConfig } from "../src/lib/native-config-compiler.ts";
import {
  mapLegacyComposeFileDeclaration,
  mapLegacyComposeFileGrant,
} from "../src/lib/native-config-import-files.ts";
import {
  mapLegacyNativeAdoptionBaseline,
  mapLegacyNativeImport,
  mapLegacyNativeStorageAdoption,
} from "../src/lib/native-config-import-plan.ts";
import { previewNativeConfigImport } from "../src/lib/native-config-import-preview.ts";

const CANARY = "synthetic-private-file-import";
const CONFIG = '{"name":"fixture"}';
const BINARY = process.env.HACK_TEST_NATIVE_COMPILER_BINARY;
const fixture = {
  configs: {
    settings: { file: `./config-${CANARY}` },
    unused: { file: "../unused" },
  },
  secrets: { token: { file: `../secrets-${CANARY}` } },
  services: {
    reader: { image: "fixture:1", configs: ["settings"], secrets: ["token"] },
    sibling: {
      image: "fixture:1",
      profiles: ["later"],
      configs: [{ source: "settings", target: "/etc/settings", mode: "0444" }],
      secrets: [{ source: "token", target: "renamed", mode: 0o444 }],
    },
    ungranted: { image: "fixture:1" },
  },
};
function mapped(compose: unknown) {
  return mapLegacyNativeImport({
    configText: CONFIG,
    composeText: JSON.stringify(compose),
  });
}
function refused(result: ReturnType<typeof mapped>, code?: string) {
  expect(result.report.complete).toBe(false);
  expect(result.candidate).toBeUndefined();
  if (code) {
    expect(result.report.fields).toContainEqual(
      expect.objectContaining({ status: "refused", code })
    );
  }
  expect(JSON.stringify(result)).not.toContain(CANARY);
}

test("file declarations and Linux explicit grants preserve symbolic values without implicit access", () => {
  const raw = JSON.stringify(fixture);
  const result = mapped(fixture);
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    configs: {
      settings: { file: `.hack/config-${CANARY}` },
      unused: { file: "unused" },
    },
    secrets: { token: { file: `secrets-${CANARY}` } },
    services: {
      reader: {
        mounts: [
          {
            config: "settings",
            target: "/settings",
            access: "read-only",
            mode: "0444",
          },
          {
            secret: "token",
            target: "/run/secrets/token",
            access: "read-only",
            mode: "0444",
          },
        ],
      },
      sibling: {
        profiles: ["later"],
        mounts: [
          {
            config: "settings",
            target: "/etc/settings",
            access: "read-only",
            mode: "0444",
          },
          {
            secret: "token",
            target: "/run/secrets/renamed",
            access: "read-only",
            mode: "0444",
          },
        ],
      },
    },
  });
  expect(result.candidate).not.toHaveProperty("services.ungranted.mounts");
  expect(JSON.stringify(fixture)).toBe(raw);
  expect(Object.keys(result)).toEqual(["report"]);
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(JSON.stringify({ ...result })).not.toContain(CANARY);
  expect(Object.isFrozen(result.candidate?.configs)).toBe(true);
  expect(result.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/services/sibling/secrets/0/mode",
      code: "compose_file_mode_octal",
      target: "/services/sibling/mounts/1/mode",
      status: "normalized",
    })
  );
});

test("raw file and target locations remain authored while dollars decode exactly once", () => {
  const result = mapLegacyNativeImport({
    configText: CONFIG,
    composeText:
      "configs:\n  settings:\n    file: ../config-$${AMBIENT}-$$$$\nservices:\n  reader:\n    image: fixture:1\n    configs:\n      - source: settings\n        target: /etc/config-$${AMBIENT}-$$$$\n",
  });
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    configs: { settings: { file: "config-${AMBIENT}-$$" } },
    services: {
      reader: {
        mounts: [
          {
            config: "settings",
            target: "/etc/config-${AMBIENT}-$$",
            access: "read-only",
            mode: "0444",
          },
        ],
      },
    },
  });
  expect(result.report.fields).toContainEqual({
    document: "compose",
    pointer: "/configs/settings/file",
    line: 3,
    column: 5,
    status: "normalized",
    code: "compose_file_source_rebased",
    target: "/configs/settings/file",
  });
  expect(result.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/services/reader/configs/0/target",
      line: 9,
      column: 9,
      status: "normalized",
      code: "compose_file_target_normalized",
    })
  );
  expect(JSON.stringify(result)).not.toContain("${AMBIENT}");
});

function jobFileSource() {
  return {
    configs: { settings: { file: `../config-${CANARY}` } },
    secrets: { token: { file: `../secret-${CANARY}` } },
    services: {
      app: {
        image: "fixture",
        profiles: ["later"],
        depends_on: {
          initialize: { condition: "service_completed_successfully" },
        },
      },
      initialize: {
        build: { context: "..", dockerfile: "Dockerfile", target: "prepare" },
        profiles: ["later"],
        entrypoint: [],
        command: ["initialize", "$$HOME", "", CANARY],
        restart: "no",
        pull_policy: "build",
        configs: ["settings"],
        secrets: [{ source: "token", target: "renamed", mode: 292 }],
      },
    },
  };
}

test("converted build jobs publish every explicit file grant with native job provenance", () => {
  const source = jobFileSource();
  const before = JSON.stringify(source);
  const result = mapped(source);
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    configs: { settings: { file: `config-${CANARY}` } },
    secrets: { token: { file: `secret-${CANARY}` } },
    services: {
      app: { depends_on: [{ job: "initialize", condition: "completed" }] },
    },
    jobs: {
      initialize: {
        build: { context: ".", dockerfile: "Dockerfile", target: "prepare" },
        profiles: ["later"],
        entrypoint: { exec: [] },
        command: { exec: ["initialize", "$HOME", "", CANARY] },
        restart: { kind: "no" },
        pull_policy: "build",
        mounts: [
          {
            config: "settings",
            target: "/settings",
            access: "read-only",
            mode: "0444",
          },
          {
            secret: "token",
            target: "/run/secrets/renamed",
            access: "read-only",
            mode: "0444",
          },
        ],
      },
    },
  });
  expect(result.candidate).not.toHaveProperty("services.initialize");
  expect(result.candidate).not.toHaveProperty("services.app.mounts");
  for (const [pointer, target, code] of [
    [
      "/services/initialize/configs/0",
      "/jobs/initialize/mounts/0",
      "compose_linux_file_grant_policy",
    ],
    [
      "/services/initialize/secrets/0/source",
      "/jobs/initialize/mounts/1/secret",
      "exact",
    ],
    [
      "/services/initialize/secrets/0/mode",
      "/jobs/initialize/mounts/1/mode",
      "compose_file_mode_octal",
    ],
    [
      "/services/initialize/build/context",
      "/jobs/initialize/build/context",
      "compose_build_context_rebased",
    ],
  ]) {
    expect(result.report.fields).toContainEqual(
      expect.objectContaining({ document: "compose", pointer, target, code })
    );
  }
  expect(JSON.stringify(source)).toBe(before);
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(Object.isFrozen(result.candidate?.jobs)).toBe(true);
});

test("inactive job grants and job restrictions remain closed across preview purposes", () => {
  const source = jobFileSource();
  refused(
    mapped({
      ...source,
      services: {
        ...source.services,
        initialize: {
          ...source.services.initialize,
          configs: [{ source: "settings", uid: "0" }],
        },
      },
    }),
    "invalid_or_unsupported_file_grant"
  );
  refused(
    mapped({
      ...source,
      services: {
        ...source.services,
        initialize: { ...source.services.initialize, restart: "always" },
      },
    }),
    "job_restart_policy_unsupported"
  );
  refused(
    mapped({
      ...source,
      services: {
        ...source.services,
        initialize: {
          ...source.services.initialize,
          healthcheck: {
            test: ["CMD", "probe"],
            interval: "1s",
            timeout: "250ms",
            retries: 1,
          },
        },
      },
    }),
    "job_healthcheck_unsupported"
  );
  const retained = JSON.stringify({
    ...source,
    name: "fixture",
    volumes: { data: {} },
    services: {
      ...source.services,
      app: { ...source.services.app, volumes: ["data:/data"] },
    },
  });
  refused(
    mapLegacyNativeAdoptionBaseline({
      configText: CONFIG,
      composeText: retained,
    })
  );
  refused(
    mapLegacyNativeStorageAdoption({
      configText: CONFIG,
      composeText: retained,
    })
  );
  const plan = planLegacyComposeAdoption({
    configText: CONFIG,
    composeText: retained,
  });
  expect(plan.report.supported).toBe(false);
  expect(plan.intent).toBeUndefined();
  expect(plan.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/services/initialize",
      code: "completed_job_adoption_unqualified",
      status: "refused",
    })
  );
  expect(plan.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/services/initialize/configs/0",
      code: "unsupported_field",
      status: "refused",
    })
  );
  expect(JSON.stringify(plan)).not.toContain(CANARY);
});

test("absent native job namespace cannot invoke an inherited getter during file mapping", () => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "jobs");
  let invoked = 0;
  try {
    Object.defineProperty(Object.prototype, "jobs", {
      configurable: true,
      get() {
        invoked++;
        return { reader: { mounts: [{ secret: "foreign" }] } };
      },
    });
    const result = mapped({
      configs: { settings: { file: "./missing" } },
      services: { reader: { image: "fixture", configs: ["settings"] } },
    });
    expect(result.report.complete).toBe(true);
    expect(result.candidate).toMatchObject({
      services: {
        reader: { mounts: [{ config: "settings", target: "/settings" }] },
      },
    });
    expect(Object.hasOwn(result.candidate ?? {}, "jobs")).toBe(false);
    expect(invoked).toBe(0);
  } finally {
    if (original) {
      Object.defineProperty(Object.prototype, "jobs", original);
    } else {
      Reflect.deleteProperty(Object.prototype, "jobs");
    }
  }
});

test.each([
  { file: "settings", expected: ".hack/settings" },
  { file: "../settings", expected: "settings" },
  { file: "./directory/../settings", expected: ".hack/settings" },
  { file: "../config/./settings", expected: "config/settings" },
  { file: "../missing-$${NAME}-$$$$", expected: "missing-${NAME}-$$" },
])("file source %j rebases without reading missing material", ({
  file,
  expected,
}) => {
  const reads = spyOn(Bun, "file").mockImplementation(() => {
    throw new Error("Material lookup forbidden");
  });
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Execution forbidden");
  });
  const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
    throw new Error("Execution forbidden");
  });
  try {
    expect(mapLegacyComposeFileDeclaration({ file })).toEqual({
      file: expected,
    });
    expect(
      mapped({
        configs: { settings: { file } },
        services: { reader: { image: "fixture", configs: ["settings"] } },
      }).report.complete
    ).toBe(true);
    expect(reads).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  } finally {
    reads.mockRestore();
    spawn.mockRestore();
    spawnSync.mockRestore();
  }
});

test.each([
  "content",
  "environment",
  "external",
  "name",
  "driver",
  "labels",
  "env_ref",
  "unknown",
])("unused definition option %s refuses all namespaces even when empty", (key) => {
  for (const namespace of ["configs", "secrets"]) {
    for (const value of [null, false, [], {}, CANARY]) {
      const result = mapped({
        [namespace]: { unused: { file: "./missing", [key]: value } },
        services: { reader: { image: "fixture" } },
      });
      refused(result, "invalid_or_unsupported_file_declaration");
      expect(result.report.fields).toContainEqual(
        expect.objectContaining({
          pointer: `/${namespace}/unused/${key}`,
          status: "refused",
          code: "unsupported_field",
        })
      );
    }
  }
});

test.each(
  [
    undefined,
    null,
    false,
    7,
    [],
    "missing",
    {},
    { file: null },
    { file: 7 },
    { file: "" },
    { file: "." },
    { file: ".." },
    { file: "./" },
    { file: "missing/" },
    { file: "../../outside" },
    { file: "missing/../../.." },
    { file: "/absolute" },
    { file: "~/home" },
    { file: "C:\\drive" },
    { file: "file:external" },
    { file: "line\nfile" },
    { file: "nul\0file" },
    { file: "../$NAME" },
    { file: "../${NAME}" },
  ].map((value) => [value] as const)
)("malformed declaration %p cannot become a managed or external source", (value) => {
  expect(mapLegacyComposeFileDeclaration(value)).toBeUndefined();
});

test.each(
  [null, false, [], 7].map((value) => [value] as const)
)("bad authored file namespace %p refuses instead of vanishing", (value) => {
  refused(
    mapped({ configs: value, services: { reader: { image: "fixture" } } }),
    "invalid_file_declarations"
  );
});

test.each([
  "config",
  "secret",
] as const)("closed %s grant shape preserves defaults and explicit canonical targets", (kind) => {
  const destination = kind === "config" ? "/settings" : "/run/secrets/settings";
  expect(mapLegacyComposeFileGrant({ kind, value: "settings" })?.grant).toEqual(
    {
      ...(kind === "config" ? { config: "settings" } : { secret: "settings" }),
      target: destination,
      access: "read-only",
      mode: "0444",
    }
  );
  for (const mode of [undefined, "0444", 0o444]) {
    expect(
      mapLegacyComposeFileGrant({
        kind,
        value: {
          source: "settings",
          target: "/etc/settings",
          ...(mode === undefined ? {} : { mode }),
        },
      })?.grant
    ).toEqual({
      ...(kind === "config" ? { config: "settings" } : { secret: "settings" }),
      target: "/etc/settings",
      access: "read-only",
      mode: "0444",
    });
  }
  expect(
    mapLegacyComposeFileGrant({ kind, value: { source: "constructor" } })?.grant
  ).toMatchObject({ [kind]: "constructor" });
});

test.each(
  [
    null,
    false,
    7,
    [],
    {},
    { source: null },
    { source: "Bad" },
    { source: "a".repeat(64) },
    { source: "$NAME" },
    { source: "settings", mode: null },
    { source: "settings", mode: 444 },
    { source: "settings", mode: "444" },
    { source: "settings", mode: "0400" },
    { source: "settings", uid: 0 },
    { source: "settings", gid: "0" },
    { source: "settings", read_only: true },
    { source: "settings", access: "read-only" },
    { source: "settings", required: true },
    { source: "settings", unknown: CANARY },
    { source: "settings", target: null },
    { source: "settings", target: "/" },
    { source: "settings", target: "/a/../b" },
    { source: "settings", target: "/a//b" },
    { source: "settings", target: "/a/" },
    { source: "settings", target: "/$NAME" },
  ].map((value) => [value] as const)
)("malformed/unsupported grant %p refuses even in inactive service", (value) => {
  for (const kind of ["config", "secret"] as const) {
    expect(mapLegacyComposeFileGrant({ kind, value })).toBeUndefined();
    refused(
      mapped({
        [`${kind}s`]: { settings: { file: "./missing" } },
        services: {
          inactive: {
            image: "fixture",
            profiles: ["later"],
            [`${kind}s`]: [value],
          },
        },
      }),
      "invalid_or_unsupported_file_grant"
    );
  }
});

test("secret basename target is explicit; config relative and secret path-like names refuse", () => {
  expect(
    mapLegacyComposeFileGrant({
      kind: "secret",
      value: { source: "settings", target: "name-$${LITERAL}" },
    })?.grant
  ).toMatchObject({ target: "/run/secrets/name-${LITERAL}" });
  for (const target of [
    "relative",
    "../escape",
    "folder/name",
    "~/file",
    "",
    ".",
    "..",
    "C:\\file",
  ]) {
    expect(
      mapLegacyComposeFileGrant({
        kind: "config",
        value: { source: "settings", target },
      })
    ).toBeUndefined();
    if (target !== "relative") {
      expect(
        mapLegacyComposeFileGrant({
          kind: "secret",
          value: { source: "settings", target },
        })
      ).toBeUndefined();
    }
  }
});

test("accessor/symbol/prototype definitions and grants refuse without evaluating authority", () => {
  let invoked = false;
  for (const field of ["file", "content", "external"]) {
    const value = Object.defineProperty({ file: "missing" }, field, {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error(CANARY);
      },
    });
    expect(mapLegacyComposeFileDeclaration(value)).toBeUndefined();
  }
  for (const field of ["source", "target", "mode", "uid"]) {
    const value = Object.defineProperty({ source: "settings" }, field, {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error(CANARY);
      },
    });
    expect(
      mapLegacyComposeFileGrant({ kind: "secret", value })
    ).toBeUndefined();
  }
  expect(
    mapLegacyComposeFileDeclaration(Object.create({ file: "missing" }))
  ).toBeUndefined();
  expect(
    mapLegacyComposeFileGrant({
      kind: "secret",
      value: Object.create({ source: "settings" }),
    })
  ).toBeUndefined();
  expect(
    mapLegacyComposeFileDeclaration({
      file: "missing",
      [Symbol("unknown")]: CANARY,
    })
  ).toBeUndefined();
  expect(invoked).toBe(false);
});

test("missing required own fields cannot acquire inherited Object.prototype getters", () => {
  const originals = ["file", "source"].map((field) => ({
    field,
    descriptor: Object.getOwnPropertyDescriptor(Object.prototype, field),
  }));
  let invoked = 0;
  try {
    Object.defineProperty(Object.prototype, "file", {
      configurable: true,
      get() {
        invoked++;
        return `../${CANARY}`;
      },
    });
    Object.defineProperty(Object.prototype, "source", {
      configurable: true,
      get() {
        invoked++;
        return "settings";
      },
      set(value: unknown) {
        // YAML scalars author their own source field; retain that write without authorizing an inherited read.
        Object.defineProperty(this, "source", {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      },
    });
    expect(mapLegacyComposeFileDeclaration({})).toBeUndefined();
    expect(
      mapLegacyComposeFileGrant({ kind: "config", value: {} })
    ).toBeUndefined();
    expect(mapLegacyComposeFileDeclaration({ file: "./missing" })).toEqual({
      file: ".hack/missing",
    });
    expect(
      mapLegacyComposeFileGrant({
        kind: "secret",
        value: { source: "settings" },
      })?.grant
    ).toMatchObject({ secret: "settings", target: "/run/secrets/settings" });
    refused(
      mapLegacyNativeImport({
        configText: CONFIG,
        composeText:
          '{"configs":{"settings":{}},"services":{"reader":{"image":"fixture"}}}',
      }),
      "invalid_or_unsupported_file_declaration"
    );
    refused(
      mapLegacyNativeImport({
        configText: CONFIG,
        composeText:
          '{"configs":{"settings":{"file":"./missing"}},"services":{"reader":{"image":"fixture","configs":[{}]}}}',
      }),
      "invalid_or_unsupported_file_grant"
    );
    const own = mapLegacyNativeImport({
      configText: CONFIG,
      composeText:
        '{"configs":{"settings":{"file":"./missing"}},"services":{"reader":{"image":"fixture","configs":[{"source":"settings"}]}}}',
    });
    expect(own.report.complete).toBe(true);
    expect(invoked).toBe(0);
  } finally {
    for (const { field, descriptor } of originals) {
      if (descriptor) {
        Object.defineProperty(Object.prototype, field, descriptor);
      } else {
        Reflect.deleteProperty(Object.prototype, field);
      }
    }
  }
});

test("inherited mounts cannot mint unauthored grants or invoke getters/setters", () => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "mounts");
  const foreign = [
    {
      secret: "foreign",
      target: "/foreign",
      access: "read-only",
      mode: "0444",
    },
  ];
  let invoked = 0;
  try {
    for (const descriptor of [
      {
        configurable: true,
        get() {
          invoked++;
          return foreign;
        },
        set() {
          invoked++;
        },
      },
      { configurable: true, writable: true, value: foreign },
    ]) {
      Object.defineProperty(Object.prototype, "mounts", descriptor);
      const result = mapped({
        configs: { settings: { file: "./missing" } },
        services: {
          reader: { image: "fixture", configs: ["settings"] },
          ungranted: { image: "fixture" },
        },
      });
      expect(result.report.complete).toBe(true);
      const services = result.candidate?.services;
      expect(services).toMatchObject({
        reader: {
          mounts: [
            {
              config: "settings",
              target: "/settings",
              access: "read-only",
              mode: "0444",
            },
          ],
        },
      });
      if (!(isRecord(services) && isRecord(services.ungranted))) {
        throw new Error("Expected explicit fixture services");
      }
      expect(Object.hasOwn(services.ungranted, "mounts")).toBe(false);
      expect(invoked).toBe(0);
    }
  } finally {
    if (original) {
      Object.defineProperty(Object.prototype, "mounts", original);
    } else {
      Reflect.deleteProperty(Object.prototype, "mounts");
    }
  }
});

test("file declaration publication cannot invoke inherited namespace getters/setters", () => {
  const originals = ["configs", "secrets"].map((field) => ({
    field,
    descriptor: Object.getOwnPropertyDescriptor(Object.prototype, field),
  }));
  let invoked = 0;
  try {
    for (const { field } of originals) {
      Object.defineProperty(Object.prototype, field, {
        configurable: true,
        get() {
          invoked++;
          return { foreign: { file: CANARY } };
        },
        set() {
          invoked++;
        },
      });
    }
    const result = mapped(fixture);
    expect(result.report.complete).toBe(true);
    const candidate = result.candidate;
    if (!isRecord(candidate)) {
      throw new Error("Expected explicit file declarations");
    }
    expect(Object.hasOwn(candidate, "configs")).toBe(true);
    expect(Object.hasOwn(candidate, "secrets")).toBe(true);
    expect(candidate.configs).toMatchObject({
      settings: { file: `.hack/config-${CANARY}` },
    });
    expect(candidate.secrets).toMatchObject({
      token: { file: `secrets-${CANARY}` },
    });
    expect(invoked).toBe(0);
  } finally {
    for (const { field, descriptor } of originals) {
      if (descriptor) {
        Object.defineProperty(Object.prototype, field, descriptor);
      } else {
        Reflect.deleteProperty(Object.prototype, field);
      }
    }
  }
});

test("file-only namespace presence does not create implicit grants, including empty maps/lists", () => {
  const result = mapped({
    configs: {},
    secrets: {},
    services: { reader: { image: "fixture", configs: [], secrets: [] } },
  });
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({ configs: {}, secrets: {} });
  expect(result.candidate).not.toHaveProperty("services.reader.mounts");
  const names = mapped({
    configs: { constructor: { file: "../missing" } },
    services: { constructor: { image: "fixture", configs: ["constructor"] } },
  });
  expect(names.report.complete).toBe(true);
  expect(names.candidate).toMatchObject({
    configs: { constructor: { file: "missing" } },
    services: {
      constructor: {
        mounts: [{ config: "constructor", target: "/constructor" }],
      },
    },
  });
});

test("mode syntax remains authoritative; quoted0444 and numeric292 normalize", () => {
  const source = (mode: string) =>
    `configs:\n  settings:\n    file: ./missing\nservices:\n  reader:\n    image: fixture\n    configs:\n      - source: settings\n        mode: ${mode}\n`;
  refused(
    mapLegacyNativeImport({ configText: CONFIG, composeText: source("0444") }),
    "invalid_or_unsupported_file_grant"
  );
  refused(
    mapLegacyNativeImport({ configText: CONFIG, composeText: source("0o444") }),
    "invalid_syntax"
  );
  const explicit = mapLegacyNativeImport({
    configText: CONFIG,
    composeText: source("292"),
  });
  expect(explicit.report.complete).toBe(true);
  expect(explicit.candidate).toMatchObject({
    services: { reader: { mounts: [{ mode: "0444" }] } },
  });
  const quoted = mapLegacyNativeImport({
    configText: CONFIG,
    composeText: source('"0444"'),
  });
  expect(quoted.report.complete).toBe(true);
  expect(quoted.candidate).toMatchObject({
    services: { reader: { mounts: [{ mode: "0444" }] } },
  });
});

function retainedSource() {
  return JSON.stringify({
    ...fixture,
    name: "fixture",
    volumes: { data: {} },
    services: {
      reader: { ...fixture.services.reader, volumes: ["data:/data"] },
    },
  });
}
test("retained adoption baselines stay closed even though pure preview recognizes file grants", () => {
  const composeText = retainedSource();
  refused(mapLegacyNativeAdoptionBaseline({ configText: CONFIG, composeText }));
  refused(mapLegacyNativeStorageAdoption({ configText: CONFIG, composeText }));
  const planned = planLegacyComposeAdoption({
    configText: CONFIG,
    composeText,
  });
  expect(planned.report.supported).toBe(false);
  expect(planned.intent).toBeUndefined();
  expect(planned.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/configs/settings/file",
      status: "refused",
      code: "unsupported_field",
    })
  );
  expect(JSON.stringify(planned)).not.toContain(CANARY);
});

test("retained file adoption refuses before key/private values/compiler/engine probes", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "import-file-adoption-"))
  );
  const directory = join(root, ".hack");
  await mkdir(directory);
  await writeFile(join(directory, "hack.config.json"), CONFIG);
  await writeFile(join(directory, "docker-compose.yml"), retainedSource());
  await writeFile(join(directory, "hack.env.key"), CANARY, { mode: 0o600 });
  const originalFile = Bun.file;
  const composePath = join(directory, "docker-compose.yml");
  const reads = spyOn(Bun, "file").mockImplementation((path, options) => {
    if (path !== composePath) {
      throw new Error("Private material/key lookup forbidden");
    }
    return originalFile(path, options);
  });
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Compiler/engine forbidden");
  });
  const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
    throw new Error("Compiler/engine forbidden");
  });
  try {
    await expect(
      acquireLegacyComposeAdoptionBinding({
        projectRoot: root,
        binary: join(root, "unavailable"),
      })
    ).rejects.toMatchObject({ code: "E_LEGACY_COMPOSE_BINDING_UNSUPPORTED" });
    expect(reads).toHaveBeenCalled();
    const paths: readonly unknown[] = reads.mock.calls.map(([path]) => path);
    expect(paths.every((path) => path === composePath)).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  } finally {
    reads.mockRestore();
    spawn.mockRestore();
    spawnSync.mockRestore();
    await rm(root, { recursive: true });
  }
});

test.skipIf(!BINARY)(
  "matching compiler validates file-only declarations and explicit grants without acquiring material",
  async () => {
    const result = mapped(fixture);
    expect(result.report.complete).toBe(true);
    const compiled = await compileNativeConfig({
      input: new TextEncoder().encode(JSON.stringify(result.candidate)),
      binary: BINARY,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      throw new Error("Compiled file-grant fixture refused");
    }
    expect(compiled.plan).toMatchObject({
      configs: {
        settings: { file: `.hack/config-${CANARY}` },
        unused: { file: "unused" },
      },
      secrets: { token: { file: `secrets-${CANARY}` } },
      services: {
        reader: {
          mounts: [
            {
              config: "settings",
              target: "/settings",
              access: "read-only",
              mode: "0444",
            },
            {
              secret: "token",
              target: "/run/secrets/token",
              access: "read-only",
              mode: "0444",
            },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  }
);

test.skipIf(!BINARY)(
  "public preview keeps absent file material symbolic and compiler refusals redacted",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "import-file-preview-"))
    );
    const directory = join(root, ".hack");
    await mkdir(directory);
    const composeText = JSON.stringify(fixture);
    await writeFile(join(directory, "hack.config.json"), CONFIG);
    await writeFile(join(directory, "docker-compose.yml"), composeText);
    await writeFile(join(directory, "hack.env.default.yaml"), `${CANARY}: [`);
    await symlink(
      join(root, "absent-private-key"),
      join(directory, "hack.env.key")
    );
    const names = await readdir(directory);
    try {
      const result = await previewNativeConfigImport({
        projectRoot: root,
        binary: BINARY,
      });
      expect(result.report.complete).toBe(true);
      expect(result.candidate).toMatchObject({
        configs: { settings: { file: `.hack/config-${CANARY}` } },
        secrets: { token: { file: `secrets-${CANARY}` } },
      });
      expect(JSON.stringify(result)).not.toContain(CANARY);
      expect(Object.keys(result)).toEqual(["report"]);
      expect(await readFile(join(directory, "hack.config.json"), "utf8")).toBe(
        CONFIG
      );
      expect(
        await readFile(join(directory, "docker-compose.yml"), "utf8")
      ).toBe(composeText);
      expect(await readdir(directory)).toEqual(names);
      await writeFile(
        join(directory, "docker-compose.yml"),
        JSON.stringify({
          configs: fixture.configs,
          services: { reader: { image: "fixture", configs: ["missing"] } },
        })
      );
      const refusedResult = await previewNativeConfigImport({
        projectRoot: root,
        binary: BINARY,
      });
      refused(refusedResult, "candidate_compiler_refused");
      expect(await readdir(directory)).toEqual(names);
    } finally {
      await rm(root, { recursive: true });
    }
  }
);

test.skipIf(!BINARY)(
  "matching compiler preserves converted job file grants and selected build intent without material acquisition",
  async () => {
    const result = mapped(jobFileSource());
    expect(result.report.complete).toBe(true);
    const compiled = await compileNativeConfig({
      input: new TextEncoder().encode(JSON.stringify(result.candidate)),
      profiles: ["later"],
      binary: BINARY,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      throw new Error("Compiled job file-grant fixture refused");
    }
    expect(compiled.plan).toMatchObject({
      jobs: {
        initialize: {
          build: { context: ".", dockerfile: "Dockerfile", target: "prepare" },
          mounts: [
            {
              config: "settings",
              target: "/settings",
              access: "read-only",
              mode: "0444",
            },
            {
              secret: "token",
              target: "/run/secrets/renamed",
              access: "read-only",
              mode: "0444",
            },
          ],
        },
      },
    });
    expect(compiled.plan.services).not.toHaveProperty("initialize");
    expect(JSON.stringify(result)).not.toContain(CANARY);
  }
);

test.skipIf(!BINARY).each([
  {
    configs: { settings: { file: "./missing" } },
    services: { reader: { image: "fixture", configs: ["unknown"] } },
  },
  {
    configs: { settings: { file: "./missing" } },
    secrets: { token: { file: "../missing" } },
    services: {
      reader: {
        image: "fixture",
        configs: [{ source: "settings", target: "/same" }],
        secrets: [{ source: "token", target: "/same" }],
      },
    },
  },
  {
    configs: { settings: { file: "./missing" } },
    services: {
      inactive: { image: "fixture", profiles: ["later"], configs: ["unknown"] },
    },
  },
  {
    configs: { settings: { file: "./missing" } },
    services: {
      inactive: {
        image: "fixture",
        labels: { "hack.service.one-shot": "true" },
        profiles: ["later"],
        configs: ["unknown"],
      },
    },
  },
  {
    configs: { settings: { file: "./missing" } },
    secrets: { token: { file: "./missing" } },
    services: {
      inactive: {
        image: "fixture",
        labels: { "hack.service.one-shot": "true" },
        profiles: ["later"],
        configs: [{ source: "settings", target: "/same" }],
        secrets: [{ source: "token", target: "/same" }],
      },
    },
  },
])(
  "matching compiler remains authoritative for unknown/overlapping grants, including inactive profiles %j",
  async (source) => {
    const result = mapped(source);
    expect(result.report.complete).toBe(true);
    const compiled = await compileNativeConfig({
      input: new TextEncoder().encode(JSON.stringify(result.candidate)),
      binary: BINARY,
    });
    expect(compiled.ok).toBe(false);
  }
);
