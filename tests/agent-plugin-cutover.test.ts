import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installClaudeHooks } from "../src/agents/claude.ts";
import { prepareHackClaudePlugin } from "../src/agents/claude-plugin.ts";
import { prepareHackCodexPlugin } from "../src/agents/codex-plugin.ts";
import { renderCodexSkill } from "../src/agents/codex-skill.ts";
import { installCursorRules } from "../src/agents/cursor.ts";
import { prepareHackCursorPlugin } from "../src/agents/cursor-plugin.ts";
import type { AgentPluginResult } from "../src/agents/plugin-lifecycle.ts";
import { installMcpConfig } from "../src/mcp/install.ts";

type PluginState = "missing" | "disabled" | "enabled";
type Scope = "project" | "user";

type CutoverAdapter = {
  readonly name: string;
  readonly installLegacy: (opts: {
    readonly root: string;
    readonly scope: Scope;
  }) => Promise<string>;
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
      return join(root, ".cursor", "rules", "hack.mdc");
    },
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
      return join(root, ".claude", "skills", "hack-init", "SKILL.md");
    },
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
    installLegacy: async ({ root, scope }) => {
      const skillPath = join(root, ".codex", "skills", "hack-cli", "SKILL.md");
      await mkdir(dirname(skillPath), { recursive: true });
      await Bun.write(skillPath, renderCodexSkill());
      await installMcpConfig({
        targets: ["codex"],
        scope,
        projectRoot: scope === "project" ? root : undefined,
      });
      return skillPath;
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

afterEach(async () => {
  process.env.HOME = originalHome;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("native plugin cutover preserves legacy integrations until readiness", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-plugin-cutover-"));

  for (const adapter of adapters) {
    for (const state of ["missing", "disabled", "enabled"] as const) {
      for (const scope of ["project", "user"] as const) {
        for (const kind of ["generated", "customized"] as const) {
          const root = join(tempDir, adapter.name, state, scope, kind);
          await mkdir(root, { recursive: true });
          process.env.HOME = root;
          const primaryPath = await adapter.installLegacy({ root, scope });
          if (kind === "customized") {
            const content = await Bun.file(primaryPath).text();
            await Bun.write(primaryPath, `${content}\nUser customization\n`);
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
          expect(await Bun.file(primaryPath).exists(), context).toBe(
            kind === "customized"
          );
          expect(
            await adapter.hasCompleteLegacyIntegration({ root, scope }),
            context
          ).toBe(false);
        }
      }
    }
  }
});

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
