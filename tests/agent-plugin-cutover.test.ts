import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { installClaudeHooks } from "../src/agents/claude.ts";
import { prepareHackClaudePlugin } from "../src/agents/claude-plugin.ts";
import { prepareHackCodexPlugin } from "../src/agents/codex-plugin.ts";
import { renderCodexSkill } from "../src/agents/codex-skill.ts";
import { installCursorRules } from "../src/agents/cursor.ts";
import { prepareHackCursorPlugin } from "../src/agents/cursor-plugin.ts";
import type { AgentPluginResult } from "../src/agents/plugin-lifecycle.ts";
import { runCli } from "../src/cli/run.ts";
import { logInstallResult } from "../src/commands/project.ts";
import { installMcpConfig } from "../src/mcp/install.ts";

type PluginState = "missing" | "disabled" | "enabled";
type Scope = "project" | "user";
type LegacyKind = "generated" | "customized-primary" | "customized-mcp";

type LegacyArtifacts = {
  readonly primaryPath: string;
  readonly mcpPath: string;
};

type CutoverAdapter = {
  readonly name: string;
  readonly mcpMarker: string;
  readonly installLegacy: (opts: {
    readonly root: string;
    readonly scope: Scope;
  }) => Promise<LegacyArtifacts>;
  readonly customizeMcp: (opts: { readonly path: string }) => Promise<void>;
  readonly prepare: (opts: {
    readonly root: string;
    readonly scope: Scope;
    readonly state: PluginState;
  }) => Promise<AgentPluginResult<Scope>>;
  readonly hasCompleteLegacyIntegration: (opts: {
    readonly root: string;
    readonly scope: Scope;
  }) => Promise<boolean>;
};

const adapters: readonly CutoverAdapter[] = [
  {
    name: "cursor",
    mcpMarker: '"hack"',
    installLegacy: async ({ root, scope }) => {
      await installCursorRules({
        scope,
        projectRoot: scope === "project" ? root : undefined,
      });
      await installMcpConfig({
        targets: ["cursor"],
        scope,
        projectRoot: scope === "project" ? root : undefined,
      });
      return {
        primaryPath: join(root, ".cursor", "rules", "hack.mdc"),
        mcpPath: join(root, ".cursor", "mcp.json"),
      };
    },
    customizeMcp: customizeJsonMcp,
    prepare: async ({ root, scope, state }) =>
      await prepareHackCursorPlugin({
        scope,
        projectRoot: scope === "project" ? root : undefined,
        runCursorCommand: async () => ({
          exitCode: 0,
          stdout: JSON.stringify(
            state === "missing"
              ? []
              : [{ id: "hack@hack-dance", enabled: state === "enabled" }]
          ),
          stderr: "",
        }),
      }),
    hasCompleteLegacyIntegration: async ({ root }) => {
      const rulePath = join(root, ".cursor", "rules", "hack.mdc");
      const mcpPath = join(root, ".cursor", "mcp.json");
      return (
        (await Bun.file(rulePath).exists()) &&
        (await fileContains({ path: mcpPath, text: '"hack"' }))
      );
    },
  },
  {
    name: "claude",
    mcpMarker: '"hack"',
    installLegacy: async ({ root, scope }) => {
      await installClaudeHooks({
        scope,
        projectRoot: scope === "project" ? root : undefined,
      });
      await installMcpConfig({
        targets: ["claude"],
        scope,
        projectRoot: scope === "project" ? root : undefined,
      });
      return {
        primaryPath: join(root, ".claude", "skills", "hack-init", "SKILL.md"),
        mcpPath: join(root, ".claude", "settings.json"),
      };
    },
    customizeMcp: customizeJsonMcp,
    prepare: async ({ root, scope, state }) =>
      await prepareHackClaudePlugin({
        scope,
        projectRoot: scope === "project" ? root : undefined,
        runClaudeCommand: async () => ({
          exitCode: 0,
          stdout: JSON.stringify(
            state === "missing"
              ? []
              : [{ id: "hack@hack-dance", enabled: state === "enabled" }]
          ),
          stderr: "",
        }),
      }),
    hasCompleteLegacyIntegration: async ({ root, scope }) => {
      const skillPath = join(
        root,
        ".claude",
        "skills",
        "hack-init",
        "SKILL.md"
      );
      const hooksPath = join(
        root,
        ".claude",
        scope === "user" ? "settings.json" : "settings.local.json"
      );
      const mcpPath = join(root, ".claude", "settings.json");
      return (
        (await Bun.file(skillPath).exists()) &&
        (await fileContains({ path: hooksPath, text: "hack agent prime" })) &&
        (await fileContains({ path: mcpPath, text: '"hack"' }))
      );
    },
  },
  {
    name: "codex",
    mcpMarker: "mcp_servers.hack",
    installLegacy: async ({ root, scope }) => {
      const skillPath = join(root, ".codex", "skills", "hack-cli", "SKILL.md");
      await mkdir(dirname(skillPath), { recursive: true });
      await Bun.write(skillPath, renderCodexSkill());
      await installMcpConfig({
        targets: ["codex"],
        scope,
        projectRoot: scope === "project" ? root : undefined,
      });
      return {
        primaryPath: skillPath,
        mcpPath: join(root, ".codex", "config.toml"),
      };
    },
    customizeMcp: async ({ path }) => {
      const content = await Bun.file(path).text();
      await Bun.write(
        path,
        content.replace('command = "hack"', 'command = "custom-hack"')
      );
    },
    prepare: async ({ root, scope, state }) =>
      await prepareHackCodexPlugin({
        scope,
        projectRoot: scope === "project" ? root : undefined,
        runCodexCommand: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            installed:
              state === "missing"
                ? []
                : [
                    {
                      name: "hack",
                      marketplaceName: "hack-dance",
                      installed: true,
                      enabled: state === "enabled",
                    },
                  ],
          }),
          stderr: "",
        }),
      }),
    hasCompleteLegacyIntegration: async ({ root }) => {
      const skillPath = join(root, ".codex", "skills", "hack-cli", "SKILL.md");
      const mcpPath = join(root, ".codex", "config.toml");
      return (
        (await Bun.file(skillPath).exists()) &&
        (await fileContains({ path: mcpPath, text: "mcp_servers.hack" }))
      );
    },
  },
];

