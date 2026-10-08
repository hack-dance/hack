import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  nativeNetworkFixtureAttachmentMatches,
  nativeNetworkFixtureCreateArgs,
  nativeNetworkFixtureHasNoPublication,
  nativeNetworkFixtureInventory,
  nativeNetworkFixtureNetworkMatches,
  nativeNetworkFixtureProtocolMatches,
  nativeNetworkFixtureRefusalDiagnostic,
  nativeNetworkFixtureShim,
  nativeNetworkFixtureStateRefused,
  nativeNetworkFixtureVolumeMatches,
  nativeNetworkFixtureVolumeSelectionMatches,
  provisionNativeNetworkFixtureComposePlugin,
  runNativeNetworkFixtureCommand,
} from "./e2e/native-config-networks-acceptance.ts";

test("foreign endpoint admission requires the structured redacted state error", () => {
  const message =
    "Native Compose state is unsafe or changed; values omitted. Inspect owned state before recovery.";
  expect(
    nativeNetworkFixtureStateRefused({
      ok: false,
      error: { code: "E_CONFIG_INVALID", message },
    })
  ).toBe(true);
  for (const value of [
    null,
    message,
    { ok: true, error: { code: "E_CONFIG_INVALID", message } },
    { ok: false, error: { code: "E_STARTUP_INCOMPLETE", message } },
    { ok: false, error: { code: "E_CONFIG_INVALID", message: "ownership" } },
    {
      ok: false,
      error: { code: "E_CONFIG_INVALID", message: `${message} extra` },
    },
    { ok: false, error: { code: "E_CONFIG_INVALID" } },
    { ok: false, error: null },
  ]) {
    expect(nativeNetworkFixtureStateRefused(value)).toBe(false);
  }
});

test("refusal failure evidence distinguishes its fixed stage and both original checks", () => {
  const result = nativeNetworkFixtureRefusalDiagnostic({
    stage: "disconnected_endpoint",
    fragmentPresent: false,
    dockerInvoked: true,
  });
  expect(result).toContain('"stage":"disconnected_endpoint"');
  expect(result).toContain('"fragmentPresent":false');
  expect(result).toContain('"dockerInvoked":true');
});

test("refusal diagnostics never print untrusted labels or non-boolean values", () => {
  const secret = "external-secret-must-not-appear";
  for (const value of [
    { stage: secret, fragmentPresent: false, dockerInvoked: false },
    { stage: "unrouted_run", fragmentPresent: secret, dockerInvoked: false },
    { stage: "unrouted_run", fragmentPresent: false, dockerInvoked: secret },
  ]) {
    const result = nativeNetworkFixtureRefusalDiagnostic(
      value as Parameters<typeof nativeNetworkFixtureRefusalDiagnostic>[0]
    );
    expect(result).toBe("Network refusal diagnostic unavailable");
    expect(result).not.toContain(secret);
  }
});

