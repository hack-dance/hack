import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "../../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "../../../src/lib/guards.ts";
import { openNativeComposeGenerationStore } from "../../../src/lib/native-compose-generation.ts";
import { createMonorepoFixture } from "../fixture.ts";
import {
  type CliResult,
  expect,
  expectExit,
  resolveCliSpawnArgs,
  runCommand,
  type Scenario,
} from "../harness.ts";
import { prepareNativeEngineTripwire } from "../native-engine-tripwire.ts";
import { proxyHasNoPublishedPorts } from "./native-routing-fixture-ingress.ts";

const TIMEOUT = 120_000;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const RESOURCE_ID = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const ENGINE_ID = /^[A-Za-z0-9:-]{1,128}$/;
const BASE_TAG = "oven/bun:1.4.2-slim";
const IMAGE_OWNER = "hack.e2e.native-build.owner";
const IMAGE_PROJECT = "hack.e2e.native-build.project";
const IMAGE_AMBIENT = "hack.e2e.native-build.ambient";
const INSTANCE = "io.hack.native-config.instance";
const OWNER = "io.hack.native-config.owner";
const COMPOSE_PROJECT = "com.docker.compose.project";
const CONTEXT = "build-${NC03_BUILD_AMBIENT}";
const PUBLIC_AMBIENT = "synthetic-host-value-must-not-be-a-build-argument";
const UNSUPPORTED_VALUE = "private-build-refusal-canary";
const INPUT_REFUSAL =
  "Native execution inputs are invalid or changed; prepare a fresh generation. Values omitted.";
const UNSUPPORTED_BUILD_FIELDS = [
  "args",
  "platform",
  "platforms",
  "additional_contexts",
  "cache_from",
  "cache_to",
  "no_cache",
  "pull",
  "network",
  "secrets",
  "ssh",
] as const;
type UnsupportedBuildField = (typeof UNSUPPORTED_BUILD_FIELDS)[number];
type Identity = {
  readonly composeProject: string;
  readonly ownerToken: string;
};
type ResourceKind = "container" | "network" | "volume";

const PROGRAM = [
  'const owner = process.env.FIXTURE_OWNER; const marker = await Bun.file("/build-marker").text();',
  "if (marker !== process.env.EXPECTED_MARKER) process.exit(41);",
  'const path = "/data/retained.json"; if (!(await Bun.file(path).exists())) await Bun.write(path, JSON.stringify({ owner, firstMarker: marker }));',
  "const retained = await Bun.file(path).json(); if (retained.owner !== owner) process.exit(42);",
  'await Bun.write("/data/current.json", JSON.stringify({ owner, marker, retained, argv: process.argv.slice(2) }));',
  'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);',
].join("\n");
const READY =
  'const value = await Bun.file("/data/current.json").json(); if (value.owner !== process.env.FIXTURE_OWNER || value.marker !== process.env.EXPECTED_MARKER) process.exit(43);';
const READ =
  'process.stdout.write(JSON.stringify(await Bun.file("/data/current.json").json()));';

function object(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error("Expected build fixture object; values omitted");
  }
  return value;
}

function data(result: CliResult): Record<string, unknown> {
  const envelope = object(result.stdout);
  expect({
    that: envelope.ok === true && isRecord(envelope.data),
    message: "Native build command must return a successful envelope",
  });
  if (!isRecord(envelope.data)) {
    throw new Error("Native build command data is absent");
  }
  return envelope.data;
}

/** Both the running service and completed job must prove no runtime host publication. */
export function verifyNativeBuildWorkloadState(state: unknown): void {
  expect({
    that:
      isRecord(state) &&
      typeof state.image === "string" &&
      IMAGE_ID.test(state.image) &&
      (state.service === "builder"
        ? state.running === true
        : state.service === "defaultfile" &&
          state.running === false &&
          state.exit === 0) &&
      ["ports", "publishAll", "runtimePorts"].every((field) =>
        Object.hasOwn(state, field)
      ) &&
      proxyHasNoPublishedPorts(state),
    message:
      "Built service/job must have the expected state and no published ports",
  });
}

