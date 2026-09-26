import { isRecord } from "../lib/guards.ts";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function refused(): Error {
  return new Error(
    "Native workspace cache layout conflicts with declared mounts or is invalid; values omitted."
  );
}
function mount(value: unknown): {
  source: string;
  target: string;
  readOnly: boolean;
  subpath?: unknown;
} {
  if (typeof value === "string") {
    const parts = value.split(":");
    if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1]) {
      throw refused();
    }
    return {
      source: parts[0],
      target: parts[1],
      readOnly: parts[2]?.split(",").includes("ro") ?? false,
    };
  }
  if (
    !(
      isRecord(value) &&
      typeof value.source === "string" &&
      typeof value.target === "string"
    )
  ) {
    throw refused();
  }
  return {
    source: value.source,
    target: value.target,
    readOnly: value.read_only === true,
    subpath: isRecord(value.volume) ? value.volume.subpath : undefined,
  };
}

/** Keep workspace installs inside the same declared content-keyed dependency volume. */
export function applyNativeWorkspaceCache(opts: {
  readonly compose: Record<string, unknown>;
  readonly selection: unknown;
}): void {
  if (opts.selection === undefined) {
    return;
  }
  const selection = opts.selection;
  if (
    !(
      isRecord(selection) &&
      Object.keys(selection).every((key) =>
        ["volume", "root", "workspaces"].includes(key)
      ) &&
      typeof selection.volume === "string" &&
      SEGMENT.test(selection.volume) &&
      typeof selection.root === "string" &&
      selection.root.startsWith("/") &&
      selection.root
        .slice(1)
        .split("/")
        .every((part) => SEGMENT.test(part)) &&
      Array.isArray(selection.workspaces) &&
      selection.workspaces.length > 0 &&
      selection.workspaces.length <= 128 &&
      new Set(selection.workspaces).size === selection.workspaces.length &&
      selection.workspaces.every(
        (path) =>
          typeof path === "string" &&
          path.length <= 256 &&
          path
            .split("/")
            .every(
              (part: string) => SEGMENT.test(part) && part !== "node_modules"
            )
      ) &&
      isRecord(opts.compose.volumes) &&
      Object.hasOwn(opts.compose.volumes, selection.volume) &&
      isRecord(opts.compose.services)
    )
  ) {
    throw refused();
  }
  let consumers = 0;
  const targets = selection.workspaces.map(
    (path: string) => `${selection.root}/${path}/node_modules`
  );
  for (const value of Object.values(opts.compose.services)) {
    if (!isRecord(value) || value.volumes === undefined) {
      continue;
    }
    if (!Array.isArray(value.volumes)) {
      throw refused();
    }
    const mounts = value.volumes.map(mount);
    const parent = mounts.find(
      (item) =>
        item.source === selection.volume &&
        item.target === `${selection.root}/node_modules`
    );
    if (!parent) {
      continue;
    }
    if (parent.subpath !== undefined) {
      throw refused();
    }
    if (mounts.some((item) => targets.includes(item.target))) {
      throw refused();
    }
    consumers++;
    for (const path of selection.workspaces) {
      value.volumes.push({
        type: "volume",
        source: selection.volume,
        target: `${selection.root}/${path}/node_modules`,
        read_only: parent.readOnly,
        volume: { subpath: `.hack-workspace-node-modules/${path}` },
      });
    }
  }
  if (consumers === 0) {
    throw refused();
  }
}
