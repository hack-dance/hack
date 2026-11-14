import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  GLOBAL_ALLOY_FILENAME,
  GLOBAL_BRANCHES_SCHEMA_FILENAME,
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  GLOBAL_CONFIG_SCHEMA_FILENAME,
  GLOBAL_COREDNS_FILENAME,
  GLOBAL_ENV_SCHEMA_FILENAME,
  GLOBAL_GRAFANA_DASHBOARD_FILENAME,
  GLOBAL_GRAFANA_DASHBOARDS_DIR,
  GLOBAL_GRAFANA_DASHBOARDS_PROVISIONING_FILENAME,
  GLOBAL_GRAFANA_DATASOURCE_FILENAME,
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOGGING_DIR_NAME,
  GLOBAL_LOKI_CONFIG_FILENAME,
  GLOBAL_MANAGED_ENV_SCHEMA_FILENAME,
  GLOBAL_SCHEMAS_DIR_NAME,
} from "../constants.ts";
import {
  renderGlobalAlloyConfig,
  renderGlobalCaddyCompose,
  renderGlobalCoreDnsConfig,
  renderGlobalGrafanaDashboardsProvisioningYaml,
  renderGlobalGrafanaDatasourceYaml,
  renderGlobalGrafanaLogsDashboardJson,
  renderGlobalLoggingCompose,
  renderGlobalLokiConfigYaml,
  renderProjectBranchesSchemaJson,
  renderProjectConfigSchemaJson,
  renderProjectEnvSchemaJson,
  renderProjectManagedEnvSchemaJson,
} from "../templates.ts";
import { HackCliError } from "./cli-result.ts";
import { parseDefaultDomain } from "./default-domain.ts";
import { checkReplaceableChain } from "./path-trust.ts";
import { parseProxyBindAddress } from "./proxy-bind.ts";

type RoutingAsset = {
  readonly path: string;
  readonly accepted: readonly string[];
};
type ObservedAsset = {
  readonly path: string;
  readonly text: string;
  readonly stat: Stats;
};
export type AutostartRoutingAssetsOptions = {
  readonly root: string;
  readonly bindAddress: string | null;
  readonly defaultDomain: string;
  /** Observe staging before final identity/device revalidation; this does not authorize publication. */
  readonly beforePublish?: (opts: {
    readonly stagingPath: string;
    readonly targetPath: string;
  }) => Promise<void>;
};
const MAX_ASSET_BYTES = 1024 * 1024;

/**
 * Login executes only already-installed current templates. Authentication is
 * read-only; publication replaces matching nonsecret bytes on fresh 0644 inodes so an
 * older writable descriptor cannot change what the upcoming Compose run reads.
 * Missing/custom assets refuse; this is neither installation nor migration.
 */
export async function secureAutostartRoutingAssets(
  opts: AutostartRoutingAssetsOptions
): Promise<void> {
  try {
    if (!isAbsolute(opts.root) || process.getuid === undefined) {
      throw new Error("Unavailable owner");
    }
    const uid = process.getuid();
    const assets = routingAssets(opts);
    for (const asset of assets) {
      await assertSafeAssetParent({ root: opts.root, path: asset.path, uid });
    }
    await assertMountedDirectory({
      path: resolve(opts.root, GLOBAL_SCHEMAS_DIR_NAME),
      names: [
        GLOBAL_CONFIG_SCHEMA_FILENAME,
        GLOBAL_ENV_SCHEMA_FILENAME,
        GLOBAL_MANAGED_ENV_SCHEMA_FILENAME,
        GLOBAL_BRANCHES_SCHEMA_FILENAME,
      ],
    });
    await assertMountedDirectory({
      path: resolve(
        opts.root,
        GLOBAL_LOGGING_DIR_NAME,
        GLOBAL_GRAFANA_DASHBOARDS_DIR
      ),
      names: [basename(GLOBAL_GRAFANA_DASHBOARD_FILENAME)],
    });
    const observed: ObservedAsset[] = [];
    for (const asset of assets) {
      observed.push(await readCurrentAsset({ asset, uid }));
    }
    const stagingRoot = await lstat(opts.root);
    if (observed.some((asset) => asset.stat.dev !== stagingRoot.dev)) {
      throw new Error("Assets require a common filesystem");
    }
    for (const asset of observed) {
      await publishFreshAsset({
        asset,
        root: opts.root,
        uid,
        beforePublish: opts.beforePublish,
      });
    }
  } catch {
    throw new HackCliError({
      code: "E_PERMISSION",
      message:
        "Automatic routing startup refused untrusted or outdated installed assets. Review and move unexpected schema/dashboard files aside before running hack global install manually, then retry. Values omitted.",
      detail: { reason: "routing_assets_untrusted" },
    });
  }
}