/** Omitted policy reuses its existing image; explicit build rebuilds changed COPY inputs. */
export function verifyNativeBuildReuse(opts: {
  readonly first: unknown;
  readonly second: unknown;
}): void {
  const { first, second } = opts;
  const complete = (value: unknown): value is Record<string, string> =>
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    ["builder", "defaultfile"].every(
      (name) =>
        Object.hasOwn(value, name) &&
        typeof value[name] === "string" &&
        IMAGE_ID.test(value[name])
    );
  expect({
    that:
      complete(first) &&
      complete(second) &&
      first.defaultfile === second.defaultfile &&
      first.builder !== second.builder &&
      first.builder !== first.defaultfile &&
      second.builder !== second.defaultfile,
    message:
      "Omitted build policy must reuse its image while explicit build must replace changed source inputs",
  });
}

/** A default final stage, lost argv, or reinitialized data must not pass build acceptance. */
export function verifyNativeBuildEvidence(opts: {
  readonly evidence: unknown;
  readonly owner: string;
  readonly marker: string;
  readonly firstMarker: string;
}): void {
  const value = opts.evidence;
  expect({
    that:
      isRecord(value) &&
      value.owner === opts.owner &&
      value.marker === opts.marker &&
      isRecord(value.retained) &&
      value.retained.owner === opts.owner &&
      value.retained.firstMarker === opts.firstMarker &&
      Array.isArray(value.argv) &&
      value.argv.length === 2 &&
      value.argv[0] === "" &&
      value.argv[1] === "${NC03_BUILD_AMBIENT}",
    message:
      "Actual selected build marker, literal argv and retained data must match the fixture",
  });
}

/** Image removal is authorized only by fresh ID, source-owned labels and an exclusive fixture tag namespace. */
export function verifyNativeBuildImage(opts: {
  readonly image: unknown;
  readonly id: string;
  readonly owner: string;
  readonly project: string;
  readonly tags: readonly string[];
  readonly baselineIds: readonly string[];
}): void {
  const image = opts.image;
  expect({
    that:
      IMAGE_ID.test(opts.id) &&
      !opts.baselineIds.includes(opts.id) &&
      isRecord(image) &&
      image.id === opts.id &&
      isRecord(image.labels) &&
      image.labels[IMAGE_OWNER] === opts.owner &&
      image.labels[IMAGE_PROJECT] === opts.project &&
      image.labels[IMAGE_AMBIENT] === "not-inherited" &&
      (image.tags === null ||
        (Array.isArray(image.tags) &&
          image.tags.every(
            (tag) => typeof tag === "string" && opts.tags.includes(tag)
          ))) &&
      (image.digests === null ||
        (Array.isArray(image.digests) &&
          new Set(image.digests).size === image.digests.length &&
          image.digests.every(
            (digest) =>
              typeof digest === "string" &&
              opts.tags.some(
                (tag) =>
                  tag.endsWith(":latest") &&
                  digest === `${tag.slice(0, -":latest".length)}@${opts.id}`
              )
          ))),
    message:
      "Only a new exact source-labeled fixture image with no foreign tags or digests may be removed",
  });
}

