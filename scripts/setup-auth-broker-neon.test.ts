import { describe, expect, test } from "bun:test";

import { __testOnlyAuthBrokerNeonSetup } from "./setup-auth-broker-neon.ts";

describe("setup-auth-broker-neon parseArgs", () => {
  test("requires neon project", () => {
    const parsed = __testOnlyAuthBrokerNeonSetup.parseArgs({
      argv: [],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.message).toContain("--neon-project");
  });

  test("parses required and optional flags", () => {
    const parsed = __testOnlyAuthBrokerNeonSetup.parseArgs({
      argv: [
        "--neon-project=hack",
        "--neon-branch=main",
        "--neon-role=app_user",
        "--neon-database=hack",
        "--neon-pooled",
        "--skip-local",
        "--railway-project=hack",
        "--railway-service=auth-broker",
        "--railway-environment=production",
        "--railway-workspace=workspace",
        "--create-railway-service",
        "--dry-run",
        "--json",
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.args.neonProject).toBe("hack");
    expect(parsed.args.neonBranch).toBe("main");
    expect(parsed.args.neonRole).toBe("app_user");
    expect(parsed.args.neonDatabase).toBe("hack");
    expect(parsed.args.neonPooled).toBe(true);
    expect(parsed.args.skipLocal).toBe(true);
    expect(parsed.args.skipRailway).toBe(false);
    expect(parsed.args.railwayWorkspace).toBe("workspace");
    expect(parsed.args.createRailwayService).toBe(true);
    expect(parsed.args.dryRun).toBe(true);
    expect(parsed.args.json).toBe(true);
  });
});

describe("setup-auth-broker-neon json parsing", () => {
  test("extracts framed json payload", () => {
    const parsed = __testOnlyAuthBrokerNeonSetup.parseJsonOutput({
      text: 'noise...\n{"ok":true,"value":1}\n',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value).toEqual({ ok: true, value: 1 });
  });
});

describe("setup-auth-broker-neon Neon payload parsing", () => {
  test("extracts projects from neon projects payload", () => {
    const projects = __testOnlyAuthBrokerNeonSetup.extractNeonProjects({
      value: {
        projects: [
          { id: "proj-1", name: "Hack" },
          { id: "proj-2", name: "Sandbox" },
        ],
      },
    });
    expect(projects).toEqual([
      { id: "proj-1", name: "Hack" },
      { id: "proj-2", name: "Sandbox" },
    ]);
  });

  test("parses extended neon connection info", () => {
    const parsed = __testOnlyAuthBrokerNeonSetup.parseNeonConnectionInfo({
      value: {
        connection_string: "postgresql://user:pass@host/db",
        host: "host",
        role: "user",
        database: "db",
      },
    });
    expect(parsed).toEqual({
      connectionString: "postgresql://user:pass@host/db",
      host: "host",
      role: "user",
      database: "db",
    });
  });

  test("parses string-only neon connection output", () => {
    const parsed = __testOnlyAuthBrokerNeonSetup.parseNeonConnectionInfo({
      value: "postgresql://user:pass@host/db",
    });
    expect(parsed).toEqual({
      connectionString: "postgresql://user:pass@host/db",
      host: null,
      role: null,
      database: null,
    });
  });
});

describe("setup-auth-broker-neon better auth secret resolution", () => {
  test("uses explicit secret first", () => {
    const resolved = __testOnlyAuthBrokerNeonSetup.resolveBetterAuthSecret({
      explicit: "explicit-secret",
      envValue: "env-secret",
      localValue: "local-secret",
    });
    expect(resolved.source).toBe("arg");
    expect(resolved.value).toBe("explicit-secret");
  });

  test("generates secret when no sources exist", () => {
    const resolved = __testOnlyAuthBrokerNeonSetup.resolveBetterAuthSecret({
      explicit: null,
      envValue: "",
      localValue: "",
    });
    expect(resolved.source).toBe("generated");
    expect(resolved.value.length).toBeGreaterThan(16);
  });
});
