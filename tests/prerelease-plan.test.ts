import { describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageNativeStorageTool } from "../scripts/package-native-storage-tool.ts";
import {
  CONFIG_COMPILER_PAYLOAD,
  createPrereleasePlan,
  PAYLOAD_MODES,
  PRERELEASE_PAYLOAD,
  PRERELEASE_PLATFORM,
  PRERELEASE_SUPPORT_ANCHOR,
  packagePrerelease,
  prereleaseMetadata,
  prereleaseNotes,
  renderChecksums,
  requireExactHeadCi,
  requireHumanApproval,
  requireReviewerProtection,
  stableReleaseVersion,
  verifyPublishGate,
  verifyReleaseAssets,
} from "../scripts/prerelease-plan.ts";
import {
  NATIVE_STORAGE_TOOL_FILE,
  NATIVE_STORAGE_TOOL_MANIFEST,
  nativeStorageToolManifest,
} from "../src/backends/native-authored-storage-tool.ts";
import { packageMcpBundle } from "../src/mcp/bundle.ts";
import { nativeCandidateMcpPayload } from "../src/mcp/candidate-payload.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const sha = "a".repeat(40);
const input = {
  version: "5.0.0-next.1",
  sourceRevision: sha,
  ref: "refs/heads/next",
  eventName: "workflow_dispatch",
  channel: "prerelease",
};
const plan = createPrereleasePlan(input);
const environment = {
  name: "v5-prerelease",
  id: 42,
  can_admins_bypass: false,
  protection_rules: [
    {
      type: "required_reviewers",
      reviewers: [{ type: "User", reviewer: { id: 1 } }],
    },
  ],
};
const approval = [
  {
    state: "approved",
    environments: [{ id: 42 }],
    user: { type: "User", id: 1 },
  },
];
const ciRun = {
  id: 77,
  head_sha: sha,
  head_branch: "next",
  event: "push",
  status: "completed",
  conclusion: "success",
  path: ".github/workflows/ci.yml",
};
const jobNames = [
  "Runtime state models",
  "Candidate core (ubuntu-latest)",
  "Candidate core (macos-latest)",
  "secret-scan",
  "runtime-images",
  "docker-e2e shard 1/4",
  "docker-e2e shard 2/4",
  "docker-e2e shard 3/4",
  "docker-e2e shard 4/4",
  "docker-e2e",
  "test",
  "linux-process-lifetime",
];
const jobs = jobNames.map((name) => ({
  name,
  head_sha: sha,
  status: "completed",
  conclusion: "success",
}));
const branch = {
  protected: true,
  commit: { sha },
  protection: {
    required_status_checks: { checks: [], contexts: [] },
  },
};

function gateApi(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    "branches/next": branch,
    "environments/v5-prerelease": environment,
    [`actions/workflows/ci.yml/runs?branch=next&event=push&head_sha=${sha}&per_page=1`]:
      { workflow_runs: [ciRun] },
    "actions/runs/77/jobs?per_page=100&page=1": { jobs },
    "rules/branches/next?per_page=100&page=1": [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: "test", integration_id: 15_368 }],
        },
      },
    ],
    [`commits/${sha}/check-runs?filter=latest&per_page=100&page=1`]: {
      check_runs: [
        {
          name: "test",
          head_sha: sha,
          app: { id: 15_368 },
          status: "completed",
          conclusion: "success",
        },
      ],
    },
    [`commits/${sha}/statuses?per_page=100&page=1`]: [],
    [`git/ref/tags/${plan.tag}`]: null,
    [`releases/tags/${plan.tag}`]: null,
    "actions/runs/99/approvals": approval,
    ...overrides,
  };
  return (path: string): Promise<unknown> => {
    if (!(path in data)) {
      throw new Error(`Unexpected API request ${path}`);
    }
    return Promise.resolve(data[path]);
  };
}