/** Read-only absence of a previously admitted superseded image never authorizes removal. */
export function verifySupersededNativeBuildImageAbsent(opts: {
  readonly id: string;
  readonly successor: string;
  readonly capturedIds: readonly string[];
  readonly baselineIds: readonly string[];
  readonly engineId: string;
  readonly before: unknown;
  readonly after: unknown;
}): void {
  const ids = (value: unknown): string[] | null => {
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !== "engineId,ids" ||
      value.engineId !== opts.engineId ||
      !Array.isArray(value.ids) ||
      !value.ids.every((id) => typeof id === "string" && IMAGE_ID.test(id)) ||
      new Set(value.ids).size !== value.ids.length
    ) {
      return null;
    }
    return [...value.ids].sort();
  };
  const before = ids(opts.before);
  const after = ids(opts.after);
  expect({
    that:
      ENGINE_ID.test(opts.engineId) &&
      IMAGE_ID.test(opts.id) &&
      IMAGE_ID.test(opts.successor) &&
      opts.id !== opts.successor &&
      opts.capturedIds.every((id) => IMAGE_ID.test(id)) &&
      opts.baselineIds.every((id) => IMAGE_ID.test(id)) &&
      new Set(opts.capturedIds).size === opts.capturedIds.length &&
      opts.capturedIds.includes(opts.id) &&
      opts.capturedIds.includes(opts.successor) &&
      !opts.baselineIds.includes(opts.id) &&
      !opts.baselineIds.includes(opts.successor) &&
      before !== null &&
      after !== null &&
      JSON.stringify(before) === JSON.stringify(after) &&
      !before.includes(opts.id) &&
      before.includes(opts.successor) &&
      opts.baselineIds.every((id) => before.includes(id)) &&
      before.every(
        (id) => opts.baselineIds.includes(id) || opts.capturedIds.includes(id)
      ),
    message:
      "Only a previously admitted superseded image may be observed absent on the unchanged daemon and inventory",
  });
}

/** Pure diagnostics identify unsupported authored intent separately from redacted execution refusal. */
export function verifyUnsupportedNativeBuild(opts: {
  readonly field: UnsupportedBuildField;
  readonly namespace: "services" | "jobs";
  readonly compilerReport: unknown;
  readonly executionReport: unknown;
}): void {
  const compiler = opts.compilerReport;
  const diagnostic =
    isRecord(compiler) &&
    Array.isArray(compiler.diagnostics) &&
    compiler.diagnostics.length === 1
      ? compiler.diagnostics[0]
      : null;
  expect({
    that:
      isRecord(compiler) &&
      compiler.transport_version === 1 &&
      compiler.ok === false &&
      isRecord(diagnostic) &&
      diagnostic.code === "unknown_field" &&
      diagnostic.document === "project" &&
      diagnostic.pointer ===
        `/${opts.namespace}/unsupported/build/${opts.field}`,
    message: "Compiler must refuse the exact unsupported build requirement",
  });
  const execution = opts.executionReport;
  expect({
    that:
      isRecord(execution) &&
      execution.ok === false &&
      isRecord(execution.error) &&
      execution.error.code === "E_CONFIG_INVALID" &&
      execution.error.message === INPUT_REFUSAL,
    message: "Build execution must return the fixed redacted input refusal",
  });
}

export function nativeBuildProject(opts: {
  readonly name: string;
  readonly owner: string;
  readonly marker: string;
}): Project {
  return {
    schema_version: 1,
    name: opts.name,
    profiles: ["exercise", "inactive"],
    storage: { data: { kind: "persistent", scope: "worktree" } },
    services: {
      builder: {
        build: {
          context: CONTEXT,
          dockerfile: "docker/Dockerfile",
          target: "selected",
        },
        pull_policy: "build",
        profiles: ["exercise"],
        init: true,
        entrypoint: { exec: [] },
        command: { exec: ["bun", "/probe.js", "", "${NC03_BUILD_AMBIENT}"] },
        environment: {
          FIXTURE_OWNER: { literal: opts.owner },
          EXPECTED_MARKER: { literal: opts.marker },
        },
        mounts: [{ storage: "data", target: "/data", access: "read-write" }],
        depends_on: [{ job: "defaultfile", condition: "completed" }],
        readiness: {
          kind: "exec",
          command: { exec: ["bun", "-e", READY] },
          interval: "1s",
          timeout: "5s",
          retries: 30,
        },
      },
    },
    jobs: {
      defaultfile: {
        build: { context: "default-context" },
        profiles: ["exercise"],
        entrypoint: { exec: [] },
        command: {
          exec: [
            "bun",
            "-e",
            'if (await Bun.file("/build-marker").text() !== "default-file") process.exit(44);',
          ],
        },
      },
    },
  };
}

