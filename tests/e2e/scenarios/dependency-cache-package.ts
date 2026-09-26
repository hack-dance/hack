import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

import { isRecord } from "../../../src/lib/guards.ts";
import {
  addLinkedWorktree,
  commitAll,
  createMonorepoFixture,
} from "../fixture.ts";
import {
  expect,
  expectExit,
  extractJsonObject,
  runCommand,
  type Scenario,
} from "../harness.ts";

const OWNER = "hack.e2e.cache-package-owner";
const BRANCH = "package-linked";
const TIMEOUT_MS = 60_000;
const IMAGE = "node:24.11.0-bookworm-slim";
const PACKAGE_VALUE = "installed-local-package-v1";
const INSTALL = `set -eu
echo install >> /deps/install-count
cp /fixture/install/package.json /fixture/install/package-lock.json /deps/
npm ci --prefix /deps --offline --ignore-scripts --no-audit --no-fund
`;
const VERIFY = `const fs = require("node:fs");
if (require("/deps/node_modules/hack-cache-fixture-package") !== require("/fixture/package")) process.exit(41);
if (fs.readFileSync("/deps/install-count", "utf8") !== "install\\n") process.exit(42);
`;
const GENERATE = `const fs = require("node:fs");
const value = require("/deps/node_modules/hack-cache-fixture-package");
const source = fs.readFileSync("/fixture/source", "utf8").trim();
const file = "/generated/result.json";
const count = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).count + 1 : 1;
fs.writeFileSync(file, JSON.stringify({ value, source, count }) + "\\n");
`;
const READ = `const fs = require("node:fs");
const result = JSON.parse(fs.readFileSync("/generated/result.json", "utf8"));
if (result.value !== require("/deps/node_modules/hack-cache-fixture-package")) process.exit(43);
if (fs.readFileSync("/deps/install-count", "utf8") !== "install\\n") process.exit(44);
console.log(JSON.stringify(result));
`;

type Resource = {
  readonly Id?: string;
  readonly Name?: string;
  readonly Labels?: Record<string, string>;
  readonly Config?: { readonly Labels: Record<string, string> };
  readonly Mounts?: readonly {
    readonly Type: string;
    readonly Name?: string;
    readonly Destination: string;
    readonly RW: boolean;
  }[];
};
type Generated = {
  readonly value: string;
  readonly source: string;
  readonly count: number;
};