describe("prerelease decision boundary", () => {
  test("plans exact immutable assets without publishing by default", () => {
    expect(plan.publish).toBe(false);
    expect(plan.tag).toBe("v5.0.0-next.1");
    expect(plan.archive).toBe("hack-5.0.0-next.1-darwin-arm64-native.tar.gz");
    expect(plan.assets).toEqual([
      plan.archive,
      "prerelease.json",
      "SHA256SUMS",
    ]);
    expect(
      createPrereleasePlan({
        ...input,
        version: "5.0.0-next.22",
        publish: "true",
      }).publish
    ).toBe(true);
  });

  test("refuses invalid versions, revisions, event, channel and publish input", () => {
    for (const version of [
      "5.0.0",
      "v5.0.0-next.1",
      "5.0.0-next.0",
      "5.0.0-next.01",
      "5.0.0-next.1+foo",
      "5.0.0-next.1\n",
      "5.0.0-next.1;touch /tmp/injected",
      "5.0.0-rc.1",
      "4.2.1-next.1",
    ]) {
      expect(() => createPrereleasePlan({ ...input, version })).toThrow();
    }
    for (const sourceRevision of [
      "abc",
      "A".repeat(40),
      `${sha}\n`,
      "refs/heads/next",
    ]) {
      expect(() =>
        createPrereleasePlan({ ...input, sourceRevision })
      ).toThrow();
    }
    for (const ref of ["refs/heads/main", "refs/tags/v5.0.0-next.1", "next"]) {
      expect(() => createPrereleasePlan({ ...input, ref })).toThrow();
    }
    expect(() =>
      createPrereleasePlan({ ...input, channel: "stable" })
    ).toThrow();
    expect(() =>
      createPrereleasePlan({ ...input, eventName: "push" })
    ).toThrow();
    expect(() => createPrereleasePlan({ ...input, publish: "yes" })).toThrow();
  });

  test("stable path refuses every prerelease and metadata tag even on manual dispatch", () => {
    expect(
      stableReleaseVersion({
        channel: "stable",
        tag: "v4.2.1",
        packageVersion: "4.2.1",
      })
    ).toBe("4.2.1");
    for (const version of [
      "5.0.0-next.1",
      "4.2.1-beta.2",
      "4.2.1+candidate",
      "04.2.1",
      "4.02.1",
      "4.2.01",
    ]) {
      expect(() =>
        stableReleaseVersion({
          channel: "stable",
          tag: `v${version}`,
          packageVersion: version,
        })
      ).toThrow();
    }
    expect(() =>
      stableReleaseVersion({
        channel: "prerelease",
        tag: "v4.2.1",
        packageVersion: "4.2.1",
      })
    ).toThrow();
    expect(() =>
      stableReleaseVersion({
        channel: "stable",
        tag: "v4.2.2",
        packageVersion: "4.2.1",
      })
    ).toThrow();
  });

  test("requires concrete protection and human approval", () => {
    expect(requireReviewerProtection(environment)).toBe(42);
    for (const invalid of [
      { ...environment, protection_rules: [] },
      { ...environment, can_admins_bypass: true },
      {
        ...environment,
        protection_rules: [{ type: "required_reviewers", reviewers: [] }],
      },
      { ...environment, name: "production" },
      {
        ...environment,
        protection_rules: [{ type: "required_reviewers", reviewers: [{}] }],
      },
      {
        ...environment,
        protection_rules: [
          {
            type: "required_reviewers",
            reviewers: [{ type: "Bot", reviewer: { id: 1 } }],
          },
        ],
      },
      {
        ...environment,
        protection_rules: [
          {
            type: "required_reviewers",
            reviewers: [{ type: "User", reviewer: { id: "1" } }],
          },
        ],
      },
    ]) {
      expect(() => requireReviewerProtection(invalid)).toThrow();
    }
    requireHumanApproval({ reviews: approval, environmentId: 42 });
    for (const reviews of [
      [],
      [{ ...approval[0], user: { type: "Bot" } }],
      [{ ...approval[0], user: { type: "User", id: "1" } }],
      [{ ...approval[0], environments: [{ id: 43 }] }],
      [{ ...approval[0], state: "rejected" }],
    ]) {
      expect(() =>
        requireHumanApproval({ reviews, environmentId: 42 })
      ).toThrow();
    }
  });

  test("requires actual exact-head CI without skipped jobs", () => {
    requireExactHeadCi({ run: ciRun, jobs, sourceRevision: sha });
    for (const run of [
      { ...ciRun, event: "pull_request" },
      { ...ciRun, head_sha: "b".repeat(40) },
      { ...ciRun, head_branch: "main" },
      { ...ciRun, conclusion: "failure" },
    ]) {
      expect(() =>
        requireExactHeadCi({ run, jobs, sourceRevision: sha })
      ).toThrow();
    }
    expect(() =>
      requireExactHeadCi({
        run: ciRun,
        jobs: jobs.slice(1),
        sourceRevision: sha,
      })
    ).toThrow();
    // The docker-e2e fan-in alone is not enough: every shard must have succeeded.
    expect(() =>
      requireExactHeadCi({
        run: ciRun,
        jobs: jobs.filter((job) => job.name !== "docker-e2e shard 3/4"),
        sourceRevision: sha,
      })
    ).toThrow("Exact-head CI job did not succeed: docker-e2e shard 3/4");
    expect(() =>
      requireExactHeadCi({
        run: ciRun,
        jobs: [
          ...jobs,
          { name: "additional", status: "completed", conclusion: "skipped" },
        ],
        sourceRevision: sha,
      })
    ).toThrow();
  });

  test("combined publish gate refuses moved head, missing protection/CI, wrong app, existing assets and no approval", async () => {
    await verifyPublishGate({
      plan,
      api: gateApi(),
      runId: "99",
      approved: true,
    });
    for (const overrides of [
      { "branches/next": { protected: true, commit: { sha: "b".repeat(40) } } },
      {
        "environments/v5-prerelease": { ...environment, protection_rules: [] },
      },
      { "actions/runs/77/jobs?per_page=100&page=1": { jobs: jobs.slice(1) } },
      {
        [`commits/${sha}/check-runs?filter=latest&per_page=100&page=1`]: {
          check_runs: [
            {
              name: "test",
              head_sha: sha,
              app: { id: 999 },
              status: "completed",
              conclusion: "success",
            },
          ],
        },
      },
      { [`git/ref/tags/${plan.tag}`]: { ref: `refs/tags/${plan.tag}` } },
      { [`releases/tags/${plan.tag}`]: { id: 1 } },
      { "actions/runs/99/approvals": [] },
    ]) {
      await expect(
        verifyPublishGate({
          plan,
          api: gateApi(overrides),
          runId: "99",
          approved: true,
        })
      ).rejects.toThrow();
    }
    await expect(
      verifyPublishGate({
        plan,
        api: () => Promise.reject(new Error("API unavailable")),
        runId: "99",
        approved: true,
      })
    ).rejects.toThrow("API unavailable");
  });

  test("uses content-readable classic policy alongside rulesets without an administration endpoint", async () => {
    const classicBranch = {
      ...branch,
      protection: {
        required_status_checks: {
          checks: [{ context: "classic-check", app_id: 123 }],
          contexts: ["classic-check"],
        },
      },
    };
    const checkPath = `commits/${sha}/check-runs?filter=latest&per_page=100&page=1`;
    const classicCheck = {
      name: "classic-check",
      head_sha: sha,
      app: { id: 123 },
      status: "completed",
      conclusion: "success",
    };
    const overrides = {
      "branches/next": classicBranch,
      [checkPath]: {
        check_runs: [
          { ...classicCheck, name: "test", app: { id: 15_368 } },
          classicCheck,
        ],
      },
    };
    await verifyPublishGate({
      plan,
      api: gateApi(overrides),
      runId: "99",
      approved: true,
    });
    for (const check of [
      { ...classicCheck, app: { id: 999 } },
      { ...classicCheck, head_sha: "b".repeat(40) },
      { ...classicCheck, conclusion: "failure" },
    ]) {
      await expect(
        verifyPublishGate({
          plan,
          api: gateApi({
            ...overrides,
            [checkPath]: {
              check_runs: [
                { ...classicCheck, name: "test", app: { id: 15_368 } },
                check,
              ],
            },
          }),
          runId: "99",
          approved: true,
        })
      ).rejects.toThrow("classic-check");
    }
    for (const protection of [
      undefined,
      { required_status_checks: { contexts: [] } },
      { required_status_checks: { checks: [], contexts: null } },
    ]) {
      await expect(
        verifyPublishGate({
          plan,
          api: gateApi({ "branches/next": { ...branch, protection } }),
          runId: "99",
          approved: true,
        })
      ).rejects.toThrow();
    }
    await expect(
      verifyPublishGate({
        plan,
        api: gateApi({ "rules/branches/next?per_page=100&page=1": [] }),
        runId: "99",
        approved: true,
      })
    ).rejects.toThrow("next must require status checks");
    await verifyPublishGate({
      plan,
      api: gateApi({
        ...overrides,
        "rules/branches/next?per_page=100&page=1": [],
      }),
      runId: "99",
      approved: true,
    });
  });

  test("requires checks on later effective-rule pages", async () => {
    const laterRequirement = {
      type: "required_status_checks",
      parameters: {
        required_status_checks: [
          { context: "later-check", integration_id: 15_368 },
        ],
      },
    };
    const overrides = {
      "rules/branches/next?per_page=100&page=1": Array.from(
        { length: 100 },
        () => ({ type: "deletion" })
      ),
      "rules/branches/next?per_page=100&page=2": [laterRequirement],
    };
    await expect(
      verifyPublishGate({
        plan,
        api: gateApi(overrides),
        runId: "99",
        approved: true,
      })
    ).rejects.toThrow("later-check");
    await verifyPublishGate({
      plan,
      api: gateApi({
        ...overrides,
        [`commits/${sha}/check-runs?filter=latest&per_page=100&page=1`]: {
          check_runs: [
            {
              name: "later-check",
              head_sha: sha,
              app: { id: 15_368 },
              status: "completed",
              conclusion: "success",
            },
          ],
        },
      }),
      runId: "99",
      approved: true,
    });
  });
});