async function refusalControls(opts: {
  readonly root: string;
  readonly source: string;
  readonly project: Project;
  readonly invoke: (
    args: readonly string[],
    env: Readonly<Record<string, string>>
  ) => Promise<CliResult>;
}): Promise<void> {
  const baseline = await opts.invoke(
    ["--profile", "exercise", "config", "validate", "--json"],
    {}
  );
  expectExit({
    result: baseline,
    codes: [0],
    message: "Supported native build must validate before refusal controls",
  });
  expect({
    that: object(baseline.stdout).ok === true,
    message: "Supported native build declarations must compile",
  });
  const tripwire = join(opts.root, "tripwire");
  await mkdir(tripwire);
  const engineCalled = await prepareNativeEngineTripwire({
    directory: tripwire,
  });
  const hookCalled = join(tripwire, "hook-called");
  for (const field of UNSUPPORTED_BUILD_FIELDS) {
    for (const namespace of ["services", "jobs"] as const) {
      const invalid: unknown = {
        ...opts.project,
        host: {
          up: {
            before: [
              {
                name: "must-not-run",
                command: {
                  exec: [
                    process.execPath,
                    "-e",
                    `await Bun.write(${JSON.stringify(hookCalled)}, "called")`,
                  ],
                },
              },
            ],
          },
        },
        [namespace]: {
          ...opts.project[namespace],
          unsupported: {
            build: {
              context: ".",
              [field]: { value: UNSUPPORTED_VALUE },
            },
            ...(namespace === "jobs" ? { profiles: ["inactive"] } : {}),
          },
        },
      };
      await Bun.write(opts.source, JSON.stringify(invalid));
      const env = {
        PATH: `${tripwire}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      };
      const validation = await opts.invoke(
        ["--profile", "exercise", "config", "validate", "--json"],
        env
      );
      const execution = await opts.invoke(
        ["--profile", "exercise", "up", "--detach", "--json"],
        env
      );
      expect({
        that: [validation, execution].every(
          (result) =>
            result.exitCode !== 0 &&
            !result.timedOut &&
            !result.combined.includes(UNSUPPORTED_VALUE)
        ),
        message: "Unsupported active/inactive build intent must refuse safely",
      });
      verifyUnsupportedNativeBuild({
        field,
        namespace,
        compilerReport: object(validation.stdout),
        executionReport: object(execution.stdout),
      });
      expect({
        that: !(
          (await Bun.file(engineCalled).exists()) ||
          (await Bun.file(hookCalled).exists())
        ),
        message: "Unsupported build intent must refuse before hooks or Docker",
      });
    }
  }
}

/** Actual cached multistage builds without ports, routing, package installs or secret build arguments. */
export const nativeConfigBuildScenario: Scenario = {
  name: "native-config-build",
  tier: "docker",
  summary:
    "native build context/Dockerfile/target/policy, retained data and advanced-option refusal",
  run: async (ctx) => {
    expect({
      that: resolveCliSpawnArgs([]).length === 1,
      message:
        "Build acceptance requires the current compiled CLI and compiler",
    });
    const started = performance.now();
    const stage = (message: string): void =>
      ctx.log(
        `${message} (elapsed ${Math.round(performance.now() - started)}ms)`
      );
    const docker = async (args: readonly string[]): Promise<string> => {
      const result = await runCommand({
        argv: ["docker", ...args],
        cwd: ctx.tempRoot,
        timeoutMs: TIMEOUT,
      });
      expectExit({
        result,
        codes: [0],
        message: "Fixture Docker command must succeed",
      });
      return result.stdout.trim();
    };
    expect({
      that:
        (await docker(["info", "--format", "{{.OSType}}"])).trim() === "linux",
      message: "Native build fixture requires a Linux Docker daemon",
    });
    const baseId = await docker([
      "image",
      "inspect",
      BASE_TAG,
      "--format",
      "{{.Id}}",
    ]);
    expect({
      that: IMAGE_ID.test(baseId),
      message: "Bun base must already be cached; fixture never invokes pull",
    });
    const engineId: unknown = JSON.parse(
      await docker(["info", "--format", "{{json .ID}}"])
    );
    if (typeof engineId !== "string" || !ENGINE_ID.test(engineId)) {
      throw new Error("Pinned build fixture daemon identity is absent");
    }
    const baselineIds = [
      ...new Set(
        (await docker(["image", "ls", "-aq", "--no-trunc"]))
          .split(/\s+/)
          .filter(Boolean)
      ),
    ];
    const cacheBefore = await docker([
      "system",
      "df",
      "--format",
      "{{json .}}",
    ]);
    expect({
      that: cacheBefore.length < 16_384,
      message: "Before-build cache summary must be bounded",
    });
    const created = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: false,
    });
    const root = await realpath(created.root);
    const owner = crypto.randomUUID().replaceAll("-", "");
    const hackDir = join(root, ".hack");
    await mkdir(hackDir);
    const context = join(root, CONTEXT);
    const defaultContext = join(root, "default-context");
    await mkdir(join(context, "docker"), { recursive: true });
    await mkdir(defaultContext);
    const labels = [
      `LABEL ${IMAGE_OWNER}="${owner}" ${IMAGE_PROJECT}="${created.name}"`,
      "ARG NC03_BUILD_AMBIENT=not-inherited",
      `LABEL ${IMAGE_AMBIENT}="$NC03_BUILD_AMBIENT"`,
    ];
    const dockerfile = [
      `FROM ${BASE_TAG} AS base`,
      ...labels,
      "COPY probe.js /probe.js",
      "FROM base AS selected",
      "COPY selected-marker /build-marker",
      "FROM base AS deliberately-wrong-final-stage",
      "COPY wrong-marker /build-marker",
      "",
    ].join("\n");
    const defaultfile = [
      `FROM ${BASE_TAG}`,
      ...labels,
      "COPY default-marker /build-marker",
      "",
    ].join("\n");
    const dockerfilePath = join(context, "docker/Dockerfile");
    const defaultfilePath = join(defaultContext, "Dockerfile");
    await Bun.write(dockerfilePath, dockerfile);
    await Bun.write(defaultfilePath, defaultfile);
    await Bun.write(join(context, "probe.js"), PROGRAM);
    await Bun.write(join(context, "wrong-marker"), "wrong-final-stage");
    await Bun.write(join(defaultContext, "default-marker"), "default-file");
    const source = join(hackDir, "hack.project.json");
    const writeProject = async (marker: string): Promise<Project> => {
      const project = nativeBuildProject({ name: created.name, owner, marker });
      await Bun.write(source, JSON.stringify(project));
      await Bun.write(join(context, "selected-marker"), marker);
      return project;
    };
    const initial = `${owner}-first`;
    const updated = `${owner}-updated`;
    const project = await writeProject(initial);
    const assertSource = async (): Promise<void> => {
      expect({
        that:
          (await Bun.file(dockerfilePath).text()) === dockerfile &&
          (await Bun.file(defaultfilePath).text()) === defaultfile &&
          !(await Bun.file(join(hackDir, "hack.config.json")).exists()) &&
          !(await Bun.file(join(hackDir, "docker-compose.yml")).exists()),
        message:
          "Native-only build and source Dockerfile fences must be intact",
      });
    };
    const raw = (
      args: readonly string[],
      env: Readonly<Record<string, string>> = {}
    ): Promise<CliResult> =>
      ctx.cli({
        args,
        cwd: root,
        timeoutMs: TIMEOUT,
        env: {
          HACK_RUNTIME_BACKEND: "compose",
          HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
          NC03_BUILD_AMBIENT: PUBLIC_AMBIENT,
          ...env,
        },
      });
    const cli = async (args: readonly string[]): Promise<CliResult> => {
      const result = await raw(args);
      expectExit({
        result,
        codes: [0],
        message: `Native ${args[0]} must succeed`,
      });
      expect({
        that: !result.combined.includes(PUBLIC_AMBIENT),
        message:
          "Host ambient canary must not enter authored build/argv output",
      });
      return result;
    };
    await refusalControls({ root, source, project, invoke: raw });
    await writeProject(initial);
    stage("unsupported build fields refused before hooks/engine access");
    let identity: Identity | null = null;
    const capturedImages = new Set<string>();
    const supersededImages = new Map<string, string>();
    const saveRecovery = async (): Promise<void> => {
      await Bun.write(
        join(ctx.tempRoot, "build-recovery.json"),
        JSON.stringify(
          {
            root,
            owner,
            identity,
            capturedImages: [...capturedImages],
            supersededImages: [...supersededImages],
            engineId,
            baselineIds,
            baseTag: BASE_TAG,
            baseId,
            dockerfileHash: createHash("sha256")
              .update(dockerfile)
              .digest("hex"),
            defaultfileHash: createHash("sha256")
              .update(defaultfile)
              .digest("hex"),
          },
          null,
          2
        )
      );
    };
    const readIdentity = async (): Promise<Identity> => {
      const store = await openNativeComposeGenerationStore({
        projectRoot: root,
        instance: null,
        mode: "saved",
      });
      try {
        identity = {
          composeProject: store.identity.composeProject,
          ownerToken: store.identity.ownerToken,
        };
        return identity;
      } finally {
        await store.close();
      }
    };
    const currentOwner = (): Identity => {
      if (!(identity && TOKEN.test(identity.ownerToken))) {
        throw new Error("Verified native build ownership is absent");
      }
      return identity;
    };
    const list = async (kind: ResourceKind): Promise<string[]> => {
      const selected = currentOwner();
      return (
        await docker([
          ...(kind === "container"
            ? ["ps", "-aq", "--no-trunc"]
            : [
                kind,
                "ls",
                "-q",
                ...(kind === "network" ? ["--no-trunc"] : []),
              ]),
          "--filter",
          `label=${OWNER}=${selected.ownerToken}`,
          "--filter",
          `label=${INSTANCE}=${selected.composeProject}`,
          "--filter",
          `label=${COMPOSE_PROJECT}=${selected.composeProject}`,
        ])
      )
        .split(/\s+/)
        .filter(Boolean);
    };
    const resourceOwned = async (
      kind: ResourceKind,
      id: string
    ): Promise<void> => {
      const labels = object(
        await docker([
          kind,
          "inspect",
          id,
          "--format",
          kind === "container" ? "{{json .Config.Labels}}" : "{{json .Labels}}",
        ])
      );
      const expected = currentOwner();
      expect({
        that:
          labels[OWNER] === expected.ownerToken &&
          labels[INSTANCE] === expected.composeProject &&
          labels[COMPOSE_PROJECT] === expected.composeProject &&
          labels["io.hack.native-config.version"] === "1",
        message:
          "Every build fixture resource must match the exact native owner",
      });
    };
    const inspectImage = async (id: string): Promise<Record<string, unknown>> =>
      object(
        await docker([
          "image",
          "inspect",
          id,
          "--format",
          '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"tags":{{json .RepoTags}},"digests":{{json .RepoDigests}}}',
        ])
      );
    const imageOwned = async (id: string): Promise<Record<string, unknown>> => {
      await assertSource();
      const image = await inspectImage(id);
      verifyNativeBuildImage({
        image,
        id,
        owner,
        project: created.name,
        baselineIds,
        tags: [
          `${currentOwner().composeProject}-builder:latest`,
          `${currentOwner().composeProject}-defaultfile:latest`,
        ],
      });
      return image;
    };
    const captureImages = async (): Promise<void> => {
      const ids = (
        await docker([
          "image",
          "ls",
          "-aq",
          "--no-trunc",
          "--filter",
          `label=${IMAGE_OWNER}=${owner}`,
        ])
      )
        .split(/\s+/)
        .filter(Boolean);
      for (const id of new Set(ids)) {
        await imageOwned(id);
        capturedImages.add(id);
      }
    };
    const verifyWorkloads = async (): Promise<{
      readonly builder: string;
      readonly defaultfile: string;
    }> => {
      const ids = await list("container");
      const images: Record<string, string> = {};
      expect({
        that: ids.length === 2,
        message:
          "Selected build service and completed default-Dockerfile job must exist",
      });
      for (const id of ids) {
        expect({
          that: RESOURCE_ID.test(id),
          message: "Build workload ID must be complete",
        });
        await resourceOwned("container", id);
        const state = object(
          await docker([
            "inspect",
            id,
            "--format",
            '{"service":{{json (index .Config.Labels "com.docker.compose.service")}},"image":{{json .Image}},"running":{{json .State.Running}},"exit":{{json .State.ExitCode}},"ports":{{json .HostConfig.PortBindings}},"publishAll":{{json .HostConfig.PublishAllPorts}},"runtimePorts":{{json .NetworkSettings.Ports}}}',
          ])
        );
        verifyNativeBuildWorkloadState(state);
        if (typeof state.image !== "string") {
          throw new Error("Built image is absent");
        }
        const image = await imageOwned(state.image);
        const tag = `${currentOwner().composeProject}-${state.service}:latest`;
        expect({
          that: Array.isArray(image.tags) && image.tags.includes(tag),
          message:
            "Each built workload must use its exact generated Compose image tag",
        });
        capturedImages.add(state.image);
        images[String(state.service)] = state.image;
      }
      if (
        typeof images.builder !== "string" ||
        typeof images.defaultfile !== "string"
      ) {
        throw new Error(
          "Distinct builder and completed-job image facts missing"
        );
      }
      return { builder: images.builder, defaultfile: images.defaultfile };
    };
    const readEvidence = async (marker: string): Promise<unknown> => {
      const result = await cli(["exec", "builder", "--", "bun", "-e", READ]);
      const evidence: unknown = JSON.parse(result.stdout);
      verifyNativeBuildEvidence({
        evidence,
        owner,
        marker,
        firstMarker: initial,
      });
      return evidence;
    };
    const inventory = async () => {
      const observedEngine: unknown = JSON.parse(
        await docker(["info", "--format", "{{json .ID}}"])
      );
      const ids = [
        ...new Set(
          (await docker(["image", "ls", "-aq", "--no-trunc"]))
            .split(/\s+/)
            .filter(Boolean)
        ),
      ];
      const afterEngine: unknown = JSON.parse(
        await docker(["info", "--format", "{{json .ID}}"])
      );
      expect({
        that: observedEngine === engineId && afterEngine === engineId,
        message: "Image inventory must stay on the pinned fixture daemon",
      });
      return { engineId: observedEngine, ids };
    };
    const retireImage = async (id: string): Promise<void> => {
      const before = await inventory();
      if (!before.ids.includes(id)) {
        const successor = supersededImages.get(id);
        if (!successor) {
          throw new Error("A current admitted build image is missing");
        }
        const replacement = await imageOwned(successor);
        expect({
          that:
            Array.isArray(replacement.tags) &&
            replacement.tags.includes(
              `${currentOwner().composeProject}-builder:latest`
            ),
          message: "Superseded image must retain its exact tagged replacement",
        });
        verifySupersededNativeBuildImageAbsent({
          id,
          successor,
          capturedIds: [...capturedImages],
          baselineIds,
          engineId,
          before,
          after: await inventory(),
        });
        return;
      }
      await imageOwned(id);
      await docker(["image", "rm", "--no-prune", id]);
    };
    const cleanup = async (): Promise<void> => {
      await assertSource();
      if (
        !identity &&
        (await Bun.file(
          join(hackDir, ".internal/native-compose/.gitignore")
        ).exists())
      ) {
        await readIdentity();
      }
      if (identity) {
        await cli(["down", "--recover", "--json"]);
        expect({
          that: (await list("container")).length === 0,
          message:
            "Owned native stop must remove every build workload before image cleanup",
        });
        for (const kind of ["network", "volume"] as const) {
          for (const id of await list(kind)) {
            await resourceOwned(kind, id);
            await docker([kind, "rm", id]);
          }
          expect({
            that: (await list(kind)).length === 0,
            message: "Exact build fixture resources must be reclaimed",
          });
        }
        await captureImages();
        for (const id of capturedImages) {
          await retireImage(id);
        }
      }
      const remaining = await docker([
        "image",
        "ls",
        "-aq",
        "--no-trunc",
        "--filter",
        `label=${IMAGE_OWNER}=${owner}`,
      ]);
      expect({
        that: remaining === "",
        message: "No owned built image may remain after exact cleanup",
      });
      expect({
        that:
          (await docker([
            "image",
            "inspect",
            BASE_TAG,
            "--format",
            "{{.Id}}",
          ])) === baseId,
        message: "Cached base image/tag must be unchanged",
      });
      const afterIds = new Set(
        (await docker(["image", "ls", "-aq", "--no-trunc"]))
          .split(/\s+/)
          .filter(Boolean)
      );
      expect({
        that: baselineIds.every((id) => afterIds.has(id)),
        message: "Every preexisting image must remain present",
      });
    };
    let failure: unknown;
    let failed = false;
    await saveRecovery();
    try {
      await assertSource();
      data(await cli(["--profile", "exercise", "up", "--detach", "--json"]));
      await readIdentity();
      await saveRecovery();
      const firstImages = await verifyWorkloads();
      const first = await readEvidence(initial);
      await Bun.write(
        join(ctx.tempRoot, "build-startup-proof.json"),
        JSON.stringify(
          {
            owner,
            identity,
            first,
            firstImages,
            imageIds: [...capturedImages],
          },
          null,
          2
        )
      );
      await cli(["down", "--json"]);
      await writeProject(updated);
      // Rebuilding this omitted-policy job would now fail its real command.
      await Bun.write(
        join(defaultContext, "default-marker"),
        "cache-must-not-rebuild"
      );
      data(await cli(["--profile", "exercise", "up", "--detach", "--json"]));
      const secondImages = await verifyWorkloads();
      verifyNativeBuildReuse({ first: firstImages, second: secondImages });
      supersededImages.set(firstImages.builder, secondImages.builder);
      const second = await readEvidence(updated);
      await captureImages();
      await saveRecovery();
      const cacheAfter = await docker([
        "system",
        "df",
        "--format",
        "{{json .}}",
      ]);
      expect({
        that: cacheAfter.length < 16_384,
        message: "After-build cache summary must be bounded",
      });
      await Bun.write(
        join(ctx.tempRoot, "build-proof.json"),
        JSON.stringify(
          {
            owner,
            identity,
            baseTag: BASE_TAG,
            baseId,
            first,
            second,
            firstImages,
            secondImages,
            omittedPolicyReuseVerified: true,
            explicitBuildRebuildVerified: true,
            imageIds: [...capturedImages],
            cacheBefore,
            cacheAfter,
            cacheRetained: true,
            cacheReclamationQualified: false,
            dockerfileHash: createHash("sha256")
              .update(dockerfile)
              .digest("hex"),
            defaultfileHash: createHash("sha256")
              .update(defaultfile)
              .digest("hex"),
          },
          null,
          2
        )
      );
      stage(
        "actual selected/default Dockerfile builds, policy reuse/rebuild, argv and retained data verified"
      );
    } catch (error: unknown) {
      failed = true;
      failure = error;
    }
    try {
      await cleanup();
    } catch (error: unknown) {
      ctx.retainFixtures(
        "Native build fixture cleanup is incomplete; exact recovery identities are preserved"
      );
      try {
        await saveRecovery();
      } catch {
        ctx.log(
          "Recovery receipt update failed; both private roots and the original receipt are retained"
        );
      }
      if (!failed) {
        throw error;
      }
    }
    if (failed) {
      throw failure;
    }
    stage(
      "exact resources/images removed; base/foreign images preserved; ordinary builder cache retained"
    );
  },
};
