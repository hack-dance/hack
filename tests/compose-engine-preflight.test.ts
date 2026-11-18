import { describe, expect, test } from "bun:test";

import { buildLifecycleJsonErrorResult } from "../src/commands/project.ts";
import {
  type ComposeEnginePreflightDeps,
  preflightComposeEngine,
  preflightSharedNetworks,
  sharedExternalNetworks,
} from "../src/lib/compose-engine-preflight.ts";
import type { ComposePsProcessResult } from "../src/lib/compose-ps-result.ts";
import { ProjectEnvKeyMissingError } from "../src/lib/project-env-config.ts";

const ok: ComposePsProcessResult = {
  exitCode: 0,
  stdout: "29.1.3\n",
  stderr: "",
};

/** Fake Docker answering by the argv's first words; records every call. */
function fakeDocker(answers: Record<string, ComposePsProcessResult>): {
  readonly deps: ComposeEnginePreflightDeps;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      dockerOnPath: () => true,
      run: async (argv) => {
        const key = argv.join(" ");
        calls.push(key);
        const match = Object.keys(answers).find((prefix) =>
          key.startsWith(prefix)
        );
        return match === undefined ? ok : (answers[match] ?? ok);
      },
    },
  };
}

const HELLO = `
services:
  web:
    image: busybox:1.36
    networks: [hack-dev, default]
networks:
  hack-dev:
    external: true
`;

describe("preflightComposeEngine", () => {
  test("no docker on PATH names what to install and runs nothing", async () => {
    const calls: string[] = [];
    const error = await preflightComposeEngine({
      deps: {
        dockerOnPath: () => false,
        run: async (argv) => {
          calls.push(argv.join(" "));
          return ok;
        },
      },
    });
    expect(error?.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(error?.message).toContain("no `docker` command");
    expect(error?.message).toContain("Docker Compose v2");
    expect(calls).toEqual([]);
  });

  test("a denied socket is E_PERMISSION before Compose runs", async () => {
    const { deps, calls } = fakeDocker({
      "docker version": {
        exitCode: 1,
        stdout: "",
        stderr:
          'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.51/version": dial unix /var/run/docker.sock: connect: permission denied\n',
      },
    });
    const error = await preflightComposeEngine({ deps });
    expect(error?.code).toBe("E_PERMISSION");
    expect(error?.message).toContain("docker group");
    expect(calls).toEqual(["docker version --format {{.Server.Version}}"]);
  });

  test("a stopped engine is E_DOCKER_UNAVAILABLE with the client's line", async () => {
    const { deps } = fakeDocker({
      "docker version": {
        exitCode: 1,
        stdout: "",
        stderr:
          "Cannot connect to the Docker daemon at unix:///tmp/none.sock. Is the docker daemon running?\n",
      },
    });
    const error = await preflightComposeEngine({ deps });
    expect(error?.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(error?.message).toContain("not reachable");
    expect(error?.message).toContain(
      "Engine said: Cannot connect to the Docker daemon at unix:///tmp/none.sock."
    );
  });

  test("a hung engine names the command that timed out", async () => {
    const { deps } = fakeDocker({
      "docker version": { exitCode: 124, stdout: "", stderr: "" },
    });
    const error = await preflightComposeEngine({ deps });
    expect(error?.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(error?.message).toStartWith("docker version did not finish");
  });

  test("an unrecognized docker version failure is left to Compose", async () => {
    const { deps } = fakeDocker({
      "docker version": { exitCode: 1, stdout: "", stderr: "something else\n" },
    });
    expect(await preflightComposeEngine({ deps })).toBeNull();
  });

  test("a missing Compose plugin names the package", async () => {
    const { deps } = fakeDocker({
      "docker compose version": {
        exitCode: 1,
        stdout: "",
        stderr: "docker: 'compose' is not a docker command.\n",
      },
    });
    const error = await preflightComposeEngine({ deps });
    expect(error?.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(error?.message).toContain("Docker Compose v2 plugin");
  });

  test("a working engine and plugin pass", async () => {
    const { deps, calls } = fakeDocker({});
    expect(await preflightComposeEngine({ deps })).toBeNull();
    expect(calls).toEqual([
      "docker version --format {{.Server.Version}}",
      "docker compose version --short",
    ]);
  });
});

describe("preflightSharedNetworks", () => {
  test("a missing hack-dev network says to run hack global install", async () => {
    const { deps } = fakeDocker({
      "docker network inspect": {
        exitCode: 1,
        stdout: "",
        stderr: "Error response from daemon: network hack-dev not found\n",
      },
    });
    const error = await preflightSharedNetworks({ composeYaml: HELLO, deps });
    expect(error?.code).toBe("E_GLOBAL_INFRA_DOWN");
    expect(error?.message).toContain("hack global install");
    expect(error?.detail).toEqual({ network: "hack-dev" });
  });

  test("an existing network passes", async () => {
    const { deps, calls } = fakeDocker({});
    expect(
      await preflightSharedNetworks({ composeYaml: HELLO, deps })
    ).toBeNull();
    expect(calls).toEqual([
      "docker network inspect --format {{.Name}} hack-dev",
    ]);
  });

  test("an unrecognized inspect failure is left to Compose", async () => {
    const { deps } = fakeDocker({
      "docker network inspect": { exitCode: 1, stdout: "", stderr: "odd\n" },
    });
    expect(
      await preflightSharedNetworks({ composeYaml: HELLO, deps })
    ).toBeNull();
  });
});

describe("sharedExternalNetworks", () => {
  test("lists only Hack's shared networks declared external, by engine name", () => {
    expect(
      sharedExternalNetworks(`
networks:
  ingress:
    external: true
    name: hack-dev
  hack-logging:
    external: true
  theirs:
    external: true
  hack-dev-local: {}
`)
    ).toEqual(["hack-dev", "hack-logging"]);
  });

  test("an unreadable or networkless file checks nothing", () => {
    expect(sharedExternalNetworks(null)).toEqual([]);
    expect(sharedExternalNetworks(": : not yaml [")).toEqual([]);
    expect(sharedExternalNetworks("services: {}\n")).toEqual([]);
  });
});

describe("lifecycle JSON errors", () => {
  test("a missing project env key keeps its message under E_ENV_KEY_MISSING", () => {
    const result = buildLifecycleJsonErrorResult({
      error: new ProjectEnvKeyMissingError("Missing project env key at /x."),
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "E_ENV_KEY_MISSING",
        message: "Missing project env key at /x.",
      },
    });
  });
});
