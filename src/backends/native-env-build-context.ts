import { dirname, relative, resolve, sep } from "node:path";
import { HackCliError } from "../lib/cli-result.ts";
import { NativeEnvFileRefusal } from "./native-env-file-source.ts";
import {
  admitNativeProjectBuild,
  type NativeBuildRequest,
} from "./native-project-builds.ts";

const ASCII = /^[\x00-\x7f]*$/;

/**
 * Prove disjointness without consulting a mutable host directory. ASCII names
 * compare case-insensitively. A non-ASCII component is conservatively ambiguous,
 * covering every host Unicode alias without implementing another case-fold table.
 */
function maySharePrefix(
  parent: readonly string[],
  child: readonly string[]
): boolean {
  return (
    parent.length <= child.length &&
    parent.every((part, index) => {
      const other = child[index] ?? "";
      return (
        !(ASCII.test(part) && ASCII.test(other)) ||
        part.toLowerCase() === other.toLowerCase()
      );
    })
  );
}

/** The project-relative components of a literal, already bounded source path. */
function parts(root: string, path: string): string[] {
  return relative(root, path)
    .split(sep)
    .filter((part) => part !== "" && part !== ".");
}

/**
 * Buildx reads raw host contexts and may use a Dockerfile-specific ignore file.
 * Until builds can carry enforced private exclusions, reject overlapping inputs
 * before any hook/provider/build effect, regardless of authored ignore patterns.
 */
export function requireNativeEnvBuildSeparation(opts: {
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly services: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly privatePaths: readonly string[];
}): void {
  const root = resolve(opts.projectRoot);
  const privatePaths = opts.privatePaths.map((path) => ({
    path,
    parts: parts(root, path),
  }));
  for (const [name, service] of Object.entries(opts.services)) {
    let request: NativeBuildRequest | undefined;
    try {
      request = admitNativeProjectBuild({ ...opts, name, service });
    } catch (error: unknown) {
      // The dedicated build admission already refuses unsupported declarations.
      if (
        error instanceof HackCliError &&
        error.code === "E_NATIVE_PROJECT_UNSUPPORTED"
      ) {
        continue;
      }
      throw error;
    }
    if (request === undefined) {
      continue;
    }
    const context = parts(root, resolve(root, request.context));
    const dockerfile = resolve(root, request.context, request.dockerfile);
    const definitions = [dockerfile, `${dockerfile}.dockerignore`].map((path) =>
      parts(root, path)
    );
    const overlap = privatePaths.find(
      (source) =>
        maySharePrefix(context, source.parts) ||
        definitions.some(
          (definition) =>
            definition.length === source.parts.length &&
            maySharePrefix(definition, source.parts)
        )
    );
    if (overlap !== undefined) {
      throw new NativeEnvFileRefusal({
        service: name,
        field: "build",
        source: relative(dirname(opts.composeFile), overlap.path),
        reason:
          "native build inputs overlap an environment source; use disjoint build inputs, a prebuilt image, or the Compose backend",
      });
    }
  }
}