/** Offline npm package installation; does not qualify registries or Bun. */
export const dependencyCachePackageScenario: Scenario = {
  name: "dependency-cache-package",
  tier: "docker",
  summary: "offline npm package reuse with per-instance generation and restart",
  run: async (ctx) => {
    const docker = (args: readonly string[]) =>
      runCommand({
        argv: ["docker", ...args],
        cwd: ctx.tempRoot,
        timeoutMs: TIMEOUT_MS,
      });
    const checkedDocker = async (args: readonly string[]) => {
      const result = await docker(args);
      expectExit({
        result,
        codes: [0],
        message: `docker ${args[0]} package fixture operation`,
      });
      return result;
    };
    const info = await docker(["info", "--format", "{{.Architecture}}"]);
    if (info.exitCode !== 0) {
      ctx.skip("Docker daemon unavailable");
    }
    const architectures: Record<string, string> = {
      arm64: "arm64",
      aarch64: "arm64",
      amd64: "amd64",
      x86_64: "amd64",
    };
    const arch = architectures[info.stdout.trim()];
    if (!arch) {
      ctx.skip("unsupported Docker daemon architecture");
    }
    const image = await checkedDocker([
      "image",
      "inspect",
      IMAGE,
      "--format",
      "{{json .RepoDigests}}",
    ]);
    const imageRef = (JSON.parse(image.stdout) as string[]).find((value) =>
      value.startsWith("node@sha256:")
    );
    expect({
      that: Boolean(imageRef),
      message:
        "existing Node image must have an immutable repository digest; no pulls allowed",
    });
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: { standaloneContainers: true, disableInternal: true },
    });
    const projects = [fixture.name, `${fixture.name}--${BRANCH}`];
    const scripts = join(fixture.root, "fixture");
    await mkdir(join(scripts, "package"), { recursive: true });
    for (const [name, content] of Object.entries({
      "install.sh": INSTALL,
      "verify.cjs": VERIFY,
      "generate.cjs": GENERATE,
      "read.cjs": READ,
      source: "primary-source\n",
      "package/package.json": JSON.stringify({
        name: "hack-cache-fixture-package",
        version: "1.0.0",
        main: "index.js",
      }),
      "package/index.js": `module.exports = "${PACKAGE_VALUE}";\n`,
    })) {
      await Bun.write(join(scripts, name), content);
    }
    const preparePackage = async (
      root: string,
      version: string,
      value: string
    ) => {
      const directory = join(root, "fixture");
      await mkdir(join(directory, "install"), { recursive: true });
      for (const [path, content] of Object.entries({
        "package/package.json": JSON.stringify({
          name: "hack-cache-fixture-package",
          version,
          main: "index.js",
        }),
        "package/index.js": `module.exports = ${JSON.stringify(value)};\n`,
        "install/package.json": JSON.stringify({
          name: "offline-fixture-consumer",
          version: "1.0.0",
          private: true,
          dependencies: {
            "hack-cache-fixture-package": "file:/fixture/package.tgz",
          },
        }),
      })) {
        await Bun.write(join(directory, `${path}.pending`), content);
        await rename(join(directory, `${path}.pending`), join(directory, path));
      }
      // Only this owned preparatory container writes the fixture tree. No
      // registry is reachable; npm records the actual local tarball integrity.
      const preparation = `const fs = require("node:fs");
const {execFileSync} = require("node:child_process");
const packed = JSON.parse(execFileSync("npm", ["pack", "/fixture/package", "--pack-destination", "/fixture", "--offline", "--ignore-scripts", "--json"], {encoding:"utf8"}));
fs.renameSync("/fixture/" + packed[0].filename, "/fixture/package.tgz");
fs.rmSync("/deps/package-lock.json", {force:true});
execFileSync("npm", ["install", "--prefix", "/deps", "--package-lock-only", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], {stdio:"inherit"});
fs.writeFileSync("/fixture/tarball.sha256", require("node:crypto").createHash("sha256").update(fs.readFileSync("/fixture/package.tgz")).digest("hex") + "\\n");`;
      const preparationName = `${fixture.name}-prepare-${crypto.randomUUID()}`;
      try {
        await checkedDocker([
          "run",
          "--rm",
          "--name",
          preparationName,
          "--pull=never",
          "--network=none",
          "--platform",
          `linux/${arch}`,
          "--label",
          `${OWNER}=${fixture.name}`,
          "--label",
          `com.docker.compose.project=${fixture.name}`,
          "--volume",
          `${directory}:/fixture`,
          "--volume",
          `${join(directory, "install")}:/deps`,
          imageRef as string,
          "node",
          "-e",
          preparation,
        ]);
      } finally {
        // --rm cannot clean a container left running after client timeout.
        const remaining = await checkedDocker([
          "ps",
          "-aq",
          "--filter",
          `name=^/${preparationName}$`,
        ]);
        for (const id of remaining.stdout.trim().split(/\s+/).filter(Boolean)) {
          const inspected = await checkedDocker(["inspect", id]);
          const item = (JSON.parse(inspected.stdout) as Resource[])[0];
          expect({
            that:
              item?.Name === `/${preparationName}` &&
              item.Config?.Labels[OWNER] === fixture.name &&
              item.Config.Labels["com.docker.compose.project"] === fixture.name,
            message:
              "refuse cleanup outside exact named preparation container ownership",
          });
          await checkedDocker(["rm", "-f", id]);
        }
        const gone = await checkedDocker([
          "ps",
          "-aq",
          "--filter",
          `name=^/${preparationName}$`,
        ]);
        expect({
          that: gone.stdout.trim() === "",
          message: "owned preparation container must be absent",
        });
      }
      const lock: unknown = await Bun.file(
        join(directory, "install/package-lock.json")
      ).json();
      const packages =
        isRecord(lock) && isRecord(lock.packages) ? lock.packages : {};
      const candidate = packages["node_modules/hack-cache-fixture-package"];
      const entry = isRecord(candidate) ? candidate : {};
      expect({
        that:
          entry?.version === version &&
          typeof entry.integrity === "string" &&
          entry.integrity.startsWith("sha512-") &&
          (entry.resolved === "file:/fixture/package.tgz" ||
            entry.resolved === "file:../fixture/package.tgz"),
        message:
          "npm lock must pin the actual offline package tarball version and integrity",
      });
      return entry.integrity as string;
    };
    const originalIntegrity = await preparePackage(
      fixture.root,
      "1.0.0",
      PACKAGE_VALUE
    );
    const base = {
      image: imageRef,
      platform: `linux/${arch}`,
      pull_policy: "never",
      network_mode: "none",
      labels: { [OWNER]: fixture.name },
    };
    const fixtureBind = "../fixture:/fixture:ro";
    await Bun.write(
      join(fixture.hackDir, "docker-compose.yml"),
      JSON.stringify(
        {
          name: fixture.name,
          services: {
            installer: {
              ...base,
              entrypoint: [],
              command: ["sh", "/fixture/install.sh"],
              labels: {
                ...base.labels,
                "hack.dependencies.cache-volume": "dependencies",
                "hack.dependencies.lockfiles":
                  "fixture/install/package-lock.json",
                "hack.dependencies.runtime-files":
                  "fixture/install.sh,fixture/verify.cjs,fixture/install/package.json,fixture/tarball.sha256,fixture/package/package.json,fixture/package/index.js",
                "hack.dependencies.cache-protocol": "locked-v1",
                "hack.dependencies.cache-generation": "0",
                "hack.dependencies.cache-verify": JSON.stringify([
                  "node",
                  "/fixture/verify.cjs",
                ]),
              },
              volumes: ["dependencies:/deps", fixtureBind],
            },
            generate: {
              ...base,
              command: ["node", "/fixture/generate.cjs"],
              depends_on: {
                installer: { condition: "service_completed_successfully" },
              },
              volumes: [
                "dependencies:/deps:ro",
                "generated:/generated",
                fixtureBind,
              ],
            },
            web: {
              ...base,
              command: [
                "node",
                "-e",
                'require("/fixture/read.cjs"); setInterval(() => {}, 1000)',
              ],
              depends_on: {
                installer: { condition: "service_completed_successfully" },
                generate: { condition: "service_completed_successfully" },
              },
              volumes: [
                "dependencies:/deps:ro",
                "generated:/generated:ro",
                fixtureBind,
              ],
            },
          },
          volumes: {
            dependencies: { labels: { [OWNER]: fixture.name } },
            generated: { labels: { [OWNER]: fixture.name } },
          },
        },
        null,
        2
      )
    );
    await commitAll({
      root: fixture.root,
      message: "offline package dependency fixture",
    });
    const linked = await addLinkedWorktree({ fixture, branch: BRANCH });
    // Publish source changes on a fresh inode for Docker's shared filesystem.
    await Bun.write(join(linked, "fixture/source.pending"), "linked-source\n");
    await rename(
      join(linked, "fixture/source.pending"),
      join(linked, "fixture/source")
    );
    const cli = async (cwd: string, args: readonly string[]) => {
      const result = await ctx.cli({
        cwd,
        args,
        env: { HACK_COMPOSE_STARTUP_TIMEOUT_MS: "50000" },
        timeoutMs: TIMEOUT_MS,
      });
      expectExit({
        result,
        codes: [0],
        message: `hack ${args.join(" ")} package fixture`,
      });
      return result;
    };
    const owned = (item: Resource) => {
      const labels = item.Config?.Labels ?? item.Labels ?? {};
      expect({
        that:
          labels[OWNER] === fixture.name &&
          projects.includes(labels["com.docker.compose.project"] ?? ""),
        message: "refuse operation outside exact package fixture ownership",
      });
      return labels;
    };
    const containers = async (project?: string, service?: string) => {
      const result = await checkedDocker([
        "ps",
        "-aq",
        "--filter",
        `label=${OWNER}=${fixture.name}`,
        ...(project
          ? ["--filter", `label=com.docker.compose.project=${project}`]
          : []),
        ...(service
          ? ["--filter", `label=com.docker.compose.service=${service}`]
          : []),
      ]);
      const ids = result.stdout.trim().split(/\s+/).filter(Boolean);
      if (!ids.length) {
        return [];
      }
      const inspected = await checkedDocker(["inspect", ...ids]);
      const items = JSON.parse(inspected.stdout) as Resource[];
      items.forEach(owned);
      return items;
    };
    const mounts = async (project: string) => {
      const items = await containers(project, "web");
      expect({
        that: items.length === 1,
        message: "one owned web container must exist",
      });
      const deps = items[0]?.Mounts?.find(
        (mount) => mount.Destination === "/deps"
      );
      const generated = items[0]?.Mounts?.find(
        (mount) => mount.Destination === "/generated"
      );
      expect({
        that:
          deps?.Type === "volume" &&
          !deps.RW &&
          deps.Name?.startsWith(`hack-cache-${fixture.name}-dependencies-`) ===
            true &&
          generated?.Type === "volume" &&
          !generated.RW,
        message:
          "app must read fingerprinted dependencies and instance generation through read-only mounts",
      });
      return { dependencies: deps?.Name, generated: generated?.Name };
    };
    const read = async (
      cwd: string,
      source: string,
      count: number,
      action = "exec",
      value = PACKAGE_VALUE
    ) => {
      const result = await cli(cwd, [
        action,
        "web",
        "--",
        "node",
        "/fixture/read.cjs",
      ]);
      const payload = extractJsonObject<Generated>({ text: result.stdout });
      expect({
        that:
          payload?.value === value &&
          payload.source === source &&
          payload.count === count,
        message: `actual package readback must match ${source} generation ${count}`,
        result,
      });
    };
    const installerOutcome = async (project: string, expected: string) => {
      const items = await containers(project, "installer");
      expect({
        that: items.length === 1,
        message: "one owned installer must exist",
      });
      const logs = await checkedDocker(["logs", items[0]?.Id as string]);
      expect({
        that: logs.stdout.includes(expected),
        message: "installer must report the expected protocol outcome",
        result: logs,
      });
    };
    try {
      await cli(fixture.root, ["up", "--detach"]);
      const primary = await mounts(fixture.name);
      await read(fixture.root, "primary-source", 1);
      await installerOutcome(
        fixture.name,
        "Dependency cache initialized (locked-v1)."
      );
      ctx.log(
        "offline npm tarball installed and primary generated output verified"
      );
      await cli(linked, ["up", "--detach"]);
      const branch = await mounts(projects[1] as string);
      expect({
        that:
          branch.dependencies === primary.dependencies &&
          branch.generated !== primary.generated,
        message:
          "linked instance must share installed package but own its generated output",
      });
      await installerOutcome(
        projects[1] as string,
        "Dependency cache ready (locked-v1)."
      );
      await read(linked, "linked-source", 1);
      await read(fixture.root, "primary-source", 1);
      await read(linked, "linked-source", 1, "run");
      ctx.log(
        "linked warm package reuse and distinct generated output verified by exec/run"
      );
      await cli(fixture.root, ["restart"]);
      const restarted = await mounts(fixture.name);
      expect({
        that:
          restarted.dependencies === primary.dependencies &&
          restarted.generated === primary.generated,
        message: "restart must preserve both volume identities",
      });
      await installerOutcome(
        fixture.name,
        "Dependency cache ready (locked-v1)."
      );
      await read(fixture.root, "primary-source", 2);
      await read(linked, "linked-source", 1);
      ctx.log(
        "restart reran primary generation without reinstalling or changing linked output"
      );
      const nextValue = "installed-local-package-v2";
      const nextIntegrity = await preparePackage(linked, "2.0.0", nextValue);
      expect({
        that: nextIntegrity !== originalIntegrity,
        message:
          "updated actual package must have a distinct npm lock integrity",
      });
      await read(linked, "linked-source", 1);
      await read(fixture.root, "primary-source", 2);
      await cli(linked, ["up", "--detach"]);
      const invalidated = await mounts(projects[1] as string);
      expect({
        that:
          invalidated.dependencies !== primary.dependencies &&
          invalidated.generated === branch.generated,
        message:
          "lockfile change must allocate fresh installed dependencies and preserve instance generation volume",
      });
      await installerOutcome(
        projects[1] as string,
        "Dependency cache initialized (locked-v1)."
      );
      await read(linked, "linked-source", 2, "exec", nextValue);
      await read(fixture.root, "primary-source", 2);
      ctx.log(
        "lockfile invalidation installed a fresh package cache and preserved primary state"
      );
    } catch (failure) {
      try {
        for (const item of await containers()) {
          const labels = owned(item);
          const logs = await docker([
            "logs",
            "--tail",
            "50",
            item.Id as string,
          ]);
          ctx.log(
            `${labels["com.docker.compose.project"]}/${labels["com.docker.compose.service"]}:\n${logs.combined.slice(-4000)}`
          );
        }
      } catch (diagnosticError) {
        ctx.log(
          `Package fixture diagnostics unavailable: ${String(diagnosticError)}`
        );
      }
      throw failure;
    } finally {
      for (const item of await containers()) {
        await checkedDocker(["rm", "-f", item.Id as string]);
      }
      const listed = await checkedDocker([
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=${OWNER}=${fixture.name}`,
      ]);
      for (const name of listed.stdout.trim().split(/\s+/).filter(Boolean)) {
        const inspected = await checkedDocker(["volume", "inspect", name]);
        const volume = (
          JSON.parse(inspected.stdout) as Resource[]
        )[0] as Resource;
        const labels = owned(volume);
        expect({
          that:
            volume.Name === name &&
            ["dependencies", "generated"].includes(
              labels["com.docker.compose.volume"] ?? ""
            ),
          message:
            "remove only this fixture's exact cache and generated volumes",
        });
        await checkedDocker(["volume", "rm", name]);
      }
      for (const args of [
        ["ps", "-aq"],
        ["volume", "ls", "-q"],
      ]) {
        const remaining = await checkedDocker([
          ...args,
          "--filter",
          `label=${OWNER}=${fixture.name}`,
        ]);
        expect({
          that: remaining.stdout.trim() === "",
          message: "all owned package fixture resources must be gone",
        });
      }
      ctx.log(
        "owned package fixture containers and volumes removed; absence verified"
      );
    }
  },
};