async function withPluginFixture(
  run: (opts: {
    path: string;
    expectedHash: string;
    dockerConfig: string;
  }) => Promise<void>
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fixture-plugin-")));
  try {
    const path = join(root, "installed-compose");
    const dockerConfig = join(root, "docker-config");
    const source = "#!/bin/sh\nprintf '%s\\n' '2.40.3'\n";
    await writeFile(path, source, { mode: 0o700 });
    await mkdir(dockerConfig, { mode: 0o700 });
    await writeFile(join(dockerConfig, "config.json"), "{}\n", { mode: 0o600 });
    await run({
      path,
      expectedHash: createHash("sha256").update(source).digest("hex"),
      dockerConfig,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("private Compose registration uses only the pinned canonical binary and preserves empty auth config", async () => {
  await withPluginFixture(async (opts) => {
    const pin = await provisionNativeNetworkFixtureComposePlugin(opts);
    const installed = join(opts.dockerConfig, "cli-plugins", "docker-compose");
    expect(pin.path).toBe(opts.path);
    expect(pin.sha256).toBe(opts.expectedHash);
    expect(pin.registeredPath).toBe(installed);
    expect((await lstat(installed)).isSymbolicLink()).toBe(true);
    expect(await readlink(installed)).toBe(opts.path);
    expect(await readFile(join(opts.dockerConfig, "config.json"), "utf8")).toBe(
      "{}\n"
    );
  });
});

test("private Compose plugin registration preserves multicall basename dispatch", async () => {
  await withPluginFixture(async (opts) => {
    const source =
      '#!/bin/sh\ncase "$0" in */docker-compose) printf "%s\\n" "5.1.2" ;; *) exit 23 ;; esac\n';
    await writeFile(opts.path, source);
    const plugin = await provisionNativeNetworkFixtureComposePlugin({
      ...opts,
      expectedHash: createHash("sha256").update(source).digest("hex"),
    });
    const execute = (path: string) =>
      runNativeNetworkFixtureCommand({
        argv: [path, "version", "--short"],
        cwd: dirname(opts.path),
        env: { PATH: "/usr/bin:/bin" },
        captures: join(dirname(opts.path), "captures"),
      });
    expect((await execute(plugin.path)).exitCode).toBe(23);
    const observed = await execute(plugin.registeredPath);
    expect(observed.exitCode).toBe(0);
    expect(observed.stdout).toBe("5.1.2\n");
  });
});

test("Compose registration refuses a wrong binary hash before creating a plugin directory", async () => {
  await withPluginFixture(async (opts) => {
    await expect(
      provisionNativeNetworkFixtureComposePlugin({
        ...opts,
        expectedHash: "f".repeat(64),
      })
    ).rejects.toThrow("identity/hash qualification failed");
    expect(
      await Bun.file(join(opts.dockerConfig, "cli-plugins")).exists()
    ).toBe(false);
  });
});

test.each([
  "symlink",
  "hardlink",
])("Compose registration refuses an unqualified %s executable", async (kind) => {
  await withPluginFixture(async (opts) => {
    const path = `${opts.path}-alias`;
    if (kind === "symlink") {
      await symlink(opts.path, path);
    } else {
      await link(opts.path, path);
    }
    await expect(
      provisionNativeNetworkFixtureComposePlugin({ ...opts, path })
    ).rejects.toThrow("Fixture artifact");
    expect(
      await Bun.file(join(opts.dockerConfig, "cli-plugins")).exists()
    ).toBe(false);
  });
});

test.each([
  "symlink",
  "permissions",
])("Compose registration refuses unsafe private-config %s", async (kind) => {
  await withPluginFixture(async (opts) => {
    let dockerConfig = opts.dockerConfig;
    if (kind === "symlink") {
      dockerConfig = `${dockerConfig}-alias`;
      await symlink(opts.dockerConfig, dockerConfig);
    } else {
      await chmod(dockerConfig, 0o755);
    }
    await expect(
      provisionNativeNetworkFixtureComposePlugin({ ...opts, dockerConfig })
    ).rejects.toThrow("canonical private fixture config");
    expect(
      await Bun.file(join(opts.dockerConfig, "cli-plugins")).exists()
    ).toBe(false);
  });
});

test("Compose registration refuses an existing plugin path and preserves its bytes", async () => {
  await withPluginFixture(async (opts) => {
    const path = join(opts.dockerConfig, "cli-plugins");
    await writeFile(path, "unowned-plugin-path");
    await expect(
      provisionNativeNetworkFixtureComposePlugin(opts)
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("unowned-plugin-path");
  });
});

const PROJECT = "com.docker.compose.project";
const INSTANCE = "io.hack.native-config.instance";
const OWNER = "io.hack.native-config.owner";
const VERSION = "io.hack.native-config.version";
const STORAGE = "io.hack.native-config.storage";
const project = "hack-native-fixture";
const owner = "b".repeat(32);
const labels = {
  [PROJECT]: project,
  [INSTANCE]: project,
  [OWNER]: owner,
  [VERSION]: "1",
};
const volumePin = {
  name: "hack-native-fixture_state",
  createdAt: "2026-10-08T00:00:00Z",
  storage: "state",
  project,
  owner,
};
const networkPin = {
  name: "hack-net-fixture-outbound",
  id: "a".repeat(64),
  createdAt: "2026-10-08T00:00:00Z",
  internal: false,
  project,
  owner,
};

function volume() {
  return {
    Name: volumePin.name,
    CreatedAt: volumePin.createdAt,
    Driver: "local",
    Labels: { ...labels, [STORAGE]: "state" },
  };
}
function network() {
  return {
    Id: networkPin.id,
    Name: networkPin.name,
    Created: networkPin.createdAt,
    Driver: "bridge",
    Internal: false,
    Labels: { ...labels },
    Containers: {},
  };
}

test("network fixture admits all required own version-one protocol capabilities", () => {
  const value = {
    transport_version: 1,
    authored_version: 1,
    plan_version: 1,
    resolve_version: 1,
    local_version: 1,
    env_plan_version: 1,
    endpoint_plan_version: 1,
    process_plan_version: 1,
    acquisition_plan_version: 1,
    network_plan_version: 1,
  };
  expect(nativeNetworkFixtureProtocolMatches(value)).toBe(true);
  for (const key of Object.keys(value)) {
    const dropped: Record<string, unknown> = { ...value };
    delete dropped[key];
    expect(nativeNetworkFixtureProtocolMatches(dropped)).toBe(false);
    expect(nativeNetworkFixtureProtocolMatches({ ...value, [key]: 2 })).toBe(
      false
    );
  }
  expect(nativeNetworkFixtureProtocolMatches(Object.create(value))).toBe(false);
  expect(nativeNetworkFixtureProtocolMatches(null)).toBe(false);
});

test("retained volume requires exact singleton selection even after saved stop", () => {
  expect(
    nativeNetworkFixtureVolumeSelectionMatches([volumePin.name], volumePin)
  ).toBe(true);
  expect(nativeNetworkFixtureVolumeSelectionMatches([], volumePin)).toBe(false);
  expect(
    nativeNetworkFixtureVolumeSelectionMatches(
      [volumePin.name, "extra"],
      volumePin
    )
  ).toBe(false);
  expect(
    nativeNetworkFixtureVolumeSelectionMatches(["replacement"], volumePin)
  ).toBe(false);
  expect(nativeNetworkFixtureVolumeSelectionMatches([], null)).toBe(true);
  expect(
    nativeNetworkFixtureVolumeSelectionMatches([volumePin.name], null)
  ).toBe(false);
});

test.each([
  { Name: "replacement" },
  { CreatedAt: "2026-10-09T00:00:00Z" },
  { Driver: "remote" },
  { Labels: { ...labels, [STORAGE]: "wrong" } },
  { Labels: { ...labels, [OWNER]: "c".repeat(32), [STORAGE]: "state" } },
  { Labels: Object.create({ ...labels, [STORAGE]: "state" }) },
])("volume effect fence refuses creation/name/storage/owner drift (%#)", (change) => {
  expect(nativeNetworkFixtureVolumeMatches(volume(), volumePin)).toBe(true);
  expect(
    nativeNetworkFixtureVolumeMatches({ ...volume(), ...change }, volumePin)
  ).toBe(false);
});

test.each([
  { Id: "c".repeat(64) },
  { Name: "replacement" },
  { Created: "2026-10-09T00:00:00Z" },
  { Driver: "host" },
  { Internal: true },
  { Labels: { ...labels, [OWNER]: "d".repeat(32) } },
  { Labels: Object.create(labels) },
  { Containers: { constructor: {} } },
  { Containers: null },
])("network deletion fence refuses nonempty, replaced or wrong-policy bridge (%#)", (change) => {
  expect(nativeNetworkFixtureNetworkMatches(network(), networkPin, true)).toBe(
    true
  );
  expect(
    nativeNetworkFixtureNetworkMatches(
      { ...network(), ...change },
      networkPin,
      true
    )
  ).toBe(false);
});

test("actual aliases bind the exact reciprocal network ID with no extra alias", () => {
  const aliases = ["fixture-web-1", "web", "web-alias"];
  const check = (value: unknown, created = false) =>
    nativeNetworkFixtureAttachmentMatches({
      value,
      networkId: networkPin.id,
      aliases,
      created,
    });
  expect(
    check({ NetworkID: networkPin.id, Aliases: [...aliases].reverse() })
  ).toBe(true);
  expect(check({ NetworkID: "c".repeat(64), Aliases: aliases })).toBe(false);
  expect(
    check({ NetworkID: networkPin.id, Aliases: [...aliases, "extra"] })
  ).toBe(false);
  expect(
    check({ NetworkID: networkPin.id, Aliases: ["web", "web-alias"] })
  ).toBe(false);
  expect(
    check(Object.create({ NetworkID: networkPin.id, Aliases: aliases }))
  ).toBe(false);
  expect(
    check({ NetworkID: networkPin.id, Aliases: [...aliases, "web"] })
  ).toBe(false);
});

test("created recovery admits empty NetworkID with null, empty or configured aliases without admitting ready emptiness", () => {
  const aliases = ["fixture-web-1", "web", "web-alias"];
  for (const wireAliases of [null, [], aliases]) {
    const value = { NetworkID: "", Aliases: wireAliases };
    expect(
      nativeNetworkFixtureAttachmentMatches({
        value,
        networkId: networkPin.id,
        aliases,
        created: true,
      })
    ).toBe(true);
    expect(
      nativeNetworkFixtureAttachmentMatches({
        value,
        networkId: networkPin.id,
        aliases,
        created: false,
      })
    ).toBe(false);
  }
  expect(
    nativeNetworkFixtureAttachmentMatches({
      value: { NetworkID: "", Aliases: ["foreign"] },
      networkId: networkPin.id,
      aliases,
      created: true,
    })
  ).toBe(false);
  expect(
    nativeNetworkFixtureAttachmentMatches({
      value: { NetworkID: "c".repeat(64), Aliases: aliases },
      networkId: networkPin.id,
      aliases,
      created: true,
    })
  ).toBe(false);
});

test("network inventory requests complete physical IDs from the engine", async () => {
  const id = "a".repeat(64);
  const calls: string[][] = [];
  const values = await nativeNetworkFixtureInventory(
    (args) => {
      calls.push([...args]);
      return Promise.resolve(
        args.includes("--no-trunc") ? id : id.slice(0, 12)
      );
    },
    "network",
    project
  );
  expect(values).toEqual([id]);
  expect(calls).toEqual([
    [
      "network",
      "ls",
      "-q",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
  ]);
});

test.each([
  "a".repeat(12),
  "A".repeat(64),
  `sha256:${"a".repeat(64)}`,
  `${"a".repeat(64)}\n${"a".repeat(64)}`,
  `${"a".repeat(64)}\nnot-an-id`,
])("network inventory refuses malformed or truncated response %s", async (reply) => {
  await expect(
    nativeNetworkFixtureInventory(
      (args) => {
        expect(args).toContain("--no-trunc");
        return Promise.resolve(reply);
      },
      "network",
      project
    )
  ).rejects.toThrow("unique physical identities");
});

test("container inventory retains its full-ID command and validation", async () => {
  const id = "a".repeat(64);
  const calls: string[][] = [];
  expect(
    await nativeNetworkFixtureInventory(
      (args) => {
        calls.push([...args]);
        return Promise.resolve(id);
      },
      "container",
      project
    )
  ).toEqual([id]);
  expect(calls).toEqual([
    [
      "container",
      "ls",
      "-aq",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
  ]);
  await expect(
    nativeNetworkFixtureInventory(
      () => Promise.resolve(id.slice(0, 12)),
      "container",
      project
    )
  ).rejects.toThrow("unique physical identities");
});

test("volume inventory preserves legitimate names and its original invocation", async () => {
  const names = ["shared-deps", "a".repeat(12)];
  const calls: string[][] = [];
  expect(
    await nativeNetworkFixtureInventory(
      (args) => {
        calls.push([...args]);
        return Promise.resolve(names.join("\n"));
      },
      "volume",
      project
    )
  ).toEqual([...names].sort());
  expect(calls).toEqual([
    [
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
  ]);
  await expect(
    nativeNetworkFixtureInventory(
      () => Promise.resolve(`${names[0]}\n${names[0]}`),
      "volume",
      project
    )
  ).rejects.toThrow("unique physical identities");
});

test("empty inventories remain valid for exact absence checks", async () => {
  for (const kind of ["container", "network", "volume"] as const) {
    expect(
      await nativeNetworkFixtureInventory(
        () => Promise.resolve(""),
        kind,
        project
      )
    ).toEqual([]);
  }
});

test("controlled created interruption rewrites only the exact admitted product up argv", () => {
  const args = [
    "compose",
    "-p",
    project,
    "-f",
    "/owned/generation/compose.json",
    "up",
    "-d",
    "--remove-orphans",
  ];
  expect(nativeNetworkFixtureCreateArgs(args, project)).toEqual([
    ...args.slice(0, 5),
    "create",
    "--no-build",
    "--pull",
    "never",
  ]);
  for (const changed of [
    args.slice(0, 7),
    [...args.slice(0, 6), "--remove-orphans", "-d"],
    [...args, "web"],
    [...args.slice(0, -1), "--force-recreate"],
    ["compose", "-p", "foreign", ...args.slice(3)],
    [...args.slice(0, 4), "relative/compose.json", ...args.slice(5)],
    [...args.slice(0, 4), "/owned/override.yaml", ...args.slice(5)],
    [...args.slice(0, 5), "run", "-d"],
    ["container", "rm", "-f", networkPin.id],
  ]) {
    expect(nativeNetworkFixtureCreateArgs(changed, project)).toBeNull();
  }
});

test("generated create shim matches the strict argv oracle without calling Docker", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-network-create-shim-"))
  );
  const receipt = join(root, "receipt");
  const calls = join(root, "engine-call.json");
  try {
    const engine = join(root, "synthetic-engine");
    await writeFile(
      engine,
      `#!${process.execPath}\nawait Bun.write(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o700 }
    );
    const document = join(root, "compose.json");
    await writeFile(
      document,
      JSON.stringify({
        services: Object.fromEntries(
          ["web", "peer", "vault", "reader"].map((name) => [
            name,
            {
              labels: {
                "io.hack.native-config.owner": owner,
                "io.hack.native-config.instance": project,
              },
            },
          ])
        ),
      }),
      { mode: 0o600 }
    );
    const shim = await nativeNetworkFixtureShim({
      root: join(root, "shim"),
      engine,
      bun: process.execPath,
      identity: {
        checkoutRoot: root,
        repositoryRoot: root,
        instance: null,
        instanceId: "a".repeat(64),
        composeProject: project,
        ownerToken: owner,
      },
      create: true,
      receipt,
    });
    const args = [
      "compose",
      "-p",
      project,
      "-f",
      document,
      "up",
      "-d",
      "--remove-orphans",
    ];
    const invoke = (argv: readonly string[]) =>
      runNativeNetworkFixtureCommand({
        argv: [join(shim, "docker"), ...argv],
        cwd: root,
        env: {},
        captures: join(root, "captures"),
        timeoutMs: 30_000,
      });
    for (const changed of [
      args.slice(0, 7),
      [...args.slice(0, 6), "--remove-orphans", "-d"],
      [...args, "web"],
      [...args.slice(0, 7), "--force-recreate"],
      ["compose", "-p", "foreign", ...args.slice(3)],
      [...args.slice(0, 4), "relative/compose.json", ...args.slice(5)],
      [...args.slice(0, 4), "/owned/override.yaml", ...args.slice(5)],
    ]) {
      expect(nativeNetworkFixtureCreateArgs(changed, project)).toBeNull();
      expect((await invoke(changed)).exitCode).toBe(98);
      expect(await Bun.file(receipt).exists()).toBe(false);
      expect(await Bun.file(calls).exists()).toBe(false);
    }
    expect((await invoke(args)).exitCode).toBe(71);
    expect(await Bun.file(receipt).text()).toBe("create-admitted");
    const actualCall = await Bun.file(calls).text();
    expect(JSON.parse(actualCall)).toEqual(
      nativeNetworkFixtureCreateArgs(args, project)
    );
    expect((await invoke(args)).exitCode).toBe(98);
    expect(await Bun.file(calls).text()).toBe(actualCall);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication verifier permits exposed-unpublished ports and refuses host bindings or unexpected keys", () => {
  for (const value of [
    null,
    {},
    { "3000/tcp": null },
    { "80/tcp": null, "443/tcp": null },
  ]) {
    expect(nativeNetworkFixtureHasNoPublication(value)).toBe(true);
  }
  for (const value of [
    undefined,
    [],
    { "3000/tcp": [] },
    { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3000" }] },
    { constructor: null },
  ]) {
    expect(nativeNetworkFixtureHasNoPublication(value)).toBe(false);
  }
});

test("bounded private capture preserves literal argv, rejects inherited caller credentials and returns exit17", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-network-capture-"));
  const previous = process.env.CALLER_PRIVATE;
  process.env.CALLER_PRIVATE = "synthetic-private-caller-control";
  try {
    const result = await runNativeNetworkFixtureCommand({
      argv: [
        process.execPath,
        "-e",
        "if(process.env.CALLER_PRIVATE)process.exit(23);console.log(JSON.stringify(process.argv.slice(-2)));process.exit(17)",
        "--",
        "space arg",
        "$HOME",
      ],
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      captures: join(root, "captures"),
    });
    expect(result.exitCode).toBe(17);
    expect(result.stdout.trim()).toBe('["space arg","$HOME"]');
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "CALLER_PRIVATE");
    } else {
      process.env.CALLER_PRIVATE = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("capture output overflow fails rather than returning a truncated green command", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-network-output-"));
  try {
    await expect(
      runNativeNetworkFixtureCommand({
        argv: [
          process.execPath,
          "-e",
          'process.stdout.write("x".repeat(20000))',
        ],
        cwd: root,
        env: {},
        captures: join(root, "captures"),
        outputLimit: 1024,
      })
    ).rejects.toThrow("output bound");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture timeout reaps the owned descendant group and retains failure evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-network-timeout-"));
  const marker = join(root, "escaped");
  try {
    await expect(
      runNativeNetworkFixtureCommand({
        argv: [
          "/bin/sh",
          "-c",
          '(sleep 1; printf escaped > "$1") & wait',
          "fixture",
          marker,
        ],
        cwd: root,
        env: {},
        captures: join(root, "captures"),
        timeoutMs: 150,
      })
    ).rejects.toThrow("timed out");
    await Bun.sleep(1100);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owned parent completion cannot leave a delayed background child writing a marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-network-orphan-"));
  const marker = join(root, "escaped");
  try {
    const result = await runNativeNetworkFixtureCommand({
      argv: [
        "/bin/sh",
        "-c",
        '(sleep 1; printf escaped > "$1") & exit 0',
        "fixture",
        marker,
      ],
      cwd: root,
      env: {},
      captures: join(root, "captures"),
      timeoutMs: 2000,
    });
    expect(result.exitCode).toBe(0);
    await Bun.sleep(1100);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture failure kills and reaps the owned command before allowing fixture cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-network-capture-failure-"));
  const marker = join(root, "escaped");
  try {
    await expect(
      runNativeNetworkFixtureCommand({
        argv: [
          "/bin/sh",
          "-c",
          '(sleep 1; printf escaped > "$1") & printf capture; wait',
          "fixture",
          marker,
        ],
        cwd: root,
        env: {},
        captures: join(root, "captures"),
        timeoutMs: 2000,
        afterCaptureWrite: () => {
          throw new Error("synthetic capture failure");
        },
      })
    ).rejects.toThrow("capture failed after owned command reap");
    await Bun.sleep(1100);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
