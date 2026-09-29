import { resolve } from "node:path";
import { rewriteCaddyLabelForBranch } from "../lib/branch-hosts.ts";
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
  return new Error(
    "Native branch routing requires a canonical branch and valid project host configuration; values omitted."
  );
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

/**
 * Rewrite only public route labels after native adaptation has added its aliases.
 * The original Compose digest and private values stay unchanged. Every caller
 * starts from fresh input; this is not a migration of an already-branched plan.
 */
export async function prepareNativeProjectBranch(opts: {
  readonly input: NativeProjectInput;
  readonly scope: NativeProjectRunScope;
  readonly composeFile: string;
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
  for (const service of Object.values(compose.services)) {
    if (!isRecord(service)) {
      throw refused();
    }
    const selected = labels(service.labels);
    if (!selected || selected.caddy === undefined) {
      continue;
    }
    if (typeof selected.caddy !== "string") {
      throw refused();
    }
    const rewritten = rewriteCaddyLabelForBranch({
      value: selected.caddy.split(HOST_SEPARATOR).filter(Boolean).join(", "),
      branch,
      baseHosts,
    });
    if (rewritten.changed) {
      service.labels = { ...selected, caddy: rewritten.value };
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
