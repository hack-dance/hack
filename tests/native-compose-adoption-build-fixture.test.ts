import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLegacyComposeBuildSource } from "../src/lib/native-compose-adoption-build.ts";
import { acquireLegacyAdoptionSourceInputs } from "../src/lib/native-config-import-inputs.ts";
import { runCommand } from "./e2e/harness.ts";
import {
  assertRetainedBuildFixtureCopy,
  assertRetainedFixtureImageUnchanged,
  prepareRetainedBuildFixtureSources,
  RETAINED_BUILD_OBJECT_FORMAT,
  retainedBuildFixtureCopiedFiles,
  retainedBuildFixtureDefinition,
  retainedBuildFixtureImage,
  retainedBuildFixtureObjectGraph,
  retainedBuildFixtureMutationAllowed,
  retainedBuildFixtureReadAllowed,
  retainedBuildFixtureSourceSnapshot,
} from "./e2e/scenarios/native-compose-adoption-build-inputs.ts";
import { captureAdoptionDependencyFirstPrepare } from "./e2e/scenarios/native-compose-adoption-dependency-staged-read.ts";
import {
  buildFixtureCli,
  cleanupRetainedBuildFixtureImages,
  nativeComposeAdoptionBuildWorktreesScenario,
} from "./e2e/scenarios/native-compose-adoption-worktrees.ts";
import { retainedBuildFixture } from "./helpers/retained-build-adoption.ts";

const CANARY = "synthetic-private-builder-canary";
const id = "a".repeat(64),
  other = "b".repeat(64),
  image = `sha256:${"c".repeat(64)}`;
const birth = "2026-10-08T20:00:00.123456789Z";
const scope = {
  projectRoot: "/owned/root",
  project: "fixture",
  containerIds: [id, other],
  networkId: "d".repeat(64),
  volumeName: "fixture_data",
  images: [{ id: image, reference: "fixture-db" }],
};
const prefix = [
  "compose",
  "--project-name",
  "fixture",
  "--project-directory",
  "/owned/root/.hack",
  "--env-file",
  "/dev/null",
  "--profile",
  "*",
  "--file",
];
const anchor = {
  id: "e".repeat(32),
  manifest: { dev: 1, ino: 2, hash: "f".repeat(64) },
};
const receipt = {
  adoption_receipt_version: 9,
  prepared: anchor,
  publication: null,
  pendingOperation: {
    generation: anchor,
    operation: "stop",
    services: ["db", "worker"],
  },
};
const imageRow = {
  id: image,
  created: birth,
  owner: "fixture",
  stage: "retained",
  tags: ["fixture-db:latest"],
  digests: null,
};

