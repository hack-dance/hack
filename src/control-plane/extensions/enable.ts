import { resolve } from "node:path";
import { PROJECT_CONFIG_FILENAME } from "../../constants.ts";
import { resolveGlobalConfigPath } from "../../lib/config-paths.ts";
import { resolveHackInvocation } from "../../lib/hack-cli.ts";
import { gumConfirm, isGumAvailable } from "../../ui/gum.ts";
import { isTty } from "../../ui/terminal.ts";
import type { ResolvedExtension } from "./types.ts";

export type EnableInstruction = {
  readonly lines: readonly string[];
  readonly enableCommand?: {
    readonly argv: readonly string[];
    readonly printable: string;
    readonly prompt?: string;
  };
};

/**
 * Builds enable instructions for a disabled extension.
 * Determines whether to use global or project config based on extension scopes.
 */
export function buildEnableInstructions(opts: {
  readonly extension: ResolvedExtension;
  readonly namespace: string;
  readonly command?: string;
  readonly args?: readonly string[];
}): EnableInstruction {
  const rerun = buildRerunCommand({
    namespace: opts.namespace,
    command: opts.command,
    args: opts.args ?? [],
  });

  if (opts.extension.manifest.id === "dance.hack.gateway") {
    return {
      lines: [
        `Extension: ${opts.extension.manifest.id}`,
        "Enable with:",
        "  hack gateway enable",
        ...(rerun ? ["Re-run:", `  ${rerun}`] : []),
      ],
      enableCommand: {
        argv: ["gateway", "enable"],
        printable: "hack gateway enable",
        prompt: "Enable gateway for this project? (runs hack gateway enable)",
      },
    };
  }

  const key = `controlPlane.extensions["${opts.extension.manifest.id}"].enabled`;
  const enableScope = resolveExtensionEnableScope({
    extension: opts.extension,
  });
  const printable = enableScope.isGlobal
    ? `hack config set --global '${key}' true`
    : `hack config set '${key}' true`;

  return {
    lines: [
      `Extension: ${opts.extension.manifest.id}`,
      "Enable with:",
      `  ${printable}`,
      ...(rerun ? ["Re-run:", `  ${rerun}`] : []),
    ],
    enableCommand: {
      argv: enableScope.isGlobal
        ? ["config", "set", "--global", key, "true"]
        : ["config", "set", key, "true"],
      printable,
      prompt: enableScope.prompt,
    },
  };
}

function buildRerunCommand(opts: {
  readonly namespace: string;
  readonly command?: string;
  readonly args: readonly string[];
}): string | null {
  if (!opts.namespace) {
    return null;
  }
  const command = opts.command ? ` ${opts.command}` : "";
  const args = opts.args.length > 0 ? ` ${opts.args.join(" ")}` : "";
  return `hack ${opts.namespace}${command}${args}`;
}

/**
 * Determines whether an extension should be enabled globally or per-project.
 */
export function resolveExtensionEnableScope(opts: {
  readonly extension: ResolvedExtension;
}): { readonly isGlobal: boolean; readonly prompt?: string } {
  const isGlobal =
    opts.extension.manifest.scopes.includes("global") &&
    !opts.extension.manifest.scopes.includes("project");
  const prompt = isGlobal
    ? `Enable ${opts.extension.manifest.id}? (updates ${resolveGlobalConfigPath()})`
    : undefined;
  return { isGlobal, ...(prompt ? { prompt } : {}) };
}

/**
 * Resolves the config path that will be updated when enabling an extension.
 */
export function resolveConfigPathForEnable(opts: {
  readonly extension: ResolvedExtension;
  readonly projectDir?: string;
}): string | null {
  if (opts.extension.manifest.scopes.includes("global")) {
    return resolveGlobalConfigPath();
  }
  if (!opts.projectDir) {
    return null;
  }
  return resolve(opts.projectDir, PROJECT_CONFIG_FILENAME);
}

/**
 * Prompts user to enable an extension and runs the enable command if confirmed.
 * Returns true if the extension was enabled successfully.
 */
export async function maybeEnableExtension(opts: {
  readonly extension: ResolvedExtension;
  readonly namespace: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly projectDir?: string;
}): Promise<boolean> {
  if (!(opts.projectDir || opts.extension.manifest.scopes.includes("global"))) {
    return false;
  }
  if (!(isTty() && isGumAvailable())) {
    return false;
  }

  const instructions = buildEnableInstructions({
    extension: opts.extension,
    namespace: opts.namespace,
    command: opts.command,
    args: opts.args,
  });
  if (!instructions.enableCommand) {
    return false;
  }

  const configPath = instructions.enableCommand.prompt
    ? undefined
    : resolveConfigPathForEnable({
        extension: opts.extension,
        projectDir: opts.projectDir,
      });
  const prompt =
    instructions.enableCommand.prompt ??
    (configPath
      ? `Enable ${opts.extension.manifest.id}? (updates ${configPath})`
      : `Enable ${opts.extension.manifest.id}?`);
  const confirmed = await gumConfirm({ prompt, default: true });
  if (!(confirmed.ok && confirmed.value)) {
    return false;
  }

  const invocation = await resolveHackInvocation();
  const proc = Bun.spawn(
    [invocation.bin, ...invocation.args, ...instructions.enableCommand.argv],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  const exitCode = await proc.exited;
  return exitCode === 0;
}
