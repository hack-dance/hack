import { pathExists } from "./fs.ts";
import { isMac } from "./os.ts";
import { type ExecResult, exec, findExecutableInPath } from "./shell.ts";

export type DockerBackendId = "docker-desktop" | "orbstack" | "docker-systemd";

export type DockerBackend = {
  readonly id: DockerBackendId;
  readonly name: string;
  readonly startCommand: readonly string[];
};

type DetectDockerBackendDeps = {
  readonly findExecutableInPath?: typeof findExecutableInPath;
  readonly isMac?: boolean;
  readonly pathExists?: typeof pathExists;
};

type DockerStatusProbeDeps = {
  readonly exec?: typeof exec;
  readonly findExecutableInPath?: typeof findExecutableInPath;
};

export async function detectDockerBackend(
  deps: DetectDockerBackendDeps = {}
): Promise<DockerBackend | null> {
  const onMac = deps.isMac ?? isMac();
  const hasPath = deps.pathExists ?? pathExists;
  const findOnPath = deps.findExecutableInPath ?? findExecutableInPath;

  if (onMac) {
    if (await hasPath("/Applications/Docker.app")) {
      return {
        id: "docker-desktop",
        name: "Docker Desktop",
        startCommand: ["open", "-a", "Docker"],
      };
    }

    if (await hasPath("/Applications/OrbStack.app")) {
      const hasOrbctl = await findOnPath("orbctl");
      return {
        id: "orbstack",
        name: "OrbStack",
        startCommand: hasOrbctl
          ? ["orbctl", "start"]
          : ["open", "-a", "OrbStack"],
      };
    }

    return null;
  }

  const hasDocker = await findOnPath("docker");
  const hasSystemctl = hasDocker ? await findOnPath("systemctl") : null;
  if (hasDocker && hasSystemctl) {
    return {
      id: "docker-systemd",
      name: "Docker (systemd)",
      startCommand: ["sudo", "systemctl", "start", "docker"],
    };
  }

  return null;
}

export function extractDockerFailureText(opts: {
  readonly stderr: string;
  readonly stdout: string;
}): string | null {
  const firstLine = `${opts.stderr}\n${opts.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ?? null;
}

export function buildDockerStartStep(opts: {
  readonly backend: string;
  readonly retryCommand: string;
}): string {
  if (opts.backend === "Docker Desktop") {
    return `Start Docker Desktop, wait for it to finish launching, then rerun ${opts.retryCommand}`;
  }

  if (opts.backend === "OrbStack") {
    return `Start OrbStack, wait for Docker to become ready, then rerun ${opts.retryCommand}`;
  }

  if (opts.backend === "Docker (systemd)") {
    return `Start the Docker system service, then rerun ${opts.retryCommand}`;
  }

  return `Start Docker, then rerun ${opts.retryCommand}`;
}

export function formatDockerConnectionGuidance(opts: {
  readonly backend: DockerBackend | null;
  readonly failureText: string | null;
  readonly retryCommand?: string;
}): string {
  const retryCommand = opts.retryCommand ?? "hack doctor";
  const message = opts.failureText?.trim() || "Docker daemon is not reachable";

  if (!opts.backend) {
    return `${message} | Install or start Docker, then rerun ${retryCommand}`;
  }

  return `${message} | Detected backend: ${opts.backend.name} | ${buildDockerStartStep(
    {
      backend: opts.backend.name,
      retryCommand,
    }
  )}`;
}

export async function buildDockerStatusProbe(
  deps: DockerStatusProbeDeps = {}
): Promise<{
  readonly reachable: boolean;
  readonly result: ExecResult | null;
}> {
  const findOnPath = deps.findExecutableInPath ?? findExecutableInPath;
  if (!findOnPath("docker")) {
    return { reachable: false, result: null };
  }

  const runExec = deps.exec ?? exec;
  const result = await runExec(["docker", "info"], { stdin: "ignore" });
  return { reachable: result.exitCode === 0, result };
}
