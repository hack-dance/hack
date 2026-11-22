/** Resolve local build definitions and the checkout paths they can consume. */
import { posix } from "node:path";
import createDockerignore from "@balena/dockerignore";
import { isRecord } from "../src/lib/guards.ts";

type Build = { readonly context: string; readonly dockerfile: string };
type Reader = (path: string) => string | undefined;

export function composeBuilds(file: string, source: string): Build[] {
  const compose: unknown = Bun.YAML.parse(source);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    return [];
  }
  const builds: Build[] = [];
  for (const service of Object.values(compose.services)) {
    if (!(isRecord(service) && service.build)) {
      continue;
    }
    const build = localComposeBuild({ file, build: service.build });
    if (build) {
      builds.push(build);
    }
  }
  return builds;
}

function localComposeBuild({
  file,
  build,
}: {
  file: string;
  build: unknown;
}): Build | undefined {
  const directory =
    typeof build === "string"
      ? build
      : isRecord(build)
        ? (build.context ?? ".")
        : null;
  if (typeof directory !== "string" || directory.includes("$")) {
    throw new Error(`Cannot resolve Compose build context in ${file}`);
  }
  if (/^(?:https?:|git:|git@|docker-image:)/.test(directory)) {
    return;
  }
  const context = posix.normalize(posix.join(posix.dirname(file), directory));
  if (
    posix.isAbsolute(directory) ||
    context === ".." ||
    context.startsWith("../")
  ) {
    return;
  }
  const definition = isRecord(build)
    ? (build.dockerfile ?? "Dockerfile")
    : "Dockerfile";
  if (typeof definition !== "string" || definition.includes("$")) {
    throw new Error(`Cannot resolve Compose Dockerfile in ${file}`);
  }
  if (
    isRecord(build) &&
    (build.dockerfile_inline || build.additional_contexts)
  ) {
    throw new Error(`Cannot scope additional Compose build inputs in ${file}`);
  }
  return { context, dockerfile: posix.join(context, definition) };
}

/** Unrecognized local COPY/ADD syntax widens to the whole context. */
function copySources(source: string): string[] {
  const paths: string[] = [];
  for (const line of source.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const instruction = /^\s*(?:COPY|ADD)\s+(.+)$/i.exec(line)?.[1];
    if (!instruction) {
      continue;
    }
    if (/^--from(?:=|\s)/.test(instruction)) {
      continue;
    }
    if (/^--|<<|\\/.test(instruction)) {
      return ["."];
    }
    const words: unknown = instruction.startsWith("[")
      ? JSON.parse(instruction)
      : instruction.trim().split(/\s+/);
    if (!Array.isArray(words) || words.length < 2) {
      return ["."];
    }
    for (const argument of words.slice(0, -1) as unknown[]) {
      if (typeof argument !== "string" || !/^[\w./-]+$/.test(argument)) {
        return ["."];
      }
      paths.push(
        posix.normalize(`/${argument}`).slice(1).replace(/\/$/, "") || "."
      );
    }
  }
  return paths;
}

export function dockerContextInputs(opts: Build & { readonly read: Reader }) {
  const rootIgnore = posix.join(opts.context, ".dockerignore");
  const specificIgnore = `${opts.dockerfile}.dockerignore`;
  const ignore = opts.read(specificIgnore) ?? opts.read(rootIgnore) ?? "";
  const matcher = createDockerignore({ ignorecase: false }).add(ignore);
  const source = opts.read(opts.dockerfile);
  const sources = source === undefined ? ["."] : copySources(source);
  return {
    definitions: [opts.dockerfile, rootIgnore, specificIgnore],
    includes(path: string): boolean {
      const relative = posix.relative(opts.context, path);
      return (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith("../") &&
        sources.some(
          (entry) =>
            entry === "." ||
            relative === entry ||
            relative.startsWith(`${entry}/`)
        ) &&
        !matcher.ignores(relative)
      );
    },
  };
}