test("retained build acceptance is explicit and failure-preserving", () => {
  expect(nativeComposeAdoptionBuildWorktreesScenario).toMatchObject({
    tier: "docker",
    requiresExplicitSelection: true,
    preserveFixtureOnFailure: true,
  });
});
for (const mode of ["root-specific", "hack-default"] as const) {
  test(`real ${mode} fixture authoring issues a qualified current source with explicit COPY oracle`, async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "retained-build-fixture-source-"))
    );
    try {
      await mkdir(join(root, ".git"));
      await mkdir(join(root, ".hack"));
      await prepareRetainedBuildFixtureSources({ root, name: "fixture", mode });
      const configText = '{"name":"fixture"}';
      const composeText = JSON.stringify({
        name: "fixture",
        services: {
          db: {
            build: retainedBuildFixtureDefinition(mode),
            volumes: ["data:/data"],
          },
        },
        volumes: { data: {} },
      });
      await writeFile(join(root, ".hack/hack.config.json"), configText);
      await writeFile(join(root, ".hack/docker-compose.yml"), composeText);
      const inputs = await acquireLegacyAdoptionSourceInputs({
        projectRoot: root,
      });
      if (!inputs.ok) {
        throw new Error(
          "Synthetic fixture source acquisition refused; values omitted."
        );
      }
      const captured = await acquireLegacyComposeBuildSource({
        source: inputs,
      });
      expect(captured.candidate).toMatchObject({
        services: {
          db: {
            build:
              mode === "root-specific"
                ? {
                    context: ".",
                    dockerfile: ".hack/toolchain/Dockerfile",
                    target: "retained",
                  }
                : { context: ".hack" },
          },
        },
      });
      const context = captured.proof.contexts[0];
      expect(context).toBeDefined();
      const files = context?.nodes
        .filter((node) => node.kind === "file")
        .map((node) => ({
          path: node.path,
          hash: node.kind === "file" ? node.hash : "",
        }));
      expect(files).toEqual(retainedBuildFixtureCopiedFiles(mode));
      const copy = retainedBuildFixtureCopiedFiles(mode)
        .map((row) => `${row.path} ${row.hash}`)
        .join("\n");
      expect(() =>
        assertRetainedBuildFixtureCopy({ mode, text: copy })
      ).not.toThrow();
      expect(() =>
        assertRetainedBuildFixtureCopy({
          mode,
          text: `${copy}\n.hack/.internal/private ${"a".repeat(64)}`,
        })
      ).toThrow("values omitted");
      expect(() => assertRetainedBuildFixtureCopy({ mode, text: "" })).toThrow(
        "values omitted"
      );
      const source = await retainedBuildFixtureSourceSnapshot({ root, mode });
      await captured.assertFresh();
      expect(await retainedBuildFixtureSourceSnapshot({ root, mode })).toBe(
        source
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
for (const mode of ["root-specific", "hack-default"] as const) {
  test(`actual ${mode} preview transport refuses an injected build before forwarding`, async () => {
    const outer = await realpath(
      await mkdtemp(join(tmpdir(), "retained-build-preview-transport-"))
    );
    const root = join(outer, "checkout");
    const engine = join(outer, "synthetic-engine");
    const forwarded = join(outer, "engine-forwarded");
    const previewArgs = ["config", "adopt", "--dry-run", "--stop", "--json"];
    const instance = {
      root,
      name: "fixture",
      marker: "synthetic-sql-marker",
      basicBuild: mode,
    };
    try {
      await chmod(outer, 0o700);
      await mkdir(root, { mode: 0o700 });
      await mkdir(join(root, ".hack"), { mode: 0o700 });
      await writeFile(
        join(root, ".hack/docker-compose.yml"),
        JSON.stringify({
          services: { db: { build: retainedBuildFixtureDefinition(mode) } },
        }),
        { mode: 0o600 }
      );
      await writeFile(
        engine,
        `#!${process.execPath}\nawait Bun.write(${JSON.stringify(forwarded)},'unexpected-forwarding');process.exit(0);\n`,
        { mode: 0o700 }
      );
      let invocations = 0;
      const cli: Parameters<typeof buildFixtureCli>[0]["cli"] = async (
        selected,
        args,
        extra
      ) => {
        invocations += 1;
        expect(selected).toBe(instance);
        expect(args).toEqual(previewArgs);
        return await runCommand({
          argv: ["docker", "compose", "build", "db"],
          cwd: root,
          env: extra,
          timeoutMs: 5000,
        });
      };
      const result = await buildFixtureCli(
        {
          ctx: { tempRoot: outer },
          engine,
          engineId: "synthetic-daemon",
          baseImage: `sha256:${"1".repeat(64)}`,
          anchors: new Map([
            [
              instance,
              {
                source: "synthetic-original-source",
                resources: {
                  container: [
                    { id, service: "db" },
                    { id: other, service: "worker" },
                  ],
                  network: [{ id: scope.networkId }],
                  volume: [{ id: scope.volumeName }],
                },
              },
            ],
          ]),
          builtImages: new Map([
            [
              instance,
              retainedBuildFixtureImage({
                value: imageRow,
                reference: "fixture-db",
                owner: "fixture",
                originalImageIds: [],
              }),
            ],
          ]),
          cli,
        },
        instance,
        previewArgs
      );
      expect(invocations).toBe(1);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(93);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "retained-build-refused stage=read-admission code=93\n"
      );
      expect(await Bun.file(forwarded).exists()).toBe(false);
      expect(
        await Bun.file(
          join(root, ".hack/.internal/legacy-compose-adoption-v1/receipt.json")
        ).exists()
      ).toBe(false);
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });
}
test("image fixture capture requires a new sole-tag selected-stage image and pins birth", () => {
  const captured = retainedBuildFixtureImage({
    value: imageRow,
    reference: "fixture-db",
    owner: "fixture",
    originalImageIds: [],
  });
  expect(captured).toMatchObject({
    id: image,
    created: birth,
    tag: "fixture-db:latest",
  });
  expect(() =>
    assertRetainedFixtureImageUnchanged({
      captured,
      current: { ...captured, created: "2026-10-08T21:00:00Z" },
    })
  ).toThrow("values omitted");
  for (const row of [
    { ...imageRow, owner: CANARY },
    { ...imageRow, stage: "wrong" },
    { ...imageRow, tags: ["fixture-db:latest", "foreign:latest"] },
    { ...imageRow, digests: [CANARY] },
    { ...imageRow, created: CANARY },
  ]) {
    expect(() =>
      retainedBuildFixtureImage({
        value: row,
        reference: "fixture-db",
        owner: "fixture",
        originalImageIds: [],
      })
    ).toThrow("values omitted");
  }
  expect(() =>
    retainedBuildFixtureImage({
      value: imageRow,
      reference: "fixture-db",
      owner: "fixture",
      originalImageIds: [image],
    })
  ).toThrow("values omitted");
});
test("fixture image capture pins the exact observed same-ID repository digest", () => {
  const digest = `fixture-db@${image}`;
  const captured = retainedBuildFixtureImage({
    value: { ...imageRow, digests: [digest] },
    reference: "fixture-db",
    owner: "fixture",
    originalImageIds: [],
  });
  expect(captured.digests).toEqual([digest]);
  expect(Object.isFrozen(captured.digests)).toBe(true);
  expect(() =>
    assertRetainedFixtureImageUnchanged({
      captured,
      current: { ...captured, digests: null },
    })
  ).toThrow("values omitted");
  for (const digests of [
    [CANARY],
    [`other-db@${image}`],
    [`fixture-db@sha256:${"d".repeat(64)}`],
    [digest, digest],
    [digest, CANARY],
  ]) {
    expect(() =>
      retainedBuildFixtureImage({
        value: { ...imageRow, digests },
        reference: "fixture-db",
        owner: "fixture",
        originalImageIds: [],
      })
    ).toThrow("values omitted");
  }
});

const baseBuildImage = `sha256:${"1".repeat(64)}`;
const firstBuildParent = `sha256:${"2".repeat(64)}`;
const secondBuildParent = `sha256:${"3".repeat(64)}`;
function capturedBuildGraph() {
  const selected = retainedBuildFixtureImage({
    value: { ...imageRow, digests: [`fixture-db@${image}`] },
    reference: "fixture-db",
    owner: "fixture",
    originalImageIds: [baseBuildImage],
  });
  const labels = [
    "hack.e2e.retained-build.owner",
    "hack.e2e.retained-build.stage",
  ];
  const values = [
    {
      ...imageRow,
      parent: secondBuildParent,
      size: 1000,
      digests: [`fixture-db@${image}`],
      labelNames: [...labels, "com.docker.compose.image.builder"],
    },
    {
      ...imageRow,
      id: firstBuildParent,
      parent: baseBuildImage,
      size: 800,
      tags: [],
      digests: [],
      labelNames: labels,
    },
    {
      ...imageRow,
      id: secondBuildParent,
      parent: firstBuildParent,
      size: 900,
      tags: [],
      digests: [],
      labelNames: labels,
    },
  ] as const;
  const capture = (
    rows: readonly unknown[] = values,
    originals = [baseBuildImage]
  ) =>
    retainedBuildFixtureObjectGraph({
      values: rows,
      selected,
      originalImageIds: originals,
      baseImage: baseBuildImage,
    });
  return { selected, values, capture };
}
test("explicit builder graph captures only the owned child-to-base chain", () => {
  const { capture, values } = capturedBuildGraph();
  const graph = capture();
  expect(graph.map((row) => row.id)).toEqual([
    image,
    secondBuildParent,
    firstBuildParent,
  ]);
  expect(Object.isFrozen(graph)).toBe(true);
  expect(Object.isFrozen(graph[0]?.labelNames)).toBe(true);
  expect(capture([{ ...values[0], parent: "" }]).map((row) => row.id)).toEqual([
    image,
  ]);
  for (const rows of [
    [values[0], values[1]],
    [values[0], values[1], { ...values[2], owner: CANARY }],
    [values[0], values[1], { ...values[2], parent: image }],
    [values[0], { ...values[1], tags: ["foreign:latest"] }, values[2]],
    [...values, { ...values[1], id: `sha256:${"4".repeat(64)}` }],
    [
      { ...values[0], labelNames: [...values[0].labelNames, CANARY] },
      values[1],
      values[2],
    ],
    [{ ...values[0], parent: "" }, values[1], values[2]],
  ])
    expect(() => capture(rows)).toThrow("values omitted");
  expect(() => capture(values, [baseBuildImage, firstBuildParent])).toThrow(
    "values omitted"
  );
});

function buildCleanupModel() {
  const { selected, values, capture } = capturedBuildGraph();
  const objects = capture();
  const instance = {
    root: "/owned/fixture",
    name: "fixture",
    marker: "sql-marker",
  };
  const remaining = new Set(objects.map((row) => row.id));
  const refs = new Set<string>();
  const events: { stage: string; id?: string }[] = [];
  let daemon = '"fixture-engine"';
  let afterJournal: (() => void) | undefined;
  let afterEffect: (() => void) | undefined;
  const current = new Map(values.map((row) => [row.id, row]));
  const opts = {
    engineId: daemon,
    originalImageIds: [baseBuildImage],
    baseImage: baseBuildImage,
    builtImages: new Map([[instance, selected]]),
    builtImageObjects: new Map([[instance, objects]]),
    probe: async (args: readonly string[]) => {
      if (args.join() === "info,--format,{{json .ID}}") return daemon;
      if (args.join() === "image,ls,--all,--no-trunc,--format,{{.ID}}")
        return [baseBuildImage, ...remaining].sort().join("\n");
      if (
        args[0] === "image" &&
        args[1] === "inspect" &&
        args[3] === "{{.Id}}" &&
        args[4] === "postgres:17.6-alpine"
      )
        return baseBuildImage;
      if (
        args[0] === "image" &&
        args[1] === "inspect" &&
        args[2] === "--format" &&
        args[3] === RETAINED_BUILD_OBJECT_FORMAT &&
        args.length === 5 &&
        args[4] &&
        remaining.has(args[4])
      )
        return JSON.stringify(current.get(args[4]));
      if (
        args[0] === "container" &&
        args[1] === "ls" &&
        args[2] === "--all" &&
        args[3] === "--no-trunc" &&
        args[4] === "--filter" &&
        args[5]?.startsWith("ancestor=") &&
        args[6] === "--format" &&
        args[7] === "{{.ID}}" &&
        args.length === 8
      )
        return refs.has(args[5].slice(9)) ? id : "";
      throw new Error("Unexpected fixed fixture read");
    },
    journal: async (value: unknown) => {
      if (
        !(
          value &&
          typeof value === "object" &&
          "stage" in value &&
          typeof value.stage === "string"
        )
      )
        throw new Error("Missing fixed journal stage");
      events.push({ stage: value.stage });
      if (value.stage === "before-image-remove") afterJournal?.();
    },
    effect: async (args: readonly string[]) => {
      expect(args.slice(0, 3)).toEqual(["image", "rm", "--no-prune"]);
      const selectedId = args[3];
      if (!selectedId || !remaining.delete(selectedId))
        throw new Error("Unexpected exact image effect");
      events.push({ stage: "remove", id: selectedId });
      afterEffect?.();
    },
  };
  return {
    opts,
    remaining,
    refs,
    events,
    current,
    changeDaemon: () => {
      daemon = '"foreign-engine"';
    },
    setAfterJournal: (action: () => void) => {
      afterJournal = action;
    },
    setAfterEffect: (action: () => void) => {
      afterEffect = action;
    },
  };
}
test("owned image cleanup journals and removes exact children before parents without prune", async () => {
  const model = buildCleanupModel();
  await cleanupRetainedBuildFixtureImages(model.opts);
  expect([...model.remaining]).toEqual([]);
  expect(model.events).toEqual(
    [image, secondBuildParent, firstBuildParent].flatMap((id) => [
      { stage: "before-image-remove" },
      { stage: "remove", id },
      { stage: "after-image-remove" },
    ])
  );
});
for (const mode of [
  "reference-after-journal",
  "daemon-after-journal",
  "changed-birth",
  "foreign-after-effect",
] as const) {
  test(`owned image cleanup refuses ${mode} without another effect`, async () => {
    const model = buildCleanupModel();
    if (mode === "reference-after-journal")
      model.setAfterJournal(() => model.refs.add(image));
    if (mode === "daemon-after-journal")
      model.setAfterJournal(model.changeDaemon);
    if (mode === "changed-birth") {
      const row = model.current.get(secondBuildParent);
      if (!row) throw new Error("Missing fixed image row");
      model.current.set(secondBuildParent, {
        ...row,
        created: "2026-10-08T21:00:00Z",
      });
    }
    if (mode === "foreign-after-effect")
      model.setAfterEffect(() =>
        model.remaining.add(`sha256:${"f".repeat(64)}`)
      );
    await expect(cleanupRetainedBuildFixtureImages(model.opts)).rejects.toThrow(
      "values omitted"
    );
    expect(model.events.filter((row) => row.stage === "remove").length).toBe(
      mode === "foreign-after-effect" ? 1 : 0
    );
    expect(model.remaining.has(firstBuildParent)).toBe(true);
  });
}
test("build read shim admits exact original/published images queries and captured image facts only", () => {
  for (const file of [
    "/owned/root/.hack/docker-compose.yml",
    `/owned/root/.hack/.internal/legacy-compose-adoption-v1/generations/${anchor.id}/legacy-compose.yml`,
  ]) {
    for (const service of ["db", "worker"]) {
      expect(
        retainedBuildFixtureReadAllowed({
          ...scope,
          generationId: anchor.id,
          args: [
            ...prefix,
            file,
            "config",
            "--no-env-resolution",
            "--images",
            service,
          ],
        })
      ).toBe(true);
    }
  }
  expect(
    retainedBuildFixtureReadAllowed({
      ...scope,
      args: [
        "image",
        "inspect",
        "--format",
        '{"id":{{json .Id}},"createdAt":{{json .Created}}}',
        image,
      ],
    })
  ).toBe(true);
  for (const args of [
    [
      ...prefix,
      "/elsewhere/source.yml",
      "config",
      "--no-env-resolution",
      "--images",
      "db",
    ],
    [
      ...prefix,
      "/owned/root/.hack/docker-compose.yml",
      "config",
      "--images",
      "db",
    ],
    [...prefix, "/owned/root/.hack/docker-compose.yml", "up", "--detach"],
    ["compose", "build", "db"],
    ["image", "rm", image],
    ["pull", "fixture-db"],
    ["container", "create", "fixture-db"],
    ["image", "inspect", "--format", "{{json .Config.Env}}", image],
    [
      "image",
      "inspect",
      "--format",
      '{"id":{{json .Id}},"createdAt":{{json .Created}}}',
      "foreign",
    ],
  ]) {
    expect(retainedBuildFixtureReadAllowed({ ...scope, args })).toBe(false);
  }
});
test("build effects require whole journaled original IDs and exact prepared or active generation", () => {
  expect(
    retainedBuildFixtureMutationAllowed({
      args: ["container", "stop", other],
      receipt,
      ids: [id, other],
      services: ["db", "worker"],
    })
  ).toBe(true);
  const active = {
    ...receipt,
    publication: { phase: "active", generation: anchor },
    pendingOperation: { ...receipt.pendingOperation, operation: "start" },
  };
  expect(
    retainedBuildFixtureMutationAllowed({
      args: ["container", "start", id],
      receipt: active,
      ids: [id, other],
      services: ["db", "worker"],
    })
  ).toBe(true);
  for (const value of [
    null,
    { ...receipt, adoption_receipt_version: 6 },
    { ...receipt, pendingOperation: null },
    {
      ...receipt,
      pendingOperation: { ...receipt.pendingOperation, services: ["db"] },
    },
    { ...receipt, prepared: { ...anchor, id: "1".repeat(32) } },
  ]) {
    expect(
      retainedBuildFixtureMutationAllowed({
        args: ["container", "stop", id],
        receipt: value,
        ids: [id, other],
        services: ["db", "worker"],
      })
    ).toBe(false);
  }
  for (const args of [
    ["container", "stop", "f".repeat(64)],
    ["container", "stop", id, other],
    ["container", "rm", id],
    ["compose", "up", "--detach"],
  ]) {
    expect(
      retainedBuildFixtureMutationAllowed({
        args,
        receipt,
        ids: [id, other],
        services: ["db", "worker"],
      })
    ).toBe(false);
  }
});
test("first preparation image/hash queries pass at actual empty-receipt boundaries through the closed staged owner", async () => {
  const h = await retainedBuildFixture();
  try {
    const first = await captureAdoptionDependencyFirstPrepare({
      projectRoot: h.root,
    });
    const entry = join(h.outer, "docker"),
      target = join(h.outer, "docker-model");
    await rename(entry, target);
    const helper = fileURLToPath(
      new URL(
        "./e2e/scenarios/native-compose-adoption-build-inputs.ts",
        import.meta.url
      )
    );
    const trace = join(h.outer, "staged-fixture-read-control");
    const receiptPath = join(
      h.root,
      ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
    );
    const fixedScope = {
      projectRoot: h.root,
      project: "fixture",
      containerIds: [id],
      networkId: "b".repeat(64),
      volumeName: "fixture_original_data",
      images: [{ id: h.model.image, reference: "fixture-db" }],
    };
    const script = [
      `#!${process.execPath}`,
      `import {retainedBuildFixtureReadAllowed,retainedBuildFixtureStagedReadAllowed} from ${JSON.stringify(helper)};`,
      `const args=process.argv.slice(2), file=Bun.file(${JSON.stringify(receiptPath)});`,
      "const saved=await file.exists()?await file.json():null;",
      `const scope={...${JSON.stringify(fixedScope)},args,generationId:saved?.prepared?.id};`,
      `const ordinary=retainedBuildFixtureReadAllowed(scope), staged=!ordinary && await retainedBuildFixtureStagedReadAllowed({scope,first:${JSON.stringify(first)}});`,
      "if(!ordinary&&!staged)process.exit(93);",
      `if(staged){const {appendFile}=await import('node:fs/promises');await appendFile(${JSON.stringify(trace)},JSON.stringify({imageQuery:args.includes('--images'),receiptPrepared:saved?.prepared!==null})+'\\n');}`,
      `const child=Bun.spawn([${JSON.stringify(target)},...args],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exit(await child.exited);`,
    ].join("\n");
    await writeFile(entry, script);
    await chmod(entry, 0o700);
    const store = await h.store();
    try {
      const prepared = await store.prepare({ binary: h.compiler });
      expect(prepared.report.adoption_generation_version).toBe(9);
      const rows: unknown[] = (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows).toContainEqual({ imageQuery: true, receiptPrepared: false });
      expect(rows).toContainEqual({
        imageQuery: false,
        receiptPrepared: false,
      });
      expect(
        rows.every(
          (row) =>
            typeof row === "object" &&
            row !== null &&
            "receiptPrepared" in row &&
            row.receiptPrepared === false
        )
      ).toBe(true);
    } finally {
      await store.close();
    }
  } finally {
    await h.cleanup();
  }
}, 30_000);
