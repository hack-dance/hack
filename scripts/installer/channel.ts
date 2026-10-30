import { dlopen, FFIType } from "bun:ffi";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import {
  extractArchive,
  sameJson,
  verifyBundle,
  verifySignatures,
} from "./bundle.ts";
import { officialArchive } from "./download.ts";
import {
  canonical,
  digest,
  exact,
  hash,
  jsonBytes,
  object,
  owned,
  privateJson,
  requireThat,
  SHA256,
  syncDirectory,
  versionNumber,
  writeFile,
} from "./integrity.ts";

const JOURNAL = ".manager-upgrade.json";
const STAGE = /^\.stage-[0-9a-f]{32}$(?![\s\S])/;
/** No compiled predecessor has shipped yet. Add only independently reviewed release digests. */
const REVIEWED_PREDECESSORS: readonly string[] = [];
export const launcherBytes = () =>
  Buffer.from(
    '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd -P)\nif [ "${1-}" = --manager ]; then shift; exec "$root/manager" --root "$root" "$@"; fi\nexec "$root/manager" --root "$root" run -- "$@"\n'
  );
const nonce = () => randomUUID().replaceAll("-", "");
function lexists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
function atomicFile(path: string, bytes: Uint8Array, mode = 0o600) {
  const temporary = join(
    dirname(path),
    `${mode === 0o500 ? ".manager" : ".selection"}-${nonce()}`
  );
  try {
    writeFile(temporary, bytes, mode);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    try {
      if (lexists(temporary)) {
        unlinkSync(temporary);
      }
    } catch {
      /* Preserve the publication failure and any leftover for inspection. */
    }
  }
}
function atomicJson(path: string, value: unknown) {
  atomicFile(path, jsonBytes(value));
}
interface State {
  schema: string;
  installed: Record<string, string>;
  selected: string | null;
  previous: string | null;
}
interface Hooks {
  signatures?: (bundle: string) => void;
  quiescence?: (directory: string, environment: NodeJS.ProcessEnv) => void;
  predecessors?: readonly string[];
  checkpoint?: (point: string) => void;
}
/** One owner for receipts, retained bytes and atomic selection. Hooks are fixture-only injection. */
export class Channel {
  readonly root: string;
  readonly source: string;
  state: State = {
    schema: "hack.prerelease-selection/v1",
    installed: {},
    selected: null,
    previous: null,
  };
  private readonly hooks: Hooks;
  constructor(root: string, source: string, hooks: Hooks = {}) {
    this.root = canonical(root);
    this.source = canonical(source);
    this.hooks = hooks;
  }
  private path(name: string) {
    return join(this.root, name);
  }
  private signatures(bundle: string) {
    (this.hooks.signatures ?? verifySignatures)(bundle);
  }
  initialize() {
    if (!lexists(this.root)) {
      owned(dirname(this.root), true);
      mkdirSync(this.root, { mode: 0o700 });
    }
    owned(this.root, true, 0o700);
    if (lexists(this.path(".channel.json"))) {
      return;
    }
    requireThat(
      readdirSync(this.root).length === 0,
      "Refusing to adopt a nonempty installation root; Python-managed channels need a separate root."
    );
    owned(this.source);
    mkdirSync(this.path("bin"), { mode: 0o700 });
    mkdirSync(this.path("versions"), { mode: 0o700 });
    writeFile(this.path("manager"), readFileSync(this.source), 0o500);
    writeFile(this.path("bin/hack-next"), launcherBytes(), 0o755);
    const info = owned(this.root, true, 0o700);
    writeFile(
      this.path(".channel.json"),
      jsonBytes({
        schema: "hack.prerelease-install/v2",
        root: this.root,
        uid: process.getuid?.(),
        device: info.dev,
        inode: info.ino,
        manager_sha256: digest(this.path("manager")),
        launcher_sha256: digest(this.path("bin/hack-next")),
      })
    );
    writeFile(this.path(".selection.json"), jsonBytes(this.state));
    writeFile(this.path(".manager.lock"), Buffer.alloc(0));
    syncDirectory(this.path("bin"));
    syncDirectory(this.path("versions"));
    syncDirectory(this.root);
  }
  /** Kernel flock is shared for launches, exclusive for mutations, and never waits. */
  lock(shared = false, managerUpgrade = false) {
    owned(this.root, true, 0o700);
    const before = owned(this.path(".manager.lock"), false, 0o600);
    const library = dlopen(
      process.platform === "darwin"
        ? "/usr/lib/libSystem.B.dylib"
        : "libc.so.6",
      { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }
    );
    let fd: number;
    try {
      fd = openSync(
        this.path(".manager.lock"),
        constants.O_RDWR | constants.O_NOFOLLOW
      );
    } catch (error) {
      library.close();
      throw error;
    }
    try {
      requireThat(
        library.symbols.flock(fd, (shared ? 1 : 2) | 4) === 0,
        "Another candidate manager or launcher is active."
      );
      const after = owned(this.path(".manager.lock"), false, 0o600);
      const opened = fstatSync(fd);
      requireThat(
        before.dev === after.dev &&
          before.ino === after.ino &&
          after.dev === opened.dev &&
          after.ino === opened.ino,
        "Manager lock changed."
      );
      this.validate(managerUpgrade);
    } catch (error) {
      closeSync(fd);
      library.close();
      throw error;
    }
    return () => {
      closeSync(fd);
      library.close();
    };
  }
  validate(managerUpgrade = false) {
    const info = owned(this.root, true, 0o700);
    const pending = lexists(this.path(JOURNAL));
    requireThat(
      !pending || managerUpgrade,
      "Manager upgrade is pending; rerun upgrade-manager with the same reviewed installer."
    );
    const transition = pending ? this.readManagerUpgrade() : undefined;
    const marker = privateJson(this.path(".channel.json"));
    exact(marker, [
      "schema",
      "root",
      "uid",
      "device",
      "inode",
      "manager_sha256",
      "launcher_sha256",
    ]);
    requireThat(
      marker.schema === "hack.prerelease-install/v2" &&
        marker.root === this.root &&
        marker.uid === process.getuid?.() &&
        marker.device === info.dev &&
        marker.inode === info.ino,
      "Foreign or malformed installation receipt; Python-managed channels are preserved and require a separate root."
    );
    owned(this.path("manager"), false, 0o500);
    owned(this.path("bin"), true, 0o700);
    owned(this.path("bin/hack-next"), false, 0o755);
    const managerHash = digest(this.path("manager"));
    requireThat(
      (managerHash === marker.manager_sha256 ||
        (transition &&
          managerHash === transition.to_sha256 &&
          marker.manager_sha256 === transition.from_sha256)) &&
        digest(this.path("bin/hack-next")) === marker.launcher_sha256,
      "Installation manager or launcher changed."
    );
    requireThat(
      sameJson(readdirSync(this.path("bin")), ["hack-next"]),
      "Foreign launcher entry."
    );
    owned(this.path("versions"), true, 0o700);
    const state = privateJson(this.path(".selection.json"));
    exact(state, ["schema", "installed", "selected", "previous"]);
    requireThat(
      state.schema === "hack.prerelease-selection/v1",
      "Malformed selection receipt."
    );
    const installed = object(state.installed);
    requireThat(
      Object.keys(installed).length <= 256,
      "Too many candidate versions."
    );
    const validated: Record<string, string> = Object.create(null);
    for (const [version, checksum] of Object.entries(installed)) {
      versionNumber(version);
      requireThat(
        typeof checksum === "string" && SHA256.test(checksum),
        "Malformed receipt hash."
      );
      this.verifyVersion(version, checksum);
      validated[version] = checksum;
    }
    for (const key of ["selected", "previous"]) {
      requireThat(
        state[key] === null ||
          (typeof state[key] === "string" &&
            Object.hasOwn(validated, state[key])),
        "Unknown selected or previous candidate."
      );
    }
    requireThat(
      state.selected === null || state.selected !== state.previous,
      "Malformed candidate history."
    );
    for (const version of readdirSync(this.path("versions"))) {
      if (Object.hasOwn(validated, version)) {
        continue;
      }
      versionNumber(version);
      // An interrupted rename remains unselected, retained and independently validated.
      const receipt = this.path(`versions/${version}/.receipt.json`);
      privateJson(receipt);
      this.verifyVersion(version, digest(receipt));
    }
    const allowed = [
      ".channel.json",
      ".selection.json",
      ".manager.lock",
      "manager",
      "bin",
      "versions",
      ...(transition ? [JOURNAL] : []),
    ];
    for (const name of readdirSync(this.root)) {
      if (allowed.includes(name)) {
        continue;
      }
      if (STAGE.test(name)) {
        owned(this.path(name), true, 0o700);
        continue;
      }
      // A crash while preparing executable replacement may retain an inert partial file.
      // It is never adopted or executed; the journal's validated stage drives recovery.
      if (/^\.manager-[0-9a-f]{32}$(?![\s\S])/.test(name)) {
        owned(this.path(name), false, 0o500);
        continue;
      }
      if (/^\.selection-[0-9a-f]{32}$(?![\s\S])/.test(name)) {
        owned(this.path(name), false, 0o600);
        continue;
      }
      throw new Error(`Foreign installation entry: ${name}`);
    }
    this.state = {
      schema: state.schema,
      installed: validated,
      selected: state.selected as string | null,
      previous: state.previous as string | null,
    };
  }
  verifyVersion(version: string, checksum: string) {
    const directory = this.path(`versions/${version}`);
    owned(directory, true, 0o700);
    requireThat(
      sameJson(
        readdirSync(directory).sort(),
        ["bundle", "native-home", "cli-home", ".receipt.json"].sort()
      ),
      "Incomplete or foreign version installation."
    );
    const path = join(directory, ".receipt.json");
    const receipt = privateJson(path);
    requireThat(
      digest(path) === checksum,
      "Candidate installation receipt changed."
    );
    exact(receipt, [
      "schema",
      "metadata",
      "archive_sha256",
      "checksums",
      "homes",
    ]);
    requireThat(
      receipt.schema === "hack.prerelease-version/v1" &&
        typeof receipt.archive_sha256 === "string" &&
        SHA256.test(receipt.archive_sha256),
      "Malformed version receipt."
    );
    const verified = verifyBundle(join(directory, "bundle"), version);
    requireThat(
      sameJson(receipt.metadata, verified.identity) &&
        sameJson(receipt.checksums, verified.manifest),
      "Candidate identity or checksum receipt changed."
    );
    const homes = object(receipt.homes);
    exact(homes, ["native-home", "cli-home"]);
    for (const name of ["native-home", "cli-home"]) {
      const info = owned(join(directory, name), true, 0o700);
      requireThat(
        sameJson(homes[name], { device: info.dev, inode: info.ino }),
        "Candidate home identity changed."
      );
    }
    return directory;
  }
  environment(version: string, backend = "native"): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HACK_CANDIDATE_ENTRYPOINT: "hack-next",
    };
    if (backend === "compose") {
      environment.HACK_NATIVE_BINARY = undefined;
      environment.HACK_NATIVE_HOME = undefined;
      environment.HACK_RUNTIME_BACKEND = "compose";
      return environment;
    }
    environment.HACK_GLOBAL_CONFIG_PATH = undefined;
    return {
      ...environment,
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: this.path(`versions/${version}/bundle/hack-native`),
      HACK_NATIVE_HOME: this.path(`versions/${version}/native-home`),
      HACK_HOME: this.path(`versions/${version}/cli-home`),
    };
  }
  requireQuiescent(version: string | null, managerUpgrade = false) {
    if (version === null) {
      return;
    }
    this.validate(managerUpgrade);
    const checksum = this.state.installed[version];
    requireThat(checksum, "Unknown candidate version.");
    const directory = this.verifyVersion(version, checksum);
    this.signatures(join(directory, "bundle"));
    if (this.hooks.quiescence) {
      this.hooks.quiescence(directory, this.environment(version));
      return;
    }
    for (const action of ["status", "down", "status"]) {
      const result = Bun.spawnSync(
        [
          join(directory, "bundle/hack-native"),
          "--candidate-root",
          join(directory, "native-home"),
          "runtime",
          action,
          "--json",
        ],
        {
          env: this.environment(version),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        }
      );
      requireThat(
        result.exitCode === 0 && result.stdout.length <= 1024 * 1024,
        "Candidate quiescence check failed; failure never means idle."
      );
      const status = parseJsonStatus(result.stdout);
      requireThat(
        (status.phase === "uninitialized" || status.phase === "stopped") &&
          status.process_alive === false,
        "Candidate runtime is active or ambiguous; selection preserved."
      );
      if (status.phase === "uninitialized") {
        requireThat(
          readdirSync(join(directory, "native-home")).length === 0,
          "Uninitialized home contains state; inspect it through its owning CLI."
        );
      }
      this.validate(managerUpgrade);
    }
  }
  select(version: string | null) {
    this.requireQuiescent(this.state.selected);
    if (version !== null) {
      this.requireQuiescent(version);
    }
    this.validate();
    const state = { ...this.state };
    if (version !== state.selected) {
      state.previous = state.selected;
      state.selected = version;
    }
    atomicJson(this.path(".selection.json"), state);
    this.state = state;
  }
  async install(
    version: string,
    archive?: string,
    checksum?: string,
    upgrade = false
  ) {
    versionNumber(version);
    requireThat(
      Boolean(archive) === Boolean(checksum),
      "--archive and --sha256 must be supplied together."
    );
    if (checksum) {
      requireThat(
        SHA256.test(checksum),
        "Expected archive SHA-256 is required."
      );
    }
    const current = this.state.selected;
    if (Object.hasOwn(this.state.installed, version)) {
      requireThat(
        version === current,
        "Version is already installed; use rollback to select it."
      );
      if (archive) {
        canonical(archive);
        owned(archive);
        requireThat(
          digest(archive) === checksum &&
            checksum ===
              privateJson(this.path(`versions/${version}/.receipt.json`))
                .archive_sha256,
          "Installed version differs from supplied archive."
        );
      }
      return;
    }
    requireThat(
      upgrade || current === null,
      "A candidate is selected; use upgrade with a newer version."
    );
    requireThat(
      current === null || versionNumber(version) > versionNumber(current),
      "Upgrade must increase the prerelease version; use rollback."
    );
    this.requireQuiescent(current);
    const stage = this.path(`.stage-${nonce()}`);
    mkdirSync(stage, { mode: 0o700 });
    const created = lstatSync(stage);
    try {
      const input = archive
        ? { archive: canonical(archive), checksum: checksum as string }
        : await officialArchive(stage, version);
      const installation = join(stage, "installation");
      mkdirSync(installation, { mode: 0o700 });
      const verified = extractArchive({
        ...input,
        destination: join(installation, "bundle"),
        version,
        signatures: (bundle) => this.signatures(bundle),
      });
      requireThat(
        digest(this.path("manager")) === digest(this.source),
        "Retained manager must match this installer; run an explicit reviewed upgrade-manager first."
      );
      const homes: Record<string, { device: number; inode: number }> = {};
      for (const name of ["native-home", "cli-home"]) {
        mkdirSync(join(installation, name), { mode: 0o700 });
        const info = owned(join(installation, name), true, 0o700);
        syncDirectory(join(installation, name));
        homes[name] = { device: info.dev, inode: info.ino };
      }
      writeFile(
        join(installation, ".receipt.json"),
        jsonBytes({
          schema: "hack.prerelease-version/v1",
          metadata: verified.identity,
          archive_sha256: input.checksum,
          checksums: verified.manifest,
          homes,
        })
      );
      syncDirectory(installation);
      this.requireQuiescent(current);
      this.validate();
      const destination = this.path(`versions/${version}`);
      requireThat(
        !lexists(destination),
        "Refusing to overwrite a retained candidate version."
      );
      renameSync(installation, destination);
      syncDirectory(dirname(destination));
      this.hooks.checkpoint?.("version-published");
      const state = {
        ...this.state,
        installed: {
          ...this.state.installed,
          [version]: digest(join(destination, ".receipt.json")),
        },
        selected: version,
        previous: current,
      };
      atomicJson(this.path(".selection.json"), state);
      this.state = state;
    } finally {
      // Only this invocation's stage, with the identity recorded at creation, is ours.
      try {
        const info = lstatSync(stage);
        if (
          info.isDirectory() &&
          info.uid === process.getuid?.() &&
          info.dev === created.dev &&
          info.ino === created.ino
        ) {
          rmSync(stage, { recursive: true });
          syncDirectory(this.root);
        }
      } catch {
        /* Cleanup cannot replace the original failure or undo publication. */
      }
    }
  }
  private readManagerUpgrade() {
    const plan = privateJson(this.path(JOURNAL));
    exact(plan, [
      "schema",
      "stage",
      "from_sha256",
      "to_sha256",
      "channel_sha256",
      "selection_sha256",
    ]);
    requireThat(
      plan.schema === "hack.prerelease-manager-upgrade/v2" &&
        typeof plan.stage === "string" &&
        STAGE.test(plan.stage),
      "Malformed manager upgrade journal."
    );
    for (const key of [
      "from_sha256",
      "to_sha256",
      "channel_sha256",
      "selection_sha256",
    ]) {
      requireThat(
        typeof plan[key] === "string" && SHA256.test(plan[key]),
        "Malformed manager upgrade digest."
      );
    }
    requireThat(
      (this.hooks.predecessors ?? REVIEWED_PREDECESSORS).includes(
        String(plan.from_sha256)
      ) && plan.to_sha256 === digest(this.source),
      "Manager recovery requires the same reviewed installer and a known predecessor."
    );
    const stage = this.path(plan.stage);
    owned(stage, true, 0o700);
    requireThat(
      sameJson(
        readdirSync(stage).sort(),
        [
          "manager-before",
          "manager-after",
          "channel-before.json",
          "channel-after.json",
        ].sort()
      ),
      "Foreign manager upgrade staging entry."
    );
    for (const name of readdirSync(stage)) {
      owned(join(stage, name), false, 0o600);
    }
    const before = privateJson(join(stage, "channel-before.json"));
    const after = privateJson(join(stage, "channel-after.json"));
    requireThat(
      digest(join(stage, "manager-before")) === plan.from_sha256 &&
        digest(join(stage, "manager-after")) === plan.to_sha256 &&
        digest(join(stage, "channel-before.json")) === plan.channel_sha256 &&
        before.manager_sha256 === plan.from_sha256 &&
        sameJson(after, { ...before, manager_sha256: plan.to_sha256 }),
      "Manager upgrade staging changed."
    );
    owned(this.path("manager"), false, 0o500);
    privateJson(this.path(".channel.json"));
    privateJson(this.path(".selection.json"));
    const currentHash = digest(this.path("manager"));
    const current = readFileSync(this.path(".channel.json"));
    const oldReceipt = readFileSync(join(stage, "channel-before.json"));
    const newReceipt = readFileSync(join(stage, "channel-after.json"));
    requireThat(
      (currentHash === plan.from_sha256 && current.equals(oldReceipt)) ||
        (currentHash === plan.to_sha256 &&
          (current.equals(oldReceipt) || current.equals(newReceipt))),
      "Manager upgrade publication state changed."
    );
    requireThat(
      digest(this.path(".selection.json")) === plan.selection_sha256,
      "Selection changed during manager upgrade; inspection required."
    );
    owned(this.path("bin"), true, 0o700);
    owned(this.path("bin/hack-next"), false, 0o755);
    requireThat(
      readFileSync(this.path("bin/hack-next")).equals(launcherBytes()),
      "Custom launcher cannot be upgraded."
    );
    return plan;
  }
  upgradeManager() {
    this.validate(true);
    const pending = lexists(this.path(JOURNAL));
    owned(this.source);
    const target = readFileSync(this.source);
    const targetHash = hash(target);
    const currentHash = digest(this.path("manager"));
    if (!pending) {
      if (currentHash === targetHash) {
        return;
      }
      requireThat(
        (this.hooks.predecessors ?? REVIEWED_PREDECESSORS).includes(
          currentHash
        ),
        "Unknown or customized manager; explicit upgrade supports only reviewed predecessors."
      );
      requireThat(
        readFileSync(this.path("bin/hack-next")).equals(launcherBytes()),
        "Custom launcher cannot be upgraded."
      );
    }
    for (const version of Object.keys(this.state.installed)) {
      this.requireQuiescent(version, true);
    }
    this.validate(true);
    if (!pending) {
      const stage = this.path(`.stage-${nonce()}`);
      mkdirSync(stage, { mode: 0o700 });
      const before = readFileSync(this.path(".channel.json"));
      const after = {
        ...privateJson(this.path(".channel.json")),
        manager_sha256: targetHash,
      };
      writeFile(
        join(stage, "manager-before"),
        readFileSync(this.path("manager"))
      );
      writeFile(join(stage, "manager-after"), target);
      writeFile(join(stage, "channel-before.json"), before);
      writeFile(join(stage, "channel-after.json"), jsonBytes(after));
      const plan = {
        schema: "hack.prerelease-manager-upgrade/v2",
        stage: stage.split("/").at(-1),
        from_sha256: currentHash,
        to_sha256: targetHash,
        channel_sha256: hash(before),
        selection_sha256: digest(this.path(".selection.json")),
      };
      writeFile(join(stage, "journal.json"), jsonBytes(plan));
      syncDirectory(stage);
      this.validate();
      renameSync(join(stage, "journal.json"), this.path(JOURNAL));
      syncDirectory(stage);
      syncDirectory(this.root);
      this.hooks.checkpoint?.("upgrade-journal");
    }
    this.validate(true);
    const plan = this.readManagerUpgrade();
    const stage = this.path(String(plan.stage));
    if (digest(this.path("manager")) !== targetHash) {
      atomicFile(
        this.path("manager"),
        readFileSync(join(stage, "manager-after")),
        0o500
      );
    }
    this.hooks.checkpoint?.("upgrade-manager");
    this.validate(true);
    if (
      !readFileSync(this.path(".channel.json")).equals(
        readFileSync(join(stage, "channel-after.json"))
      )
    ) {
      atomicFile(
        this.path(".channel.json"),
        readFileSync(join(stage, "channel-after.json"))
      );
    }
    this.hooks.checkpoint?.("upgrade-receipt");
    this.validate(true);
    unlinkSync(this.path(JOURNAL));
    syncDirectory(this.root);
    this.validate();
  }
  async run(arguments_: string[]) {
    const backend = process.env.HACK_RUNTIME_BACKEND || "native";
    requireThat(
      backend === "native" || backend === "compose",
      "HACK_RUNTIME_BACKEND must be native or compose (unset selects native)."
    );
    const version = this.state.selected;
    requireThat(
      version !== null,
      "No candidate selected. Use your ordinary stable hack command."
    );
    const checksum = this.state.installed[version];
    requireThat(checksum, "Missing selected receipt.");
    const directory = this.verifyVersion(version, checksum);
    this.signatures(join(directory, "bundle"));
    const child = Bun.spawn(
      [
        join(
          directory,
          backend === "compose" ? "bundle/hack-cli" : "bundle/hack-v5"
        ),
        ...arguments_,
      ],
      {
        env: this.environment(version, backend),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }
    );
    const handlers = new Map<NodeJS.Signals, () => void>();
    try {
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        const forward = () => child.kill(signal);
        handlers.set(signal, forward);
        process.on(signal, forward);
      }
      const code = await child.exited;
      if (child.signalCode) {
        return 128 + (osConstants.signals[child.signalCode] ?? 0);
      }
      return code;
    } finally {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    }
  }
}

import { parseJson as parseJsonStatus } from "./integrity.ts";