/** Smallest Linux ARM64 ELF header the storage tool byte contract accepts. */
function storageToolBytes() {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(183, 18);
  return bytes;
}

const STORAGE_TOOL_PAYLOAD = [
  NATIVE_STORAGE_TOOL_FILE,
  NATIVE_STORAGE_TOOL_MANIFEST,
] as const;

async function fixture(root: string) {
  const bundle = join(root, "bundle");
  // The storage tool packager requires the builder's private bundle directory.
  await mkdir(bundle, { mode: 0o700 });
  await chmod(bundle, 0o700);
  for (const name of PRERELEASE_PAYLOAD) {
    if ((STORAGE_TOOL_PAYLOAD as readonly string[]).includes(name)) {
      continue;
    }
    const value =
      name === "prerelease.json"
        ? JSON.stringify(prereleaseMetadata(input))
        : `fixture ${name}\n`;
    await Bun.write(join(bundle, name), value);
  }
  // Mirror scripts/build-native-candidate.sh: chmod 500, then the real manifest writer.
  await writeFile(join(bundle, NATIVE_STORAGE_TOOL_FILE), storageToolBytes(), {
    mode: 0o500,
  });
  await chmod(join(bundle, NATIVE_STORAGE_TOOL_FILE), 0o500);
  await packageNativeStorageTool({
    directory: bundle,
    sourceRevision: input.sourceRevision,
  });
  await Bun.write(
    join(bundle, "SHA256SUMS"),
    await renderChecksums({ root: bundle, names: PRERELEASE_PAYLOAD })
  );
  return bundle;
}

async function compilerFixture(bundle: string) {
  await writeFile(
    join(bundle, "hack-config-compiler"),
    "synthetic compiler\n",
    { mode: 0o755 }
  );
  await chmod(join(bundle, "hack-config-compiler"), 0o755);
  await writeFile(join(bundle, "hack.project.schema.json"), "{}\n", {
    mode: 0o600,
  });
  await chmod(join(bundle, "hack.project.schema.json"), 0o600);
  await writeFile(join(bundle, "hack.local.schema.json"), "{}\n", {
    mode: 0o600,
  });
  await chmod(join(bundle, "hack.local.schema.json"), 0o600);
  await Bun.write(
    join(bundle, "SHA256SUMS"),
    await renderChecksums({
      root: bundle,
      names: [...PRERELEASE_PAYLOAD, ...CONFIG_COMPILER_PAYLOAD],
    })
  );
}

