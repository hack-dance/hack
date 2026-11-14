import { expect, test } from "bun:test";
import {
  projectAutostartFromGlobal,
  readAutostartServiceReady,
  serializeAutostartGlobal,
  serializeProjectAutostart,
} from "../src/lib/autostart-view.ts";
import {
  getDefaultAutostartGlobal,
  type RegisteredProject,
} from "../src/lib/projects-registry.ts";

const project: RegisteredProject = {
  id: "example-id",
  name: "example",
  repoRoot: "/example/project",
  projectDir: "/example/project/.hack",
  projectDirName: ".hack",
  createdAt: "2026-01-01T00:00:00Z",
  autostart: {
    branch: null,
    paused: false,
    lastResult: null,
    lastAttemptBootId: "private-boot-id",
  },
};

test("desktop policy states distinguish off, starting, global pause and manual stop", () => {
  const global = serializeAutostartGlobal(
    {
      ...getDefaultAutostartGlobal(),
      loginRun: {
        runId: "private-run-id",
        bootId: "private-boot-id",
        inProgress: true,
        startedAt: "2026-01-01T00:00:00Z",
        pending: [project.id],
        started: ["ready-id"],
        failed: ["failed-id"],
      },
    },
    true
  );
  expect(projectAutostartFromGlobal({ project, global })).toMatchObject({
    enabled: true,
    state: "starting",
    paused_reason: null,
    failures: {
      count: 0,
      last_at: null,
      failed_services: [],
      last_error_code: null,
    },
    max_failures: 3,
  });
  expect(
    projectAutostartFromGlobal({ project, global: { ...global, paused: true } })
  ).toMatchObject({ state: "paused", paused_reason: null });
  expect(
    serializeProjectAutostart({ ...project.autostart!, paused: true })
  ).toMatchObject({ state: "paused", paused_reason: "manual_stop" });
  expect(
    serializeProjectAutostart({
      ...project.autostart!,
      paused: true,
      invalid: true,
    })
  ).toMatchObject({ state: "needs_attention", paused_reason: null });
  expect(serializeProjectAutostart(undefined)).toMatchObject({
    enabled: false,
    state: "off",
    paused_reason: null,
    max_failures: 3,
  });
  expect(global).toEqual({
    paused: false,
    service_ready: true,
    login_run: {
      in_progress: true,
      started_at: "2026-01-01T00:00:00Z",
      pending: ["example-id"],
      started: ["ready-id"],
      failed: ["failed-id"],
    },
  });
  expect(JSON.stringify(global)).not.toContain("private-");
});

for (const platform of ["linux", "darwin"]) {
  test(`${platform} service readiness uses only the injected installed-file observation`, async () => {
    const paths: string[] = [];
    expect(
      await readAutostartServiceReady({
        platform,
        env: {},
        servicePath: "/example/service",
        exists: (path) => {
          paths.push(path);
          return Promise.resolve(true);
        },
      })
    ).toBe(true);
    expect(paths).toEqual(["/example/service"]);
    expect(
      await readAutostartServiceReady({
        platform,
        env: {},
        servicePath: "/example/service",
        exists: async () => false,
      })
    ).toBe(false);
  });
  test(`${platform} service readiness honors disabled and isolated launchers without filesystem reads`, async () => {
    let reads = 0;
    for (const env of [
      { HACK_DAEMON_AUTOSTART_DISABLE: "1" },
      { HACK_HOME: "/example/isolated", HOME: "/example/home" },
      { HACK_CANDIDATE_ENTRYPOINT: "hack-next" },
    ]) {
      expect(
        await readAutostartServiceReady({
          platform,
          env,
          servicePath: "/example/service",
          exists: () => {
            reads += 1;
            return Promise.resolve(true);
          },
        })
      ).toBe(false);
    }
    expect(reads).toBe(0);
  });
}