let tempDir: string | null = null;
const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
const originalHackHome = process.env.HACK_HOME;
const originalNoInteractive = process.env.HACK_NO_INTERACTIVE;
const originalSyncMode = process.env.HACK_SETUP_SYNC_MODE;

afterEach(async () => {
  process.env.HOME = originalHome;
  restoreEnv({ key: "PATH", value: originalPath });
  restoreEnv({ key: "HACK_HOME", value: originalHackHome });
  restoreEnv({ key: "HACK_NO_INTERACTIVE", value: originalNoInteractive });
  restoreEnv({ key: "HACK_SETUP_SYNC_MODE", value: originalSyncMode });
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("direct setup commands reject preserved customizations for every client and scope", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-plugin-setup-command-"));
  const binDir = await installReadyPluginStubs({ root: tempDir });
  process.env.PATH = [binDir, originalPath].filter(Boolean).join(delimiter);
  process.env.HACK_NO_INTERACTIVE = "1";
  process.env.HACK_SETUP_SYNC_MODE = "off";

  for (const adapter of adapters) {
    for (const scope of ["project", "user"] as const) {
      for (const kind of ["customized-primary", "customized-mcp"] as const) {
        const root = join(tempDir, "commands", adapter.name, scope, kind);
        await mkdir(root, { recursive: true });
        process.env.HOME = root;
        process.env.HACK_HOME = join(root, ".hack-home");
        const artifacts = await adapter.installLegacy({ root, scope });
        const customizedPath =
          kind === "customized-primary"
            ? artifacts.primaryPath
            : artifacts.mcpPath;
        if (kind === "customized-primary") {
          const content = await Bun.file(customizedPath).text();
          await Bun.write(customizedPath, `${content}\nUser customization\n`);
        } else {
          await adapter.customizeMcp({ path: customizedPath });
        }
        const customizedBytes = await Bun.file(customizedPath).bytes();

        const exitCode = await runCli([
          "setup",
          adapter.name,
          ...(scope === "project" ? ["--path", root] : ["--global"]),
        ]);
        const context = `${adapter.name}/${scope}/${kind}`;
        expect(exitCode, context).toBe(1);
        if (kind === "customized-primary") {
          expect(await Bun.file(customizedPath).bytes(), context).toEqual(
            customizedBytes
          );
        } else {
          expect(
            await fileContains({ path: customizedPath, text: "custom-hack" }),
            context
          ).toBe(true);
        }
      }
    }
  }
});

test("setup sync rejects preserved customizations for every client and scope", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-plugin-sync-command-"));
  const binDir = await installReadyPluginStubs({ root: tempDir });
  process.env.PATH = [binDir, originalPath].filter(Boolean).join(delimiter);
  process.env.HACK_NO_INTERACTIVE = "1";
  process.env.HACK_SETUP_SYNC_MODE = "off";

  for (const kind of ["customized-primary", "customized-mcp"] as const) {
    const caseRoot = join(tempDir, kind);
    const projectRoot = join(caseRoot, "repo");
    const userRoot = join(caseRoot, "home");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userRoot, { recursive: true });
    process.env.HOME = userRoot;
    process.env.HACK_HOME = join(userRoot, ".hack-home");

    const customizedArtifacts: Array<{
      readonly path: string;
      readonly content: string;
    }> = [];
    for (const adapter of adapters) {
      for (const scope of ["project", "user"] as const) {
        const root = scope === "project" ? projectRoot : userRoot;
        const artifacts = await adapter.installLegacy({ root, scope });
        const path =
          kind === "customized-primary"
            ? artifacts.primaryPath
            : artifacts.mcpPath;
        if (kind === "customized-primary") {
          const content = await Bun.file(path).text();
          await Bun.write(path, `${content}\nUser customization\n`);
        } else {
          await adapter.customizeMcp({ path });
        }
        customizedArtifacts.push({
          path,
          content: await Bun.file(path).text(),
        });
      }
    }

    const exitCode = await runCli([
      "setup",
      "sync",
      "--all-scopes",
      "--path",
      projectRoot,
    ]);
    expect(exitCode, kind).toBe(1);
    for (const artifact of customizedArtifacts) {
      if (kind === "customized-primary") {
        expect(await Bun.file(artifact.path).text(), artifact.path).toBe(
          artifact.content
        );
      } else {
        expect(
          await fileContains({ path: artifact.path, text: "custom-hack" }),
          artifact.path
        ).toBe(true);
      }
    }
  }
});