test("packages the compiler and both schemas beside the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-compiler-package-"));
  try {
    const bundle = await fixture(root);
    await compilerFixture(bundle);
    const plan = createPrereleasePlan(input);
    const output = join(root, "assets");
    await packagePrerelease({ plan, bundle, output });
    expect(
      (await archiveMembers(join(output, plan.archive)))
        .map((entry) => entry.name)
        .sort()
    ).toEqual(
      [...PRERELEASE_PAYLOAD, ...CONFIG_COMPILER_PAYLOAD, "SHA256SUMS"].sort()
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves the older complete compiler/project-schema pair", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-compiler-legacy-pair-"));
  try {
    const bundle = await fixture(root);
    await compilerFixture(bundle);
    await rm(join(bundle, "hack.local.schema.json"));
    const names = [
      ...PRERELEASE_PAYLOAD,
      "hack-config-compiler",
      "hack.project.schema.json",
    ];
    await Bun.write(
      join(bundle, "SHA256SUMS"),
      await renderChecksums({ root: bundle, names })
    );
    const plan = createPrereleasePlan(input);
    const output = join(root, "assets");
    await packagePrerelease({ plan, bundle, output });
    expect(
      (await archiveMembers(join(output, plan.archive)))
        .map((entry) => entry.name)
        .sort()
    ).toEqual([...names, "SHA256SUMS"].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const members of [
  ["hack-config-compiler"],
  ["hack.project.schema.json"],
  ["hack.local.schema.json"],
  ["hack-config-compiler", "hack.local.schema.json"],
  ["hack.project.schema.json", "hack.local.schema.json"],
]) {
  test(`refuses incomplete compiler inventory despite matching checksums: ${members.join(",")}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-compiler-inventory-"));
    try {
      const bundle = await fixture(root);
      await compilerFixture(bundle);
      for (const name of CONFIG_COMPILER_PAYLOAD) {
        if (!members.includes(name)) {
          await rm(join(bundle, name));
        }
      }
      await Bun.write(
        join(bundle, "SHA256SUMS"),
        await renderChecksums({
          root: bundle,
          names: [...PRERELEASE_PAYLOAD, ...members],
        })
      );
      await expect(
        packagePrerelease({
          plan: createPrereleasePlan(input),
          bundle,
          output: join(root, "refused"),
        })
      ).rejects.toThrow("requires the compiler and project schema");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const name of CONFIG_COMPILER_PAYLOAD) {
  for (const corruption of [
    "missing",
    "tampered",
    "symlink",
    "hardlink",
    "mode",
  ] as const) {
    test(`refuses ${corruption} compiler payload ${name}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "hack-compiler-refusal-"));
      try {
        const bundle = await fixture(root);
        await compilerFixture(bundle);
        const path = join(bundle, name);
        if (corruption === "missing") {
          await rm(path);
        } else if (corruption === "tampered") {
          await Bun.write(path, "changed");
        } else if (corruption === "mode") {
          await chmod(path, 0o777);
        } else if (corruption === "symlink") {
          await rm(path);
          await symlink("hack-cli", path);
        } else {
          await link(path, join(root, "alias"));
        }
        await expect(
          packagePrerelease({
            plan: createPrereleasePlan(input),
            bundle,
            output: join(root, "refused"),
          })
        ).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

for (const name of STORAGE_TOOL_PAYLOAD) {
  for (const [corruption, message] of [
    ["missing", "exactly the complete payload"],
    ["tampered", "Native storage tool"],
    ["symlink", "regular file"],
    ["hardlink", "regular file"],
    ["mode", "unsafe permissions"],
    ["not-executable", "unsafe permissions"],
  ] as const) {
    test(`refuses ${corruption} storage tool payload ${name}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "hack-storage-tool-refusal-"));
      try {
        const bundle = await fixture(root);
        const path = join(bundle, name);
        const mode = PAYLOAD_MODES[name] ?? 0o600;
        if (corruption === "missing") {
          await rm(path);
        } else if (corruption === "tampered") {
          await chmod(path, 0o600);
          const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
          bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
          await writeFile(path, bytes);
          await chmod(path, mode);
        } else if (corruption === "mode") {
          await chmod(path, 0o755);
        } else if (corruption === "not-executable") {
          await chmod(path, mode === 0o500 ? 0o400 : 0o700);
        } else if (corruption === "symlink") {
          await rm(path);
          await symlink("hack-cli", path);
        } else {
          await link(path, join(root, "alias"));
        }
        await expect(
          packagePrerelease({
            plan: createPrereleasePlan(input),
            bundle,
            output: join(root, "refused"),
          })
        ).rejects.toThrow(message);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("refuses a storage tool manifest not bound to the witness or planned source despite matching checksums", async () => {
  const cases: Array<{
    readonly label: string;
    readonly manifest: (bytes: Buffer) => string;
    readonly message: string;
  }> = [
    {
      label: "other source revision",
      manifest: (bytes) =>
        JSON.stringify(nativeStorageToolManifest(bytes, "b".repeat(40))),
      message: "witness bytes and source revision",
    },
    {
      label: "other bytes",
      manifest: (bytes) =>
        JSON.stringify(
          nativeStorageToolManifest(
            Buffer.concat([bytes, Buffer.from([0])]),
            sha
          )
        ),
      message: "witness bytes and source revision",
    },
    {
      label: "extra field",
      manifest: (bytes) =>
        JSON.stringify({
          ...nativeStorageToolManifest(bytes, sha),
          extra: true,
        }),
      message: "manifest is malformed",
    },
    {
      label: "not JSON",
      manifest: () => "not json",
      message: "manifest is malformed",
    },
    {
      label: "oversized",
      manifest: () => " ".repeat(4097),
      message: "manifest is malformed",
    },
  ];
  for (const { label, manifest, message } of cases) {
    const root = await mkdtemp(join(tmpdir(), "hack-storage-tool-binding-"));
    try {
      const bundle = await fixture(root);
      await writeFile(
        join(bundle, NATIVE_STORAGE_TOOL_MANIFEST),
        `${manifest(storageToolBytes())}\n`
      );
      await Bun.write(
        join(bundle, "SHA256SUMS"),
        await renderChecksums({ root: bundle, names: PRERELEASE_PAYLOAD })
      );
      await expect(
        packagePrerelease({
          plan: createPrereleasePlan(input),
          bundle,
          output: join(root, "refused"),
        }),
        label
      ).rejects.toThrow(message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

/** Python exposes AppleDouble entries that macOS tar's own listing hides. */
async function archiveMembers(archive: string) {
  const listing = Bun.spawn(
    [
      "python3",
      "-c",
      "import json, sys, tarfile\nwith tarfile.open(sys.argv[1], 'r:gz') as archive:\n print(json.dumps([{'name': member.name, 'file': member.isfile()} for member in archive.getmembers()]))",
      archive,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    listing.exited,
    new Response(listing.stdout).text(),
    new Response(listing.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as Array<{ name: string; file: boolean }>;
}

test("packages complete metadata-bound archive and refuses replacement, tampering and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-prerelease-"));
  try {
    const bundle = await fixture(root);
    const output = join(root, "assets");
    await packagePrerelease({ plan, bundle, output });
    await verifyReleaseAssets({ plan, output });
    const members = await archiveMembers(join(output, plan.archive));
    expect(members.map((member) => member.name).sort()).toEqual(
      [...PRERELEASE_PAYLOAD, "SHA256SUMS"].sort()
    );
    expect(members.every((member) => member.file)).toBe(true);
    await expect(packagePrerelease({ plan, bundle, output })).rejects.toThrow();
    await Bun.write(join(output, plan.archive), "tampered");
    await expect(verifyReleaseAssets({ plan, output })).rejects.toThrow(
      "outer checksum"
    );
    await Bun.write(
      join(bundle, "prerelease.json"),
      JSON.stringify({
        ...prereleaseMetadata(input),
        source_revision: "b".repeat(40),
      })
    );
    await expect(
      packagePrerelease({ plan, bundle, output: join(root, "bad-metadata") })
    ).rejects.toThrow("metadata");
    await rm(bundle, { recursive: true });
    await fixture(root);
    await Bun.write(join(bundle, "hack-native"), "tampered");
    await expect(
      packagePrerelease({ plan, bundle, output: join(root, "bad-payload") })
    ).rejects.toThrow("checksums");
    await rm(join(bundle, "hack-native"));
    await symlink("hack-cli", join(bundle, "hack-native"));
    await expect(
      packagePrerelease({ plan, bundle, output: join(root, "alias") })
    ).rejects.toThrow("regular file");
    await rm(join(bundle, "hack-native"));
    await link(join(bundle, "hack-cli"), join(bundle, "hack-native"));
    await expect(
      packagePrerelease({ plan, bundle, output: join(root, "hardlink") })
    ).rejects.toThrow("regular file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packages exactly the native payload members despite macOS source extended attributes", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-prerelease-xattr-"));
  try {
    const bundle = await fixture(root);
    const names = [...PRERELEASE_PAYLOAD, "SHA256SUMS"];
    if (process.platform === "darwin") {
      // Setting an attribute needs write access; restore the witness's packaged mode.
      const witness = join(bundle, NATIVE_STORAGE_TOOL_FILE);
      await chmod(witness, 0o700);
      const attribute = Bun.spawn(
        [
          "/usr/bin/xattr",
          "-w",
          "com.hack.prerelease-fixture",
          "inventory-regression",
          ...names.map((name) => join(bundle, name)),
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      expect(await new Response(attribute.stderr).text()).toBe("");
      expect(await attribute.exited).toBe(0);
      await chmod(witness, 0o500);
      const controlPath = join(root, "with-metadata.tar.gz");
      const { COPYFILE_DISABLE: _copyfileDisabled, ...controlEnv } =
        process.env;
      const control = Bun.spawn(
        ["tar", "-czf", controlPath, "-C", bundle, ...names],
        { env: controlEnv, stdout: "pipe", stderr: "pipe" }
      );
      expect(await new Response(control.stderr).text()).toBe("");
      expect(await control.exited).toBe(0);
      const controlMembers = await archiveMembers(controlPath);
      expect(controlMembers.map((member) => member.name)).toContain(
        "._hack-native"
      );
      expect(controlMembers).toHaveLength(names.length * 2);
    }
    const output = join(root, "assets");
    await packagePrerelease({ plan, bundle, output });
    await verifyReleaseAssets({ plan, output });
    const members = await archiveMembers(join(output, plan.archive));
    expect(members.map((member) => member.name).sort()).toEqual(names.sort());
    expect(members).toHaveLength(names.length);
    expect(members.every((member) => member.file)).toBe(true);
    if (process.platform === "darwin") {
      const preserved = Bun.spawn(
        [
          "/usr/bin/xattr",
          "-p",
          "com.hack.prerelease-fixture",
          join(bundle, "hack-native"),
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      expect(await new Response(preserved.stdout).text()).toBe(
        "inventory-regression\n"
      );
      expect(await preserved.exited).toBe(0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packages a verified MCP selection with exact nested checksums and inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-prerelease-mcp-"));
  try {
    const bundle = await fixture(root);
    const inputs = {
      adapter: join(root, "adapter"),
      owner: join(root, "owner"),
      backend: join(root, "backend"),
    };
    for (const role of ["adapter", "owner", "backend"] as const) {
      const info = {
        schemaVersion: 1,
        role,
        startupProtocol: 2,
        wireProtocol: 1,
        platform: process.platform,
        architecture: process.arch,
      };
      await writeFile(
        inputs[role],
        `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(info)}'\n`,
        { mode: 0o700 }
      );
    }
    const mcp = await packageMcpBundle({
      outputRoot: join(bundle, "mcp"),
      inputs,
    });
    const nested = await nativeCandidateMcpPayload(bundle);
    expect(nested).toHaveLength(4);
    await compilerFixture(bundle);
    const names = [
      ...PRERELEASE_PAYLOAD,
      ...CONFIG_COMPILER_PAYLOAD,
      ...nested,
    ];
    await Bun.write(
      join(bundle, "SHA256SUMS"),
      await renderChecksums({ root: bundle, names })
    );
    const output = join(root, "assets");
    await packagePrerelease({ plan, bundle, output });
    expect(
      (await archiveMembers(join(output, plan.archive)))
        .map((entry) => entry.name)
        .sort()
    ).toEqual([...names, "SHA256SUMS"].sort());
    await verifyReleaseAssets({ plan, output });
    await writeFile(join(mcp.directory, "extra"), "foreign");
    await expect(
      packagePrerelease({ plan, bundle, output: join(root, "extra") })
    ).rejects.toThrow("unexpected files");
    await rm(join(mcp.directory, "extra"));
    const foreign = join(bundle, "mcp", "0".repeat(64));
    await rename(mcp.directory, foreign);
    await expect(nativeCandidateMcpPayload(bundle)).rejects.toThrow("identity");
    await rename(foreign, mcp.directory);
    await chmod(mcp.executables.backend, 0o700);
    await writeFile(mcp.executables.backend, "changed");
    await chmod(mcp.executables.backend, 0o500);
    await Bun.write(
      join(bundle, "SHA256SUMS"),
      await renderChecksums({ root: bundle, names })
    );
    await expect(
      packagePrerelease({ plan, bundle, output: join(root, "corrupt") })
    ).rejects.toThrow("integrity");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local dry-run has no publishing effects and refuses SHA mismatch and injected input", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-prerelease-plan-"));
  try {
    const gh = join(root, "gh");
    await Bun.write(gh, "#!/bin/sh\nexit 98\n");
    await chmod(gh, 0o755);
    const env = {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      GITHUB_OUTPUT: "",
      GITHUB_REF: input.ref,
      GITHUB_SHA: sha,
      GITHUB_EVENT_NAME: input.eventName,
      RELEASE_CHANNEL: input.channel,
      HACK_PRERELEASE_VERSION: input.version,
      HACK_PRERELEASE_SOURCE_REVISION: sha,
      HACK_PRERELEASE_PUBLISH: "false",
    };
    for (const override of [
      {},
      { GITHUB_SHA: "b".repeat(40) },
      { HACK_PRERELEASE_VERSION: "5.0.0-next.1\narchive=wrong" },
    ]) {
      const child = Bun.spawn(
        [process.execPath, "scripts/prerelease-plan.ts", "plan"],
        { env: { ...env, ...override }, stdout: "pipe", stderr: "pipe" }
      );
      const text = await new Response(child.stdout).text();
      expect(await child.exited).toBe(
        Object.keys(override).length === 0 ? 0 : 1
      );
      if (Object.keys(override).length === 0) {
        expect(JSON.parse(text).publish).toBe(false);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registered Release routes explicit prerelease to the same-commit reusable workflow and keeps stable/tap isolated", async () => {
  const release = Bun.YAML.parse(
    await Bun.file(".github/workflows/release.yml").text()
  ) as {
    on: {
      push: { tags: string[] };
      workflow_dispatch: { inputs: Record<string, { default?: unknown }> };
    };
    jobs: Record<
      string,
      {
        if?: string;
        uses?: string;
        secrets?: string;
        steps?: Array<{ run?: string }>;
      }
    >;
  };
  expect(release.on.workflow_dispatch.inputs.channel?.default).toBe("stable");
  expect(release.on.workflow_dispatch.inputs.publish_prerelease?.default).toBe(
    false
  );
  expect(release.on.push.tags).toEqual(["v*", "!v*-*", "!v*\\+*"]);
  expect(release.jobs.prerelease?.uses).toBe(
    "./.github/workflows/prerelease.yml"
  );
  expect(release.jobs.prerelease?.if).toContain(
    "inputs.channel == 'prerelease'"
  );
  expect(release.jobs.prerelease?.secrets).toBeUndefined();
  expect(release.jobs["create-release"]?.if).toContain(
    "inputs.channel == 'stable'"
  );
  expect(release.jobs["update-homebrew-tap"]?.if).toContain(
    "inputs.channel == 'stable'"
  );
  const prerelease = Bun.YAML.parse(
    await Bun.file(".github/workflows/prerelease.yml").text()
  ) as {
    on: { workflow_call: { inputs: Record<string, { default?: unknown }> } };
    jobs: Record<
      string,
      {
        environment?: string;
        if?: string;
        permissions: { contents: string };
        steps: Array<{ run?: string; env?: Record<string, string> }>;
      }
    >;
  };
  expect(prerelease.on.workflow_call.inputs.publish?.default).toBe(false);
  expect(prerelease.jobs.plan?.permissions.contents).toBe("read");
  expect(prerelease.jobs.build?.permissions.contents).toBe("read");
  expect(prerelease.jobs.publish?.environment).toBe("v5-prerelease");
  expect(prerelease.jobs.publish?.if).toContain("inputs.publish");
  for (const workflow of [release, prerelease]) {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        expect(step.run ?? "").not.toContain("${{");
      }
    }
  }
  expect(JSON.stringify(prerelease)).not.toContain("RELEASE_PAT");
});

