/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal Compose interpolation fixtures. */
import { expect, test } from "bun:test";
import { HackCliError } from "../src/lib/cli-result.ts";
import {
  describeNativeProcessRefusals,
  NATIVE_PROCESS_CHECK,
  NATIVE_PROCESS_WRAPPER_REFUSAL,
  nativeProcessCheckResult,
  nativeWrappedServiceCandidates,
  predictNativeProcessRefusals,
  readNativeProcessRefusals,
  requireWrappableNativeProcesses,
} from "../src/lib/native-process-wrappers.ts";

function predict(
  services: Record<string, Record<string, unknown>>,
  dependencies: string[] = []
) {
  return predictNativeProcessRefusals({
    services,
    wrapped: new Set(Object.keys(services)),
    dependencies: new Set(dependencies),
  });
}

test("stock images with relative entrypoints and health checks are wrappable", () => {
  expect(
    predict({
      db: {
        image: "mysql:8.0",
        healthcheck: { test: ["CMD", "mysqladmin", "ping", "-h", "localhost"] },
      },
      shell: {
        image: "postgres:16",
        healthcheck: { test: "pg_isready -U postgres" },
      },
      shellform: {
        image: "redis:7",
        healthcheck: { test: ["CMD-SHELL", "redis-cli ping"] },
      },
      relative: {
        image: "alpine:3.21",
        entrypoint: ["docker-entrypoint.sh"],
        command: ["serve"],
      },
      commandOnly: { image: "python:3", entrypoint: [], command: ["python3"] },
      numeric: { image: "node:22", user: "1000:1000" },
      root: { image: "node:22", user: 0 },
      probe: {
        image: "nginx",
        healthcheck: { test: ["CMD"], "x-hack-http": { path: "/" } },
      },
      disabled: { image: "nginx", healthcheck: { disable: true, test: [] } },
      interpolated: { image: "nginx", user: "${APP_UID:-1000}" },
    })
  ).toEqual([]);
});

test("Compose settings no wrapper can run are named by service and field", () => {
  expect(
    predict(
      {
        empty: { image: "alpine", entrypoint: [] },
        blank: { image: "alpine", entrypoint: "", command: [] },
        slash: { image: "alpine", entrypoint: ["/"] },
        health: { image: "alpine", healthcheck: { test: ["CMD"] } },
        shell: { image: "alpine", healthcheck: { test: "" } },
        named: { image: "postgres", user: "postgres" },
        group: { image: "postgres", user: "999:postgres" },
        signal: { image: "nginx", stop_signal: "SIGUSR1" },
        run: { image: "nginx", volumes: ["data:/run"] },
        launcher: {
          image: "nginx",
          volumes: [{ target: "/run/hack-environment.json" }],
        },
        relay: { image: "nginx", volumes: ["./x:/run/hack-startup/x:ro"] },
      },
      ["relay"]
    )
  ).toEqual([
    { service: "blank", field: "entrypoint" },
    { service: "empty", field: "entrypoint" },
    { service: "group", field: "user" },
    { service: "health", field: "healthcheck" },
    { service: "launcher", field: "mounts" },
    { service: "named", field: "user" },
    { service: "relay", field: "mounts" },
    { service: "run", field: "mounts" },
    { service: "shell", field: "healthcheck" },
    { service: "signal", field: "stop_signal" },
    { service: "slash", field: "entrypoint" },
  ]);
  // Release-barrier paths are reserved only for dependency services.
  expect(
    predict({ app: { image: "nginx", volumes: ["./x:/run/hack-startup/x"] } })
  ).toEqual([]);
});

test("only wrapped services and private-file owners are checked", () => {
  const services = {
    plain: { image: "postgres", user: "postgres", entrypoint: [] },
    files: { image: "postgres", user: "postgres", entrypoint: [] },
  };
  expect(
    predictNativeProcessRefusals({
      services,
      wrapped: new Set(),
      fileOwners: new Set(["files"]),
    })
  ).toEqual([{ service: "files", field: "user" }]);
});

test("the up preflight refuses before runtime work, naming every service and field", () => {
  let thrown: unknown;
  try {
    requireWrappableNativeProcesses({
      services: {
        db: { image: "postgres", user: "postgres" },
        web: { image: "nginx", healthcheck: { test: ["CMD"] } },
        idle: { image: "nginx", user: "nginx" },
      },
      managedEnvironment: { db: { PASSWORD: "synthetic" }, idle: {} },
      dependencyServices: ["web"],
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(HackCliError);
  expect(thrown).toHaveProperty("code", "E_NATIVE_PROJECT_UNSUPPORTED");
  expect((thrown as Error).message).toBe(
    `${NATIVE_PROCESS_WRAPPER_REFUSAL} Refused: service db user (use a numeric UID or UID:GID); service web healthcheck test (use an exec-form CMD test that names an executable).`
  );
  expect((thrown as Error).message).not.toContain("synthetic");
  expect((thrown as Error).message).not.toContain("postgres");
});

test("the runtime refusal list is accepted only in its closed, bounded form", () => {
  expect(
    readNativeProcessRefusals({
      version: 1,
      refusals: [{ service: "db", field: "stop_signal" }],
    })
  ).toEqual([{ service: "db", field: "stop_signal" }]);
  for (const value of [
    null,
    { version: 1 },
    { version: 1, refusals: [{ service: "db", field: "env" }] },
    { version: 1, refusals: [{ service: "", field: "user" }] },
    {
      version: 1,
      refusals: Array.from({ length: 33 }, (_, i) => ({
        service: `s${i}`,
        field: "user",
      })),
    },
  ]) {
    expect(readNativeProcessRefusals(value)).toBeUndefined();
  }
  expect(
    describeNativeProcessRefusals([{ service: "db", field: "mounts" }])
  ).toBe(
    "service db volume target (a volume target overlaps a path the wrapper reserves)"
  );
});

test("doctor predicts for every service when project-wide aliases exist", () => {
  const compose = {
    services: {
      api: { image: "node", user: "node" },
      gateway: {
        image: "nginx",
        user: "nginx",
        extra_hosts: ["api.example.test:host-gateway"],
      },
      secret: {
        image: "postgres",
        user: "postgres",
        environment: ["PASSWORD"],
      },
      literal: {
        image: "postgres",
        user: "postgres",
        environment: { MODE: "dev" },
      },
    },
  };
  const local = nativeWrappedServiceCandidates({
    compose,
    projectWideAliases: false,
  });
  expect([...local.wrapped].sort()).toEqual(["gateway", "secret"]);
  expect([...local.dependencies]).toEqual(["gateway"]);
  const wide = nativeWrappedServiceCandidates({
    compose,
    projectWideAliases: true,
  });
  const result = nativeProcessCheckResult(predictNativeProcessRefusals(wide));
  expect(result.name).toBe(NATIVE_PROCESS_CHECK);
  expect(result.status).toBe("warn");
  expect(result.nativeProcess.refusals.map((entry) => entry.service)).toEqual([
    "api",
    "gateway",
    "literal",
    "secret",
  ]);
  expect(result.message).toContain(
    "service api user (use a numeric UID or UID:GID)"
  );
  expect(nativeProcessCheckResult([]).status).toBe("ok");
});
