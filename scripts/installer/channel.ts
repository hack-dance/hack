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
import { basename, dirname, join } from "node:path";
import { quoteShellWord } from "../../src/lib/logs.ts";
import { subprocessSignalExitStatus } from "../../src/lib/subprocess-signal.ts";
import {
  extractArchive,
  sameJson,
  verifyBundle,
  verifySignatures,
} from "./bundle.ts";
import { officialArchive } from "./download.ts";
import {
  type BundlePlatform,
  candidateVersion,
  canonical,
  compareCandidateVersions,
  composeOnly,
  DEFAULT_BUNDLE_PLATFORM,
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
  writeFile,
} from "./integrity.ts";
import {
  isFreshInitializerStage,
  publishAndSync,
  publishDirectoryExclusive,
} from "./publication.ts";

const JOURNAL = ".manager-upgrade.json";
const STAGE = /^\.stage-[0-9a-f]{32}$(?![\s\S])/;
/**
 * The compiled managers that have shipped, by the sha256 each release lists for
 * `hack-next-manager-darwin-arm64` in its `INSTALLER-SHA256SUMS`. `upgrade-manager`
 * replaces only these. A channel root holds a byte copy of the manager that
 * installed it, so its digest is the release's. Add each new release's manager
 * when it publishes; the prerelease upgrade gate fails until a successor accepts
 * the previous release's manager (HACK-2262). Linux managers
 * (`hack-next-manager-linux-x86_64`, `-arm64`, listed in `SHA256SUMS-linux`)
 * go in the same list from the first release that ships them.
 */
export const REVIEWED_PREDECESSORS: readonly string[] = [
  // 5.0.0-next.6 and next.7
  "ed606f521e36685d33657d91eed171cd612e6e66e3d83bdfa773a3aaeaf4fd71",
  // 5.0.0-next.8 to next.12
  "e6c667aa32bc345b3a58bc487f0c9a4a6e4fb68d2ae9a35f2bbbbf745a5a4f05",
  // 5.0.0-next.13 to next.16
  "3feb7cef0d1eff57ae54d2ee031fca2e769c9610acab3a04079b7b75cee81e3d",
  // 5.0.0-next.17
  "85bbe4f064b3277efc88a9f79c197e81950ab8881320aef1b3443b70d95b530f",
  // 5.0.0-next.18
  "90d1bc60bfd2b7eaad48dcf56ad45264f395c0ac1a8c4530e986be7fa194d4d9",
  // 5.0.0-next.19
  "ba47091559a80b2abbb246b8e86c5530b8ddb068973f5136e120d36e2003fae6",
  // 5.0.0-next.20
  "2e9183b4ce7b4c4c5659f9ae33677699e1cdc9f5553e1b668bbbe6ea6846ac7b",
  // 5.0.0-next.21
  "af7d25e2db3e5d0edf8d0e308a49db928f1bc7f138beb54b9d3b0ccae83ee423",
  // 5.0.0-next.22
  "df75f28ef2fdd892e9d17f5528171117488b426a2fe9140ac3dd9add924ae45a",
  // 5.0.0-next.23: darwin-arm64, then linux-x86_64 and linux-arm64
  "c9cc02744bf801986f8962699fe633566790cb3a6e7bfff2beb0536107a56b66",
  "e946ba95a49018b0eff8ff81161d1ccf1a086627773e62a30db53e4e94c9195b",
  "be1599a85cd4251df4a9779f2e7fa16480094ebb48ec97ca4e9dad6dd73d0094",
  // 5.0.0-next.24: darwin-arm64, then linux-x86_64 and linux-arm64
  "892c4cdf3a99e309df4b4d406f7e76e2b422b72f4dd2a47bef1f0b36dd29ee27",
  "00e6e01b05bd6f05ac32a41ab06b7309767d701653b220ede5148c2ffb66388c",
  "f52beab69e5ec62e237da74ae64a0cdef7887bcae51380ca6a0270e4b45e4d27",
  // 5.0.0-next.25: darwin-arm64, then linux-x86_64 and linux-arm64
  "dfba3ea7bfcfbeffd5de38e0d3b0818657912764cd184d949e04deec00edb153",
  "6219e16a7b2d3eb83eaa440315829c4d77fb20af0f74664d04d8491899ea6404",
  "a07bd7d5cd8cf6c0788c1ab2d9cd29d481850e73065709683d3c2c372182fbc4",
  // 5.0.0-next.26: darwin-arm64, then linux-x86_64 and linux-arm64
  "8467fe1b4ff48074ab1fd8d1ad96dcbc9f72639de9432dae59b1817fa9f97748",
  "03a03c78db05cfe0e60504e6cdbc27816398fdd310a984fa09058f037c966179",
  "3a4c3eca6e3c6df615342a3e4b39ac2dae2dd74d6b74e001595d87f7d244e4d9",
  // 5.0.0-next.27: darwin-arm64, then linux-x86_64 and linux-arm64
  "a6d93f87e701383de9341fa08aa9df1cce029f8dd44d03cac0e5b68ee6d93152",
  "22d201e99bb4d31aead14b0685c8853f38fce6167a2f5ea8940da5d44fbbe946",
  "61ec352c6dd8c09830f29bbf53e8acec262e0e0d001d2664fa64ca14cfdcc849",
  // 5.0.0-next.28: darwin-arm64, then linux-x86_64 and linux-arm64
  "90bf732b23d413df314352632b8808cc191e3681543746ce2e81ccbf0ad4d894",
  "44769f55357ca18dad0374a83fc506f9f72723c42ce5424d2fe30d39ba766901",
  "6f9c44bd3fb8c251aa8dad45105ac97609c37a6ac8ad9e1dadea58713c42c8bc",
  // 5.0.0-next.29: darwin-arm64, then linux-x86_64 and linux-arm64
  "cb5fe2ca7ce491bdd3ade6708ad39dfeea395cd182fb232d9e9d1955b24463e0",
  "9f1579c35c2f20a6a0e741ebac39e326e0c22f4f38167fa950351b7473c72220",
  "772d719cdcb048f5eb67a6a36151970962cbc2595a357f064a57991fb12099ab",
];
export const launcherBytes = () =>
  Buffer.from(
    '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd -P)\nif [ "${1-}" = --manager ]; then shift; exec "$root/manager" --root "$root" "$@"; fi\nexec "$root/manager" --root "$root" run -- "$@"\n'
  );