test("CI admits next branch pushes while excluding release tags", async () => {
  const ci = Bun.YAML.parse(
    await Bun.file(".github/workflows/ci.yml").text()
  ) as {
    on: { push: { branches?: string[]; "tags-ignore": string[] } };
  };
  expect(
    (ci.on.push.branches ?? []).some((pattern) =>
      new Bun.Glob(pattern).match("next")
    )
  ).toBe(true);
  expect(
    ci.on.push["tags-ignore"].some((pattern) =>
      new Bun.Glob(pattern).match("v5.0.0-next.1")
    )
  ).toBe(true);
});

test("compiled CLI reports the embedded candidate version and ordinary source retains package version", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-prerelease-cli-"));
  try {
    const pkg = await Bun.file("package.json").text();
    const executable = join(root, "hack-cli");
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "index.ts",
        "--compile",
        "--define",
        '__HACK_BUILD_VERSION__="5.0.0-next.22"',
        "--outfile",
        executable,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const errors = await new Response(build.stderr).text();
    expect(await build.exited).toBe(0);
    expect(errors).not.toContain("error:");
    for (const args of [
      [executable, "--version"],
      [executable, "version"],
      [process.execPath, "index.ts", "--version"],
    ]) {
      const child = Bun.spawn(args, {
        env: privateCliEnv({
          root,
          env: {
            HACK_BUILD_VERSION: "wrong",
            __HACK_BUILD_VERSION__: "wrong",
          },
        }),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await new Response(child.stdout).text()).toBe(
        args[0] === executable
          ? "hack v5.0.0-next.22\n"
          : `hack v${JSON.parse(pkg).version}\n`
      );
      expect(await child.exited).toBe(0);
    }
    expect(await Bun.file("package.json").text()).toBe(pkg);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("stable CLI writes only validated version and tag outputs on manual input", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-stable-plan-"));
  try {
    const pkg = await Bun.file("package.json").json();
    const output = join(root, "outputs");
    const env = {
      ...process.env,
      GITHUB_OUTPUT: output,
      RELEASE_CHANNEL: "stable",
      RELEASE_TAG_INPUT: `v${pkg.version}`,
      GITHUB_REF_NAME: "main",
    };
    const success = Bun.spawn(
      [process.execPath, "scripts/prerelease-plan.ts", "stable"],
      { env, stdout: "pipe", stderr: "pipe" }
    );
    expect(await success.exited).toBe(0);
    const expected = `tag=v${pkg.version}\nversion=${pkg.version}\n`;
    expect(await Bun.file(output).text()).toBe(expected);
    const refused = Bun.spawn(
      [process.execPath, "scripts/prerelease-plan.ts", "stable"],
      {
        env: { ...env, RELEASE_TAG_INPUT: "v5.0.0-next.1" },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(await refused.exited).toBe(1);
    expect(await Bun.file(output).text()).toBe(expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Parse the bundle builder's checksum subshell: the authoritative list of files a
 * versioned bundle contains, in `SHA256SUMS` order. Unknown shapes refuse, so a
 * restructured script fails this control instead of silently passing it.
 */
function bundleChecksumContract(script: string) {
  const block = /\n\(\n {2}cd "\$out"\n([\s\S]*?)\n\)\n/.exec(script)?.[1];
  if (!block) {
    throw new Error("Bundle checksum block not found");
  }
  const versioned: string[] = [];
  const unversioned: string[] = [];
  let branch: "both" | "versioned" | "unversioned" = "both";
  for (const line of block.split("\n").map((value) => value.trim())) {
    if (line === 'if [ -n "$version" ]; then' && branch === "both") {
      branch = "versioned";
      continue;
    }
    if (line === "else" && branch === "versioned") {
      branch = "unversioned";
      continue;
    }
    if (line === "fi" && branch === "unversioned") {
      branch = "both";
      continue;
    }
    const command =
      /^shasum -a 256 ([\w.*/-]+(?: [\w.*/-]+)*) (>>?) SHA256SUMS$/.exec(line);
    if (!command?.[1]) {
      throw new Error(`Unrecognized bundle checksum line: ${line}`);
    }
    const names = command[1].split(" ");
    for (const [target, active] of [
      [versioned, branch !== "unversioned"],
      [unversioned, branch !== "versioned"],
    ] as const) {
      if (!active) {
        continue;
      }
      if ((command[2] === ">") !== (target.length === 0)) {
        throw new Error("SHA256SUMS must be created once, then appended");
      }
      target.push(...names);
    }
  }
  if (branch !== "both") {
    throw new Error("Unterminated versioned checksum branch");
  }
  return { versioned, unversioned };
}

test("packager payload is exactly the versioned bundle the builder checksums, in order", async () => {
  const script = await Bun.file(
    new URL("../scripts/build-native-candidate.sh", import.meta.url)
  ).text();
  const { versioned, unversioned } = bundleChecksumContract(script);
  expect(unversioned).toEqual(
    versioned.filter((name) => name !== "prerelease.json")
  );
  // Packaging compares SHA256SUMS byte for byte, so order is part of the contract.
  expect(versioned.filter((name) => !name.startsWith("mcp/"))).toEqual([
    ...PRERELEASE_PAYLOAD,
    ...CONFIG_COMPILER_PAYLOAD,
  ]);
  // nativeCandidateMcpPayload owns this group and returns it in this order.
  expect(versioned.filter((name) => name.startsWith("mcp/"))).toEqual([
    "mcp/*/manifest.json",
    "mcp/*/hack-mcp-adapter",
    "mcp/*/hack-mcp-owner",
    "mcp/*/hack-mcp-backend",
  ]);
  // Anything the script writes into the bundle must also be checksummed.
  for (const [, name] of script.matchAll(/"\$out\/([\w.-]+)"/g)) {
    expect(name === "mcp" || versioned.includes(name ?? "")).toBe(true);
  }
  // Modes the script sets are the modes packaging and installation require.
  const chmods = new Map<string, number>();
  for (const [, mode, targets] of script.matchAll(
    /^chmod ([0-7]{3}) ((?:"\$out\/[\w.-]+" ?)+)$/gm
  )) {
    for (const [, name] of (targets ?? "").matchAll(/"\$out\/([\w.-]+)"/g)) {
      chmods.set(name ?? "", Number.parseInt(mode ?? "", 8));
    }
  }
  for (const [name, mode] of Object.entries(PAYLOAD_MODES)) {
    // package-native-storage-tool.ts creates the manifest 0600; the fixture uses it.
    if (name !== NATIVE_STORAGE_TOOL_MANIFEST) {
      expect([name, chmods.get(name)]).toEqual([name, mode]);
    }
  }
});

test("installer accepts exactly the versioned bundle contract with the packaged modes", async () => {
  const { versioned } = bundleChecksumContract(
    await Bun.file(
      new URL("../scripts/build-native-candidate.sh", import.meta.url)
    ).text()
  );
  const id = "f".repeat(64);
  const names = versioned.map((name) => name.replace("mcp/*/", `mcp/${id}/`));
  const probe = Bun.spawnSync(
    [
      "python3",
      "-I",
      "-B",
      "-c",
      [
        "import importlib.util, json, sys",
        "spec = importlib.util.spec_from_file_location('installer_contract', sys.argv[1])",
        "m = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(m)",
        "names = set(json.loads(sys.argv[2]))",
        "def refused(extra):",
        "    try:",
        "        m.payload_inventory(extra)",
        "    except m.Refusal:",
        "        return True",
        "    return False",
        "print(json.dumps({",
        "    'accepted': sorted(m.payload_inventory(names | {'SHA256SUMS'})),",
        "    'top_level': sorted(m.PAYLOAD | m.COMPILER_PAYLOAD | m.STORAGE_TOOL_PAYLOAD),",
        "    'modes': {name: m.payload_mode(name) for name in sorted(names)},",
        "    'foreign_refused': refused(names | {'SHA256SUMS', 'native-storage-tool.sig'}),",
        "    'storage_partial_refused': [refused(names - {name} | {'SHA256SUMS'})",
        "                                for name in sorted(m.STORAGE_TOOL_PAYLOAD)],",
        "}))",
      ].join("\n"),
      new URL("../scripts/install-prerelease.py", import.meta.url).pathname,
      JSON.stringify(names),
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  expect(probe.stderr.toString()).toBe("");
  expect(probe.exitCode).toBe(0);
  const result = JSON.parse(probe.stdout.toString()) as {
    accepted: string[];
    top_level: string[];
    modes: Record<string, number>;
    foreign_refused: boolean;
    storage_partial_refused: boolean[];
  };
  expect(result.accepted).toEqual([...names].sort());
  expect(result.top_level).toEqual(
    versioned.filter((name) => !name.startsWith("mcp/")).sort()
  );
  for (const [name, mode] of Object.entries(PAYLOAD_MODES)) {
    expect([name, result.modes[name]]).toEqual([name, mode]);
  }
  expect(result.foreign_refused).toBe(true);
  expect(result.storage_partial_refused).toEqual([true, true]);
});

/** GitHub's heading anchor: lowercase, punctuation removed, spaces as hyphens. */
function headingAnchor(heading: string) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replaceAll(" ", "-");
}

/** Body of one Markdown section, up to the next heading at the same or a higher level. */
function markdownSection(markdown: string, heading: string) {
  const lines = markdown.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) {
    throw new Error(`Missing heading ${heading}`);
  }
  const level = heading.indexOf(" ");
  const end = lines.findIndex(
    (line, index) =>
      index > start && /^#+ /.test(line) && line.indexOf(" ") <= level
  );
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

const SUPPORT_HEADING = "## Supported platforms and capabilities";

function prereleaseGuide() {
  return Bun.file(
    new URL("../docs/guides/prereleases.md", import.meta.url)
  ).text();
}

describe("published support list", () => {
  test("release notes link to the support list pinned at the candidate tag", () => {
    const published = createPrereleasePlan({
      ...input,
      version: "5.0.0-next.7",
      publish: "true",
    });
    const notes = prereleaseNotes(published);
    expect(notes).toContain(published.source_revision);
    expect(notes).toContain(
      "https://github.com/hack-dance/hack/blob/v5.0.0-next.7/docs/guides/prereleases.md#supported-platforms-and-capabilities"
    );
    const links = [...notes.matchAll(/https:\/\/\S+/g)].map(
      (match) => match[0]
    );
    expect(links).toHaveLength(1);
    expect(links[0]).not.toMatch(/\/blob\/(?:next|main)\//);
    expect(prereleaseNotes(plan)).toContain(
      "/blob/v5.0.0-next.1/docs/guides/prereleases.md#"
    );
  });

  test("the linked anchor is the guide's support section heading", async () => {
    const anchors = (await prereleaseGuide())
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => headingAnchor(line.slice(3)));
    expect(headingAnchor(SUPPORT_HEADING.slice(3))).toBe(
      PRERELEASE_SUPPORT_ANCHOR
    );
    expect(
      anchors.filter((anchor) => anchor === PRERELEASE_SUPPORT_ANCHOR)
    ).toHaveLength(1);
  });

  test("documented supported platform equals the planned platform constant", async () => {
    const supported = markdownSection(
      markdownSection(await prereleaseGuide(), SUPPORT_HEADING),
      "### Supported platform"
    );
    const documented = [...supported.matchAll(/^- `([^`]+)`/gm)].map(
      (match) => match[1]
    );
    expect(documented).toEqual([PRERELEASE_PLATFORM]);
    expect(prereleaseMetadata(input).platform).toBe(PRERELEASE_PLATFORM);
    expect(plan.archive).toBe(
      `hack-5.0.0-next.1-${PRERELEASE_PLATFORM}-native.tar.gz`
    );
  });

  test("lists unsupported platforms, retired surfaces and linked capability limits", async () => {
    const section = markdownSection(await prereleaseGuide(), SUPPORT_HEADING);
    const unsupported = markdownSection(
      section,
      "### Unsupported platforms and surfaces"
    );
    for (const term of [
      "Intel",
      "Linux",
      "Windows",
      "Remote",
      "gateway",
      "node",
      "dispatch",
      "hosted",
    ]) {
      expect(unsupported).toContain(term);
    }
    const limits = markdownSection(section, "### Candidate capability limits");
    for (const term of [
      "environment overlay, profiles or target",
      "pruning dependency caches",
      "modify source files",
      "Named users or groups",
      "registries other than public Docker Hub",
      "Copied or relocated",
      "Downgrading onto newer state",
    ]) {
      expect(limits).toContain(term);
    }
    const candidate = await Bun.file(
      new URL("../docs/guides/native-candidate.md", import.meta.url)
    ).text();
    const anchors = new Set(
      candidate
        .split("\n")
        .filter((line) => /^#{1,6} /.test(line))
        .map((line) => headingAnchor(line.replace(/^#+ /, "")))
    );
    const items = limits.split("\n- ").slice(1);
    expect(items).toHaveLength(6);
    for (const item of items) {
      const linked = [
        ...item.matchAll(/\(native-candidate\.md#([a-z0-9_-]+)\)/g),
      ].map((match) => match[1]);
      expect(linked).toHaveLength(1);
      expect(anchors.has(linked[0] ?? "")).toBe(true);
    }
  });
});