function routingAssets(
  opts: AutostartRoutingAssetsOptions
): readonly RoutingAsset[] {
  const bindAddress =
    opts.bindAddress === null ? null : parseProxyBindAddress(opts.bindAddress);
  const defaultDomain = parseDefaultDomain(opts.defaultDomain);
  const caddy = resolve(opts.root, GLOBAL_CADDY_DIR_NAME);
  const logging = resolve(opts.root, GLOBAL_LOGGING_DIR_NAME);
  const schemas = resolve(opts.root, GLOBAL_SCHEMAS_DIR_NAME);
  const compose: string[] = [];
  for (const useStaticCoreDnsIp of [false, true]) {
    for (const useStaticCaddyIp of [false, true]) {
      compose.push(
        renderGlobalCaddyCompose({
          useStaticCoreDnsIp,
          useStaticCaddyIp,
          bindAddress,
        })
      );
    }
  }
  return [
    { path: resolve(caddy, GLOBAL_CADDY_COMPOSE_FILENAME), accepted: compose },
    {
      path: resolve(caddy, GLOBAL_COREDNS_FILENAME),
      accepted: [false, true].map((useStaticCaddyIp) =>
        renderGlobalCoreDnsConfig({ useStaticCaddyIp, defaultDomain })
      ),
    },
    ...(
      [
        [GLOBAL_LOGGING_COMPOSE_FILENAME, renderGlobalLoggingCompose()],
        [GLOBAL_ALLOY_FILENAME, renderGlobalAlloyConfig()],
        [GLOBAL_LOKI_CONFIG_FILENAME, renderGlobalLokiConfigYaml()],
        [
          GLOBAL_GRAFANA_DATASOURCE_FILENAME,
          renderGlobalGrafanaDatasourceYaml(),
        ],
        [
          GLOBAL_GRAFANA_DASHBOARDS_PROVISIONING_FILENAME,
          renderGlobalGrafanaDashboardsProvisioningYaml(),
        ],
        [
          GLOBAL_GRAFANA_DASHBOARD_FILENAME,
          renderGlobalGrafanaLogsDashboardJson(),
        ],
      ] as const
    ).map(([name, text]) => ({
      path: resolve(logging, name),
      accepted: [text],
    })),
    ...(
      [
        [GLOBAL_CONFIG_SCHEMA_FILENAME, renderProjectConfigSchemaJson()],
        [GLOBAL_ENV_SCHEMA_FILENAME, renderProjectEnvSchemaJson()],
        [
          GLOBAL_MANAGED_ENV_SCHEMA_FILENAME,
          renderProjectManagedEnvSchemaJson(),
        ],
        [GLOBAL_BRANCHES_SCHEMA_FILENAME, renderProjectBranchesSchemaJson()],
      ] as const
    ).map(([name, text]) => ({
      path: resolve(schemas, name),
      accepted: [text],
    })),
  ];
}

async function assertSafeAssetParent(opts: {
  readonly root: string;
  readonly path: string;
  readonly uid: number;
}): Promise<void> {
  const parent = dirname(opts.path);
  if (
    checkReplaceableChain({ path: parent, uid: opts.uid, hackHome: null }) !==
    null
  ) {
    throw new Error("Unsafe directory chain");
  }
  let current = resolve(opts.root);
  for (const component of [
    "",
    ...relative(current, parent).split("/").filter(Boolean),
  ]) {
    current = resolve(current, component);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Unsupported directory");
    }
  }
}

async function assertMountedDirectory(opts: {
  readonly path: string;
  readonly names: readonly string[];
}): Promise<void> {
  const entries = (await readdir(opts.path)).sort();
  const names = [...opts.names].sort();
  if (
    entries.length !== names.length ||
    entries.some((entry, i) => entry !== names[i])
  ) {
    throw new Error("Unknown mounted content");
  }
}

async function readCurrentAsset(opts: {
  readonly asset: RoutingAsset;
  readonly uid: number;
}): Promise<ObservedAsset> {
  const file = await open(
    opts.asset.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== opts.uid ||
      before.size > MAX_ASSET_BYTES ||
      before.size === 0
    ) {
      throw new Error("Unsupported file");
    }
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, count);
      if (read.bytesRead === 0) {
        break;
      }
      count += read.bytesRead;
    }
    const after = await file.stat();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, count)
    );
    if (
      count !== before.size ||
      !sameObservedFile(before, after) ||
      !opts.asset.accepted.includes(text)
    ) {
      throw new Error("Asset mismatch");
    }
    return { path: opts.asset.path, text, stat: after };
  } finally {
    await file.close();
  }
}

function sameObservedFile(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.uid === b.uid
  );
}

async function publishFreshAsset(opts: {
  readonly asset: ObservedAsset;
  readonly root: string;
  readonly uid: number;
  readonly beforePublish?: AutostartRoutingAssetsOptions["beforePublish"];
}): Promise<void> {
  const { asset } = opts;
  await assertSafeAssetParent({ ...opts, path: asset.path });
  const current = await lstat(asset.path);
  if (!(current.isFile() && sameObservedFile(asset.stat, current))) {
    throw new Error("Asset changed");
  }
  // A killed publisher may leave this file behind. Keep it outside every
  // mounted directory so a later login's exact-list check can still succeed.
  const staging = resolve(opts.root, `.autostart-routing-${randomUUID()}`);
  await assertSafeAssetParent({ ...opts, path: staging });
  const file = await open(staging, "wx", 0o600);
  try {
    await file.writeFile(asset.text, "utf8");
    // These exact canonical templates hold no secrets. Container service UIDs
    // need other-read permission on their bind-mounted fresh inode.
    await file.chmod(0o644);
    await file.sync();
    await opts.beforePublish?.({
      stagingPath: staging,
      targetPath: asset.path,
    });
    await assertSafeAssetParent({ ...opts, path: asset.path });
    const staged = await file.stat();
    const stagedPath = await lstat(staging);
    if (
      !staged.isFile() ||
      staged.uid !== opts.uid ||
      (staged.mode & 0o777) !== 0o644 ||
      staged.dev !== current.dev ||
      !sameObservedFile(staged, stagedPath)
    ) {
      throw new Error("Staging identity or filesystem changed");
    }
    if (!sameObservedFile(current, await lstat(asset.path))) {
      throw new Error("Asset changed");
    }
    await rename(staging, asset.path);
  } finally {
    await file.close();
    await unlink(staging).catch(() => {
      /* A successful publication moved this owned staging file. */
    });
  }
}