const nonce = () => randomUUID().replaceAll("-", "");
/** Setup inspection consumes no project credentials or ambient native selectors. */
function childSetupInspectionEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME"]) {
    environment[name] = process.env[name];
  }
  return environment;
}
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
function atomicFile(
  path: string,
  bytes: Uint8Array,
  mode = 0o600,
  checkpoint?: (point: string) => void
) {
  const temporary = join(
    dirname(path),
    `${mode === 0o500 ? ".manager" : ".selection"}-${nonce()}`
  );
  try {
    writeFile(temporary, bytes, mode);
    publishAndSync(
      path,
      () => renameSync(temporary, path),
      () => {
        checkpoint?.(`sync:${basename(path)}`);
        syncDirectory(dirname(path));
      }
    );
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
function atomicJson(
  path: string,
  value: unknown,
  checkpoint?: (point: string) => void
) {
  atomicFile(path, jsonBytes(value), 0o600, checkpoint);
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
/**
 * The private directories a version keeps beside its bundle. A Compose-only
 * Linux version keeps none: Compose runs use the caller's own Hack home.
 */
function versionHomes(platform: BundlePlatform): string[] {
  return composeOnly(platform) ? [] : ["native-home", "cli-home"];
}
/** The refusal for a native selection on a Compose-only Linux channel. */
export const COMPOSE_ONLY_NATIVE_REFUSAL =
  "This is a Compose-only Linux candidate; the native backend is Apple Silicon macOS only. Unset HACK_RUNTIME_BACKEND (or set it to compose).";
/** One owner for receipts, retained bytes and atomic selection. Hooks are fixture-only injection. */
export class Channel {
  readonly root: string;
  readonly source: string;
  /**
   * The bundle kind this channel installs and runs: the host's, as the
   * compiled manager passes it. The default keeps the macOS contract for
   * callers that do not choose.
   */
  readonly platform: BundlePlatform;
  /**
   * What the validation inside `lock()` verified, per version: the directory
   * and the receipt checksum it was verified against. An entry lets one
   * launch skip a repeat of the same verification. It is dropped when the
   * lock is released and by every later `validate()`, which each command
   * that changes the channel starts with, and `run()` uses it only while the
   * checksum is still the one in `state`. Validations outside `lock()` never
   * fill it.
   */
  private lockVerified: Map<
    string,
    { readonly directory: string; readonly checksum: string }
  > | null = null;
  state: State = {
    schema: "hack.prerelease-selection/v1",
    installed: {},
    selected: null,
    previous: null,
  };
  private readonly hooks: Hooks;
  constructor(
    root: string,
    source: string,
    hooks: Hooks = {},
    platform: BundlePlatform = DEFAULT_BUNDLE_PLATFORM
  ) {
    this.root = canonical(root);
    this.source = canonical(source);
    this.hooks = hooks;
    this.platform = platform;
  }
  private path(name: string) {
    return join(this.root, name);
  }
  private signatures(bundle: string) {
    if (this.hooks.signatures) {
      this.hooks.signatures(bundle);
      return;
    }
    verifySignatures(bundle, this.platform);
  }
  private refuseLegacy() {
    if (
      lexists(this.path("manager.py")) ||
      (lexists(this.path(".channel.json")) &&
        privateJson(this.path(".channel.json")).schema ===
          "hack.prerelease-install/v1")
    ) {
      throw new Error(
        "Python/v1 installation is preserved unchanged; use an explicit separate --root. This manager cannot migrate or recover a Python manager journal."
      );
    }
  }
  /** Unlocked admission reads identity/owned structure only; receipts and payload hashes require lock(). */
  private initializationPreflight() {
    const info = owned(this.root, true, 0o700);
    this.refuseLegacy();
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
        marker.inode === info.ino &&
        typeof marker.manager_sha256 === "string" &&
        SHA256.test(marker.manager_sha256) &&
        typeof marker.launcher_sha256 === "string" &&
        SHA256.test(marker.launcher_sha256),
      "Foreign or malformed installation marker; use a separate --root."
    );
    owned(this.path("manager"), false, 0o500);
    owned(this.path("bin"), true, 0o700);
    owned(this.path("bin/hack-next"), false, 0o755);
    owned(this.path("versions"), true, 0o700);
    owned(this.path(".manager.lock"), false, 0o600);
  }
  /** Only called after a confirmed competing winner; failures/crashes never enter this path. */
  private removeFreshLoser(stage: string, created: ReturnType<typeof owned>) {
    this.hooks.checkpoint?.("init-loser");
    let observed: ReturnType<typeof lstatSync>;
    try {
      observed = lstatSync(stage);
    } catch (error) {
      throw new Error(
        `Losing initializer stage was not removed: its identity is unavailable at ${stage}. No other stage was touched.`,
        { cause: error }
      );
    }
    requireThat(
      isFreshInitializerStage(created, observed, process.getuid?.()),
      `Losing initializer stage retained because its type, ownership, mode or identity changed: ${stage}`
    );
    try {
      publishAndSync(
        stage,
        () => rmSync(stage, { recursive: true }),
        () => syncDirectory(dirname(stage))
      );
    } catch (error) {
      throw new Error(
        `Losing initializer cleanup did not establish complete durable removal at ${stage}; inspect the remaining stage. No other stage was touched.`,
        { cause: error }
      );
    }
  }
  /** Publish a complete private sibling once, never replace/adopt an existing root.
   * Crashes before rename retain inert sibling stages; retries do not delete or adopt them.
   * Crashes after rename expose a complete channel. The parent must be owned, canonical,
   * and on a filesystem supporting atomic no-replace directory rename and directory fsync.
   */
  initialize() {
    if (lexists(this.root)) {
      owned(this.root, true, 0o700);
      this.refuseLegacy();
      requireThat(
        lexists(this.path(".channel.json")),
        "Refusing to adopt an existing installation root, including an empty or incomplete root; use a separate --root."
      );
      this.initializationPreflight();
      return;
    }
    const parent = dirname(this.root);
    owned(parent, true);
    owned(this.source);
    const stage = join(parent, `.${basename(this.root)}.init-${nonce()}`);
    mkdirSync(stage, { mode: 0o700 });
    const created = owned(stage, true, 0o700);
    const path = (name: string) => join(stage, name);
    this.hooks.checkpoint?.("init-stage");
    mkdirSync(path("bin"), { mode: 0o700 });
    mkdirSync(path("versions"), { mode: 0o700 });
    writeFile(path("manager"), readFileSync(this.source), 0o500);
    this.hooks.checkpoint?.("init-manager");
    writeFile(path("bin/hack-next"), launcherBytes(), 0o755);
    this.hooks.checkpoint?.("init-launcher");
    const marker = {
      schema: "hack.prerelease-install/v2",
      root: this.root,
      uid: process.getuid?.(),
      device: created.dev,
      inode: created.ino,
      manager_sha256: digest(path("manager")),
      launcher_sha256: digest(path("bin/hack-next")),
    };
    writeFile(path(".channel.json"), jsonBytes(marker));
    this.hooks.checkpoint?.("init-channel");
    writeFile(path(".selection.json"), jsonBytes(this.state));
    this.hooks.checkpoint?.("init-selection");
    writeFile(path(".manager.lock"), Buffer.alloc(0));
    this.hooks.checkpoint?.("init-lock");
    syncDirectory(path("bin"));
    syncDirectory(path("versions"));
    syncDirectory(stage);
    syncDirectory(parent);
    requireThat(
      sameJson(privateJson(path(".channel.json")), marker) &&
        sameJson(privateJson(path(".selection.json")), this.state) &&
        digest(path("manager")) === digest(this.source) &&
        digest(path("bin/hack-next")) === marker.launcher_sha256,
      "Initialization stage changed."
    );
    this.hooks.checkpoint?.("init-ready");
    const current = owned(stage, true, 0o700);
    requireThat(
      current.dev === created.dev && current.ino === created.ino,
      "Initialization stage identity changed."
    );
    const published = publishDirectoryExclusive(stage, this.root);
    if (!published) {
      // A competing initializer won. Preflight only; authoritative validation follows kernel locking.
      requireThat(
        lexists(this.root),
        `Atomic no-replace initialization failed; preserved stage: ${stage}`
      );
      owned(this.root, true, 0o700);
      this.refuseLegacy();
      requireThat(
        lexists(this.path(".channel.json")),
        `A competing existing/foreign root was not adopted; use a separate --root. Preserved stage: ${stage}`
      );
      this.initializationPreflight();
      this.removeFreshLoser(stage, created);
      return;
    }
    publishAndSync(
      this.root,
      () => {
        /* The exclusive rename above has already published the complete root. */
      },
      () => {
        this.hooks.checkpoint?.("init-published");
        syncDirectory(parent);
      }
    );
    this.initializationPreflight();
  }
  /** Kernel flock is shared for launches, exclusive for mutations, and never waits. */
  lock(shared = false, managerUpgrade = false, receiptRoot = this.root) {
    owned(this.root, true, 0o700);
    this.refuseLegacy();
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
      this.lockVerified = this.validate(managerUpgrade, receiptRoot);
    } catch (error) {
      closeSync(fd);
      library.close();
      throw error;
    }
    return () => {
      this.lockVerified = null;
      closeSync(fd);
      library.close();
    };
  }
  /** receiptRoot differs only while validating an uninstalled retained sibling. */
  validate(managerUpgrade = false, receiptRoot = this.root) {
    // Whatever an earlier validation verified may be about to change.
    this.lockVerified = null;
    const info = owned(this.root, true, 0o700);
    this.refuseLegacy();
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
        marker.root === receiptRoot &&
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
    const verified = new Map<
      string,
      { readonly directory: string; readonly checksum: string }
    >();
    for (const [version, checksum] of Object.entries(installed)) {
      candidateVersion(version);
      requireThat(
        typeof checksum === "string" && SHA256.test(checksum),
        "Malformed receipt hash."
      );
      verified.set(version, {
        directory: this.verifyVersion(version, checksum),
        checksum,
      });
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
      candidateVersion(version);
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
    return verified;
  }
  verifyVersion(version: string, checksum: string) {
    const directory = this.path(`versions/${version}`);
    owned(directory, true, 0o700);
    requireThat(
      sameJson(
        readdirSync(directory).sort(),
        ["bundle", ...versionHomes(this.platform), ".receipt.json"].sort()
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
    const verified = verifyBundle(
      join(directory, "bundle"),
      version,
      this.platform
    );
    requireThat(
      sameJson(receipt.metadata, verified.identity) &&
        sameJson(receipt.checksums, verified.manifest),
      "Candidate identity or checksum receipt changed."
    );
    const homes = object(receipt.homes);
    exact(homes, versionHomes(this.platform));
    for (const name of versionHomes(this.platform)) {
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
      Reflect.deleteProperty(environment, "HACK_NATIVE_BINARY");
      Reflect.deleteProperty(environment, "HACK_NATIVE_HOME");
      environment.HACK_RUNTIME_BACKEND = "compose";
      return environment;
    }
    Reflect.deleteProperty(environment, "HACK_GLOBAL_CONFIG_PATH");
    const selectedHome = this.path(`versions/${version}/native-home`);
    return {
      ...environment,
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: this.path(`versions/${version}/bundle/hack-native`),
      HACK_NATIVE_HOME: selectedHome,
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
    // A Compose-only version owns no runtime and no home: its projects run in
    // the caller's Docker engine and Hack home, which a selection change does
    // not touch. The exclusive manager lock already refuses active launchers.
    if (composeOnly(this.platform)) {
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
          env: childSetupInspectionEnvironment(),
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
        this.requireSetupOnlyHome(directory);
      }
      this.validate(managerUpgrade);
    }
  }
  /** Setup artifacts alone own no VM. Unknown uninitialized state remains a
   * refusal, including old executors that cannot prove the setup-only predicate.
   */
  private requireSetupOnlyHome(directory: string) {
    const home = join(directory, "native-home");
    if (readdirSync(home).length === 0) {
      return;
    }
    const result = Bun.spawnSync(
      [
        join(directory, "bundle/hack-native"),
        "--candidate-root",
        home,
        "runtime",
        "setup",
        "inspect",
        "--json",
        "--quiescence",
      ],
      {
        env: childSetupInspectionEnvironment(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }
    );
    requireThat(
      result.exitCode === 0 && result.stdout.length <= 1024 * 1024,
      "Uninitialized home could not be inspected; selection preserved."
    );
    let inspection: unknown;
    try {
      inspection = JSON.parse(result.stdout.toString());
    } catch {
      throw new Error(
        "Malformed native setup inspection; selection preserved."
      );
    }
    const report = object(inspection);
    requireThat(
      report.protocol_version === 1 && report.setup_only === true,
      "Uninitialized home contains runtime or unknown state; inspect it through its owning CLI."
    );
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
    atomicJson(this.path(".selection.json"), state, this.hooks.checkpoint);
    this.state = state;
  }
  /** Read-only by default; applying retains the complete channel and user homes for rollback. */
  uninstall(apply = false) {
    this.validate();
    const backup = join(
      dirname(this.root),
      `.${basename(this.root)}.uninstalled-${nonce()}`
    );
    const info = owned(this.root, true, 0o700);
    const plan = {
      schema: "hack.prerelease-uninstall/v1",
      from: this.root,
      to: backup,
      device: info.dev,
      inode: info.ino,
      manager_sha256: digest(this.path("manager")),
      versions: Object.keys(this.state.installed).sort(),
      manifest: `${backup}.json`,
    };
    if (!apply) {
      return { ...plan, applied: false };
    }
    for (const version of plan.versions) {
      this.requireQuiescent(version);
    }
    this.validate();
    const current = owned(this.root, true, 0o700);
    requireThat(
      current.dev === info.dev && current.ino === info.ino,
      "Candidate root changed; uninstall refused."
    );
    writeFile(plan.manifest, jsonBytes(plan));
    syncDirectory(dirname(this.root));
    this.hooks.checkpoint?.("uninstall-manifest");
    if (!publishDirectoryExclusive(this.root, backup)) {
      unlinkSync(plan.manifest);
      syncDirectory(dirname(this.root));
      throw new Error("Uninstall destination exists; channel preserved.");
    }
    syncDirectory(dirname(this.root));
    return { ...plan, applied: true };
  }
  async install(
    version: string,
    archive?: string,
    checksum?: string,
    upgrade = false
  ) {
    candidateVersion(version);
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
        `${version} is already installed; select it with: hack-next --manager select --version ${version}`
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
      current === null || compareCandidateVersions(version, current) > 0,
      "Upgrade must increase the prerelease version. To use an installed older version, run: hack-next --manager select --version VERSION"
    );
    requireThat(
      digest(this.path("manager")) === digest(this.source),
      "Retained manager differs from this installer; use the retained manager (hack-next --manager), or replace it first: run this installer with --root <channel root> upgrade-manager. A separate --root also works."
    );
    this.requireQuiescent(current);
    // The exclusive manager lock excludes another installer. A killed download's
    // private stage is disposable; published versions and user homes are not.
    for (const name of readdirSync(this.root)) {
      if (!STAGE.test(name)) {
        continue;
      }
      const abandoned = this.path(name);
      owned(abandoned, true, 0o700);
      rmSync(abandoned, { recursive: true });
      syncDirectory(this.root);
    }
    const stage = this.path(`.stage-${nonce()}`);
    mkdirSync(stage, { mode: 0o700 });
    const created = lstatSync(stage);
    try {
      const input = archive
        ? { archive: canonical(archive), checksum: checksum as string }
        : await officialArchive(stage, version, undefined, this.platform);
      const installation = join(stage, "installation");
      mkdirSync(installation, { mode: 0o700 });
      const verified = extractArchive({
        ...input,
        destination: join(installation, "bundle"),
        version,
        platform: this.platform,
        signatures: (bundle) => this.signatures(bundle),
      });
      const homes: Record<string, { device: number; inode: number }> = {};
      for (const name of versionHomes(this.platform)) {
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
      publishAndSync(
        destination,
        () => renameSync(installation, destination),
        () => {
          this.hooks.checkpoint?.("sync:version");
          syncDirectory(dirname(destination));
        }
      );
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
      atomicJson(this.path(".selection.json"), state, this.hooks.checkpoint);
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
      publishAndSync(
        this.path(JOURNAL),
        () => renameSync(join(stage, "journal.json"), this.path(JOURNAL)),
        () => {
          this.hooks.checkpoint?.("sync:journal");
          syncDirectory(stage);
          syncDirectory(this.root);
        }
      );
      this.hooks.checkpoint?.("upgrade-journal");
    }
    this.validate(true);
    const plan = this.readManagerUpgrade();
    const stage = this.path(String(plan.stage));
    if (digest(this.path("manager")) !== targetHash) {
      atomicFile(
        this.path("manager"),
        readFileSync(join(stage, "manager-after")),
        0o500,
        this.hooks.checkpoint
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
        readFileSync(join(stage, "channel-after.json")),
        0o600,
        this.hooks.checkpoint
      );
    }
    this.hooks.checkpoint?.("upgrade-receipt");
    this.validate(true);
    publishAndSync(
      this.path(JOURNAL),
      () => unlinkSync(this.path(JOURNAL)),
      () => {
        this.hooks.checkpoint?.("sync:journal-removed");
        syncDirectory(this.root);
      }
    );
    this.validate();
  }
  /**
   * Runs the selected CLI. `childUmask` is the caller's umask: the manager
   * keeps a private umask (077) for its own files, and the CLI must not
   * inherit it. Under 077 every file the CLI writes is owner-only, and on
   * Linux the non-root containers that read its bind-mounted configs exit
   * with "permission denied" (HACK-2381).
   */
  async run(arguments_: string[], childUmask?: number) {
    const compose = composeOnly(this.platform);
    let backend =
      process.env.HACK_RUNTIME_BACKEND || (compose ? "compose" : "native");
    requireThat(
      backend === "native" || backend === "compose",
      `HACK_RUNTIME_BACKEND must be native or compose (unset selects ${compose ? "compose" : "native"}).`
    );
    if (compose) {
      // `native ...` commands still reach the CLI on Compose, which answers
      // them itself (`native setup` refuses with E_UNSUPPORTED_PLATFORM).
      requireThat(backend === "compose", COMPOSE_ONLY_NATIVE_REFUSAL);
    } else if (
      // Explicit native operations select native setup even from a Compose shell.
      arguments_.filter((argument) => argument !== "--no-interactive")[0] ===
      "native"
    ) {
      backend = "native";
    }
    const version = this.state.selected;
    requireThat(
      version !== null,
      "No candidate selected. Use your ordinary stable hack command."
    );
    if (backend === "native") {
      const override = process.env.HACK_NATIVE_HOME?.trim();
      requireThat(
        !override || override === this.path(`versions/${version}/native-home`),
        // Name the selected bundle's script by path: it is not on PATH (HACK-2251).
        `hack-next uses its receipt-owned native home for safe upgrades; for a custom HACK_NATIVE_HOME run the bundle's launcher directly: ${quoteShellWord(this.path(`versions/${version}/bundle/hack-v5`))}`
      );
    }
    const checksum = this.state.installed[version];
    requireThat(checksum, "Missing selected receipt.");
    // `lock()` hashed every file of this version against this receipt
    // checksum, under the lock this launch still holds and with no change to
    // the channel since. Hashing it again here would only repeat that read.
    // Any other launch is verified now.
    const verified = this.lockVerified?.get(version);
    this.lockVerified?.delete(version);
    const directory =
      verified?.checksum === checksum
        ? verified.directory
        : this.verifyVersion(version, checksum);
    this.signatures(join(directory, "bundle"));
    // The child takes its umask when it is spawned; the manager's own is put
    // back straight after, before anything else can create a file.
    const spawnChild = () =>
      Bun.spawn(
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
    const managerUmask =
      childUmask === undefined ? null : process.umask(childUmask);
    let child: ReturnType<typeof spawnChild>;
    try {
      child = spawnChild();
    } finally {
      if (managerUmask !== null) {
        process.umask(managerUmask);
      }
    }
    const handlers = new Map<NodeJS.Signals, () => void>();
    try {
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        const forward = () => child.kill(signal);
        handlers.set(signal, forward);
        process.on(signal, forward);
      }
      const code = await child.exited;
      if (child.signalCode) {
        return subprocessSignalExitStatus(child.signalCode, 0);
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

/** Restore only the exact retained channel; an occupied original root is never replaced. */
export function rollbackUninstall(
  root: string,
  manifestPath: string,
  source: string,
  platform: BundlePlatform = DEFAULT_BUNDLE_PLATFORM
) {
  canonical(root);
  canonical(manifestPath);
  canonical(source);
  const plan = privateJson(manifestPath);
  exact(plan, [
    "schema",
    "from",
    "to",
    "device",
    "inode",
    "manager_sha256",
    "versions",
    "manifest",
  ]);
  requireThat(
    plan.schema === "hack.prerelease-uninstall/v1" &&
      plan.from === root &&
      plan.manifest === manifestPath &&
      typeof plan.to === "string",
    "Invalid uninstall manifest."
  );
  const backup = canonical(plan.to as string);
  requireThat(
    dirname(backup) === dirname(root) &&
      basename(backup).startsWith(`.${basename(root)}.uninstalled-`) &&
      /^[a-f0-9]{32}$/.test(basename(backup).slice(-32)) &&
      manifestPath === `${backup}.json`,
    "Uninstall manifest target is not its retained sibling."
  );
  const retained = new Channel(backup, source, {}, platform);
  const release = retained.lock(false, false, root);
  try {
    const info = owned(backup, true, 0o700);
    const marker = privateJson(join(backup, ".channel.json"));
    requireThat(
      info.dev === plan.device &&
        info.ino === plan.inode &&
        marker.root === root &&
        marker.device === info.dev &&
        marker.inode === info.ino &&
        marker.uid === process.getuid?.() &&
        digest(join(backup, "manager")) === plan.manager_sha256 &&
        digest(source) === plan.manager_sha256,
      "Retained channel identity changed; rollback refused."
    );
    requireThat(
      publishDirectoryExclusive(backup, root),
      "Original channel path is occupied; nothing replaced."
    );
    syncDirectory(dirname(root));
    new Channel(root, join(root, "manager"), {}, platform).validate();
    return { restored: root, manifest: manifestPath };
  } finally {
    release();
  }
}
