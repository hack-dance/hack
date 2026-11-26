import { describe, expect, test } from "bun:test";

import {
  buildLifecycleJsonErrorResult,
  composeEnginePreflightDeps,
} from "../src/commands/project.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import {
  type ComposeEnginePreflightDeps,
  inspectComposePlugin,
  preflightComposeEngine,
  preflightComposePlugin,
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

const ALL = { requested: [], profiles: [] } as const;

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
    expect(error?.startBlocker).toEqual({
      thing: "docker",
      problem: "cli missing · install docker engine with compose v2",
    });
    expect(calls).toEqual([]);
  });

  test("a docker on PATH that cannot be started is the same refusal as none", async () => {
    for (const code of ["ENOENT", "EACCES"]) {
      const error = await preflightComposeEngine({
        deps: {
          dockerOnPath: () => true,
          run: () =>
            Promise.reject(
              Object.assign(new Error(`spawn docker ${code}`), { code })
            ),
        },
      });
      expect(error?.code).toBe("E_DOCKER_UNAVAILABLE");
      expect(error?.message).toContain("no `docker` command");
    }
    // The same holds when docker goes away after the first read succeeds.
    const later = await preflightComposeEngine({
      deps: {
        dockerOnPath: () => true,
        run: (argv) =>
          argv[1] === "compose"
            ? Promise.reject(
                Object.assign(new Error("spawn docker ENOENT"), {
                  code: "ENOENT",
                })
              )
            : Promise.resolve(ok),
      },
    });
    expect(later?.code).toBe("E_DOCKER_UNAVAILABLE");
    const network = await preflightSharedNetworks({
      composeYaml: HELLO,
      selection: ALL,
      deps: {
        run: () =>
          Promise.reject(
            Object.assign(new Error("spawn docker EACCES"), { code: "EACCES" })
          ),
      },
    });
    expect(network?.code).toBe("E_DOCKER_UNAVAILABLE");
    // Any other failure is not diagnosed as a missing CLI.
    await expect(
      preflightComposeEngine({
        deps: {
          dockerOnPath: () => true,
          run: () => Promise.reject(new Error("unexpected")),
        },
      })
    ).rejects.toThrow("unexpected");
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
    expect(error?.startBlocker).toMatchObject({
      thing: "docker engine",
      problem:
        "unreachable · start docker or point your context at a running engine",
      which: expect.stringContaining("Cannot connect to the Docker daemon"),
    });
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
    expect(error?.startBlocker).toEqual({
      thing: "docker compose",
      problem:
        "v2 plugin missing · install docker-compose-v2 or docker-compose-plugin on debian or ubuntu",
    });
  });

  test("the plugin check alone reports the version or the missing plugin (HACK-2673)", async () => {
    const working = fakeDocker({
      "docker compose version": { exitCode: 0, stdout: "2.40.3\n", stderr: "" },
    });
    expect(await inspectComposePlugin({ deps: working.deps })).toEqual({
      ok: true,
      version: "2.40.3",
    });
    expect(working.calls).toEqual(["docker compose version --short"]);
    expect(await preflightComposePlugin({ deps: working.deps })).toBeNull();

    const missing = fakeDocker({
      "docker compose version": {
        exitCode: 1,
        stdout: "",
        stderr: "docker: unknown command: docker compose\n",
      },
    });
    const error = await preflightComposePlugin({ deps: missing.deps });
    expect(error?.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(error?.message).toContain("Docker Compose v2 plugin");
    expect(error?.message).toContain("docker-compose-plugin");
    expect(error?.message).not.toContain("443");
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
    const error = await preflightSharedNetworks({
      composeYaml: HELLO,
      selection: ALL,
      deps,
    });
    expect(error?.code).toBe("E_GLOBAL_INFRA_DOWN");
    expect(error?.message).toContain("hack global install");
    expect(error?.detail).toEqual({ network: "hack-dev" });
  });

  test("an existing network passes", async () => {
    const { deps, calls } = fakeDocker({});
    expect(
      await preflightSharedNetworks({
        composeYaml: HELLO,
        selection: ALL,
        deps,
      })
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
      await preflightSharedNetworks({
        composeYaml: HELLO,
        selection: ALL,
        deps,
      })
    ).toBeNull();
  });
});