test("interactive init treats preserved plugin cleanup as incomplete", () => {
  expect(
    logInstallResult({
      label: "Hack Codex plugin",
      status: "noop",
      cleanupStatus: "preserved",
      path: "/repo/.codex/config.toml",
      message: "Preserved customized MCP config.",
    })
  ).toBe(false);
});

test("native plugin cutover preserves legacy integrations until readiness", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-plugin-cutover-"));

  for (const adapter of adapters) {
    for (const state of ["missing", "disabled", "enabled"] as const) {
      for (const scope of ["project", "user"] as const) {
        for (const kind of [
          "generated",
          "customized-primary",
          "customized-mcp",
        ] as const satisfies readonly LegacyKind[]) {
          const root = join(tempDir, adapter.name, state, scope, kind);
          await mkdir(root, { recursive: true });
          process.env.HOME = root;
          const artifacts = await adapter.installLegacy({ root, scope });
          if (kind === "customized-primary") {
            const content = await Bun.file(artifacts.primaryPath).text();
            await Bun.write(
              artifacts.primaryPath,
              `${content}\nUser customization\n`
            );
          } else if (kind === "customized-mcp") {
            await adapter.customizeMcp({ path: artifacts.mcpPath });
          }

          const result = await adapter.prepare({ root, scope, state });
          const context = `${adapter.name}/${state}/${scope}/${kind}`;
          if (state !== "enabled") {
            expect(result.status, context).toBe(
              state === "missing" ? "missing" : "stale"
            );
            expect(result.cleanupStatus, context).toBeUndefined();
            expect(
              await adapter.hasCompleteLegacyIntegration({ root, scope }),
              context
            ).toBe(true);
            continue;
          }

          expect(result.status, context).toBe("noop");
          expect(result.cleanupStatus, context).toBe(
            kind === "generated" ? "removed" : "preserved"
          );
          expect(await Bun.file(artifacts.primaryPath).exists(), context).toBe(
            kind === "customized-primary"
          );
          expect(
            await fileContains({
              path: artifacts.mcpPath,
              text: adapter.mcpMarker,
            }),
            context
          ).toBe(kind === "customized-mcp");
          expect(
            await adapter.hasCompleteLegacyIntegration({ root, scope }),
            context
          ).toBe(false);
        }
      }
    }
  }
});

async function customizeJsonMcp({ path }: { readonly path: string }) {
  const config = (await Bun.file(path).json()) as {
    mcpServers: Record<string, { command: string }>;
  };
  config.mcpServers.hack = { command: "custom-hack" };
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
}

async function installReadyPluginStubs({
  root,
}: {
  readonly root: string;
}): Promise<string> {
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const clients = [
    {
      name: "cursor-agent",
      output: [{ id: "hack@hack-dance", enabled: true }],
    },
    {
      name: "claude",
      output: [{ id: "hack@hack-dance", enabled: true }],
    },
    {
      name: "codex",
      output: {
        installed: [
          {
            name: "hack",
            marketplaceName: "hack-dance",
            installed: true,
            enabled: true,
          },
        ],
      },
    },
  ] as const;
  for (const client of clients) {
    const path = join(binDir, client.name);
    await Bun.write(
      path,
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(client.output)}'\n`
    );
    await chmod(path, 0o755);
  }
  return binDir;
}

function restoreEnv({
  key,
  value,
}: {
  readonly key: string;
  readonly value: string | undefined;
}): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

async function fileContains({
  path,
  text,
}: {
  readonly path: string;
  readonly text: string;
}): Promise<boolean> {
  if (!(await Bun.file(path).exists())) {
    return false;
  }
  return (await Bun.file(path).text()).includes(text);
}
