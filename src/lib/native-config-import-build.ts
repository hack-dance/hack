import { posix } from "node:path";
import type { Build } from "../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "./guards.ts";
import { literalComposeArg } from "./native-config-import-argv.ts";

const TARGET = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const UNSAFE_PATH = /[\\\0\r\n:]/;
const TRAILING_SLASH = /\/$/;
type BuildField = {
  readonly source: "" | "context" | "dockerfile" | "target";
  readonly target: "" | "context" | "dockerfile" | "target";
  readonly code: string;
};

/** Private authored mapping; its path values must never enter public reports. */
export type LegacyComposeBuildMapping = {
  readonly build: Build;
  readonly fields: readonly BuildField[];
};

function relativeLiteral(value: unknown): string | undefined {
  const decoded = literalComposeArg(value);
  return decoded !== undefined &&
    decoded.length > 0 &&
    !UNSAFE_PATH.test(decoded) &&
    !decoded.startsWith("/") &&
    !decoded.startsWith("~")
    ? decoded
    : undefined;
}

function inside(path: string): boolean {
  return path !== ".." && !path.startsWith("../");
}

/**
 * Pure raw Compose build conversion for `.hack/docker-compose.yml` only. Context
 * is rebased from the legacy `.hack` directory to the native checkout root;
 * Dockerfile remains relative to that context. No paths or image caches are read.
 * Extra fields refuse the entire mapping, including explicitly empty options.
 */
export function mapLegacyComposeBuild(
  value: unknown
): LegacyComposeBuildMapping | undefined {
  const shorthand = typeof value === "string";
  if (
    !(
      shorthand ||
      (isRecord(value) &&
        Object.keys(value).every((key) =>
          ["context", "dockerfile", "target"].includes(key)
        ))
    )
  ) {
    return undefined;
  }
  const source = shorthand ? { context: value } : value;
  if (!isRecord(source)) {
    return undefined;
  }
  const context = relativeLiteral(
    Object.hasOwn(source, "context") ? source.context : "."
  );
  if (context === undefined) {
    return undefined;
  }
  const rebased = posix
    .normalize(`.hack/${context}`)
    .replace(TRAILING_SLASH, "");
  if (!inside(rebased)) {
    return undefined;
  }
  const build: Build = { context: rebased };
  const objectContextCode = Object.hasOwn(source, "context")
    ? "exact"
    : "compose_build_context_default";
  const fields: BuildField[] = [
    {
      source: "",
      target: shorthand ? "context" : "",
      code: shorthand ? "compose_short_build_context" : objectContextCode,
    },
  ];
  if (!shorthand && Object.hasOwn(source, "context")) {
    fields.push({
      source: "context",
      target: "context",
      code: "compose_build_context_rebased",
    });
  }
  if (Object.hasOwn(source, "dockerfile")) {
    const dockerfile = relativeLiteral(source.dockerfile);
    if (dockerfile === undefined || dockerfile.endsWith("/")) {
      return undefined;
    }
    const normalized = posix.normalize(dockerfile);
    if (normalized === "." || !inside(normalized)) {
      return undefined;
    }
    build.dockerfile = normalized;
    fields.push({
      source: "dockerfile",
      target: "dockerfile",
      code:
        normalized === source.dockerfile
          ? "exact"
          : "compose_build_path_literal",
    });
  }
  if (Object.hasOwn(source, "target")) {
    if (typeof source.target !== "string" || !TARGET.test(source.target)) {
      return undefined;
    }
    build.target = source.target;
    fields.push({ source: "target", target: "target", code: "exact" });
  }
  return { build, fields };
}
