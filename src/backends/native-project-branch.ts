import { resolve } from "node:path";
import {
  BranchCaddyHostsError,
  branchServiceCaddyLabels,
  isCaddySiteLabel,
} from "../lib/branch-hosts.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  findProjectContext,
  readProjectConfig,
  resolveProjectOauthAliasHost,
  resolveProjectRouteBaseHosts,
} from "../lib/project.ts";
import type { NativeProjectInput } from "./native-project-input.ts";
import type { NativeProjectRunScope } from "./native-project-run.ts";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_SEPARATOR = /[\s,]+/;

function refused(): Error {
  return new HackCliError({
    code: "E_CONFIG_INVALID",
    message:
      "Native branch routing requires a canonical branch and valid project host configuration; values omitted.",
  });
}

/** The same selector must reach original review, normalized review and execution. */
export function nativeProjectBranchArgs(branch?: string | null): string[] {
  if (branch === undefined || branch === null) {
    return [];
  }
  if (!LABEL.test(branch)) {
    throw refused();
  }
  return ["--branch", branch];
}

function labels(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isRecord(value)) {
    return value;
  }
  if (!Array.isArray(value)) {
    throw refused();
  }
  const result: Record<string, unknown> = {};
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw refused();
    }
    const equal = entry.indexOf("=");
    const key = equal < 0 ? entry : entry.slice(0, equal);
    if (!key || Object.hasOwn(result, key)) {
      throw refused();
    }
    Object.defineProperty(result, key, {
      value: equal < 0 ? "" : entry.slice(equal + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

/** One service's branch labels; non-string site labels and empty results refuse. */
function branchServiceLabels(opts: {
  readonly service: string;
  readonly labels: Record<string, unknown>;
  readonly branch: string;
  readonly baseHosts: readonly string[];
  readonly onDropped: ((notice: string) => void) | undefined;
}): Record<string, unknown> | undefined {
  const sites: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(opts.labels)) {
    if (!isCaddySiteLabel(key)) {
      sites[key] = value;
      continue;
    }
    if (typeof value !== "string") {
      throw refused();
    }
    sites[key] = value.split(HOST_SEPARATOR).filter(Boolean).join(", ");
  }
  try {
    return branchServiceCaddyLabels({ ...opts, labels: sites });
  } catch (error) {
    if (error instanceof BranchCaddyHostsError) {
      throw new HackCliError({
        code: "E_CONFIG_INVALID",
        message: error.message,
      });
    }
    throw error;
  }
}

/**
 * Rewrite only public route labels after native adaptation has added its aliases.
 * The original Compose digest and private values stay unchanged. Every caller
 * starts from fresh input; this is not a migration of an already-branched plan.
 */
export async function prepareNativeProjectBranch(opts: {
  readonly input: NativeProjectInput;
  readonly scope: NativeProjectRunScope;
  readonly composeFile: string;
  /** Told about sites a branch instance drops (outside the project's namespaces). */
  readonly onDropped?: (notice: string) => void;
}): Promise<NativeProjectInput> {
  const branch = opts.scope.branch;
  nativeProjectBranchArgs(branch);
  if (branch === null) {
    return opts.input;
  }
  const project = await findProjectContext(opts.scope.projectRoot);
  if (
    !project ||
    project.projectRoot !== resolve(opts.scope.projectRoot) ||
    project.projectDir !== resolve(opts.scope.projectDir) ||
    project.composeFile !== resolve(opts.composeFile)
  ) {
    throw refused();
  }
  const cfg = await readProjectConfig(project);
  const devHost = cfg.devHost;
  if (
    cfg.parseError ||
    !devHost ||
    devHost.length > 253 ||
    !devHost.includes(".") ||
    !devHost.split(".").every((part) => LABEL.test(part))
  ) {
    throw refused();
  }
  const baseHosts = resolveProjectRouteBaseHosts({
    devHost,
    aliasHost: resolveProjectOauthAliasHost({ devHost, oauth: cfg.oauth }),
  });
  const compose: unknown = JSON.parse(opts.input.normalizedComposeJson);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    throw refused();
  }
  let changed = false;
  for (const [name, service] of Object.entries(compose.services)) {
    if (!isRecord(service)) {
      throw refused();
    }
    const selected = labels(service.labels);
    const next = selected
      ? branchServiceLabels({
          service: name,
          labels: selected,
          branch,
          baseHosts,
          onDropped: opts.onDropped,
        })
      : undefined;
    if (next) {
      service.labels = next;
      changed = true;
    }
  }
  if (!changed) {
    return opts.input;
  }
  const normalizedComposeJson = JSON.stringify(compose);
  if (Buffer.byteLength(normalizedComposeJson) > 256 * 1024) {
    throw refused();
  }
  return { ...opts.input, normalizedComposeJson };
}