describe("sharedExternalNetworks", () => {
  const FILE = `
services:
  web:
    image: web
    networks: [ingress, default]
    depends_on: [api]
  api:
    image: api
    networks:
      hack-logging: {}
  db:
    image: db
  tools:
    image: tools
    profiles: [tools]
    networks: [theirs, ingress]
networks:
  ingress:
    external: true
    name: hack-dev
  hack-logging:
    external: true
  theirs:
    external: true
`;

  test("lists Hack's shared networks the started services join, by engine name", () => {
    expect([...sharedExternalNetworks(FILE, ALL)].sort()).toEqual([
      "hack-dev",
      "hack-logging",
    ]);
  });

  test("a scoped up checks only the named services and what they depend on", () => {
    expect(
      sharedExternalNetworks(FILE, { requested: ["db"], profiles: [] })
    ).toEqual([]);
    expect(
      sharedExternalNetworks(FILE, { requested: ["api"], profiles: [] })
    ).toEqual(["hack-logging"]);
    expect(
      [
        ...sharedExternalNetworks(FILE, { requested: ["web"], profiles: [] }),
      ].sort()
    ).toEqual(["hack-dev", "hack-logging"]);
  });

  test("a service behind an inactive profile does not count", () => {
    const toolsOnly = `
services:
  tools:
    image: tools
    profiles: [tools]
    networks: [hack-dev]
networks:
  hack-dev:
    external: true
`;
    expect(sharedExternalNetworks(toolsOnly, ALL)).toEqual([]);
    expect(
      sharedExternalNetworks(toolsOnly, { requested: [], profiles: ["tools"] })
    ).toEqual(["hack-dev"]);
  });

  test("an optional dependency behind an inactive profile does not count", () => {
    const optional = `
services:
  web:
    image: web
    depends_on:
      tools:
        condition: service_started
        required: false
  tools:
    image: tools
    profiles: [tools]
    networks: [hack-dev]
networks:
  hack-dev:
    external: true
`;
    expect(
      sharedExternalNetworks(optional, { requested: ["web"], profiles: [] })
    ).toEqual([]);
    expect(
      sharedExternalNetworks(optional, {
        requested: ["web"],
        profiles: ["tools"],
      })
    ).toEqual(["hack-dev"]);
    // A required dependency is started whatever its profile.
    expect(
      sharedExternalNetworks(
        optional.replace("required: false", "required: true"),
        {
          requested: ["web"],
          profiles: [],
        }
      )
    ).toEqual(["hack-dev"]);
  });

  test("a service without networks joins the implicit default; network_mode joins none", () => {
    const implicit = `
services:
  web:
    image: web
networks:
  default:
    external: true
    name: hack-dev
`;
    expect(sharedExternalNetworks(implicit, ALL)).toEqual(["hack-dev"]);
    expect(
      sharedExternalNetworks(
        implicit.replace("image: web", "image: web\n    network_mode: host"),
        ALL
      )
    ).toEqual([]);
    // `extends` may inherit network_mode or other networks: not assumed.
    expect(
      sharedExternalNetworks(
        implicit.replace(
          "image: web",
          "image: web\n    extends:\n      file: base.yml\n      service: web"
        ),
        ALL
      )
    ).toEqual([]);
  });

  test("an unreadable or networkless file checks nothing", () => {
    expect(sharedExternalNetworks(null, ALL)).toEqual([]);
    expect(sharedExternalNetworks(": : not yaml [", ALL)).toEqual([]);
    expect(sharedExternalNetworks("services: {}\n", ALL)).toEqual([]);
  });
});

describe("missing env key", () => {
  test("is a closed E_ENV_KEY_MISSING error in text and JSON modes", () => {
    const error = new ProjectEnvKeyMissingError(
      "Missing project env key at /x."
    );
    // Text mode: the CLI's closed-error renderer prints `code: message`.
    expect(error).toBeInstanceOf(HackCliError);
    expect(error.code).toBe("E_ENV_KEY_MISSING");
    expect(buildLifecycleJsonErrorResult({ error })).toEqual({
      ok: false,
      error: {
        code: "E_ENV_KEY_MISSING",
        message: "Missing project env key at /x.",
      },
    });
  });
});

describe("preflight environment", () => {
  test("the real deps pass the project's Docker transport settings and nothing else from its env", async () => {
    const deps = composeEnginePreflightDeps({
      DOCKER_HOST: "ssh://dev@engine.example",
      SSH_AUTH_SOCK: "/run/project-agent.sock",
      CONTAINER_HOST: "unix:///run/podman.sock",
      API_TOKEN: "decrypted-project-value",
    });
    const result = await deps.run(
      [
        "sh",
        "-c",
        'printf "%s|%s|%s|%s" "$DOCKER_HOST" "$SSH_AUTH_SOCK" "$CONTAINER_HOST" "${API_TOKEN-unset}"',
      ],
      5000
    );
    // Engine selection and its transport apply; application values stay out.
    expect(result.stdout).toBe(
      "ssh://dev@engine.example|/run/project-agent.sock|unix:///run/podman.sock|unset"
    );
  });

  test("a quoted engine line redacts the project's env values", async () => {
    const { deps } = fakeDocker({
      "docker version": {
        exitCode: 1,
        stdout: "",
        stderr:
          "Cannot connect to the Docker daemon at unix:///run/project-secret-value.sock. Is the docker daemon running?\n",
      },
    });
    const error = await preflightComposeEngine({
      deps,
      redactValues: ["project-secret-value"],
    });
    expect(error?.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(error?.message).not.toContain("project-secret-value");
  });
});
