/**
 * macOS System-keychain trust for Hack's Caddy Local CA (`hack global trust`
 * and `hack global install`). The one root command is built here, so
 * `--plan` prints exactly what this runs (HACK-2218).
 */
import { note } from "@clack/prompts";
import {
  confirmSafe,
  isExplicitlyNonInteractive,
} from "../lib/interactivity.ts";
import { checkMacCaTrust } from "../lib/mac-ca-trust.ts";
import { exec, run } from "../lib/shell.ts";
import { logger } from "../ui/logger.ts";

export const MAC_SYSTEM_KEYCHAIN_PATH = "/Library/Keychains/System.keychain";

/** The PATH `sudo` probe used before a non-interactive install. */
export const MAC_SUDO_PROBE_ARGV = ["sudo", "-n", "true"] as const;

/** The root command that trusts the exported CA for TLS, system-wide. */
export function macTrustAddArgv(certPath: string): readonly string[] {
  return [
    "sudo",
    "security",
    "add-trusted-cert",
    "-d",
    "-r",
    "trustRoot",
    "-k",
    MAC_SYSTEM_KEYCHAIN_PATH,
    certPath,
  ];
}

export type MacTrustCheck = Awaited<ReturnType<typeof checkMacCaTrust>>;

/**
 * What the trust step will do with the CA at `certPath`, from read-only
 * keychain queries: nothing (already trusted, or not eligible), or the
 * exact root command.
 */
export type PreparedMacTrust =
  | { readonly status: "trusted" }
  | { readonly status: "ineligible"; readonly issue: string }
  | { readonly status: "ready"; readonly argv: readonly string[] };

export async function prepareMacTrust(input: {
  readonly certPath: string;
  readonly checkTrust?: (input: {
    readonly certPath: string;
  }) => Promise<MacTrustCheck>;
}): Promise<PreparedMacTrust> {
  const existing = await (input.checkTrust ?? checkMacCaTrust)({
    certPath: input.certPath,
  });
  if (!existing.installable) {
    return {
      status: "ineligible",
      issue:
        existing.issue ??
        "Current Caddy Local CA is not eligible for installation",
    };
  }
  if (existing.trusted) {
    return { status: "trusted" };
  }
  return { status: "ready", argv: macTrustAddArgv(input.certPath) };
}

export type PreparedMacTrustPlan =
  | PreparedMacTrust
  | {
      readonly status: "unknown";
      readonly issue: string;
    };

/**
 * Bound plan-only keychain reads. A timed-out or unstartable security process
 * cannot establish whether the real command would skip or install trust.
 * Execution retains its existing checks through `prepareMacTrust`.
 */
export async function prepareMacTrustForPlan(input: {
  readonly certPath: string;
  readonly timeoutMs: number;
  readonly execute?: typeof exec;
}): Promise<PreparedMacTrustPlan> {
  let unreadable = false;
  const prepared = await prepareMacTrust({
    certPath: input.certPath,
    checkTrust: async ({ certPath }) =>
      await checkMacCaTrust({
        certPath,
        exec: async (argv, opts) => {
          const result = await (input.execute ?? exec)(argv, {
            ...opts,
            timeoutMs: input.timeoutMs,
          }).catch(() => null);
          if (
            result === null ||
            result.exitCode === 124 ||
            result.exitCode === 127
          ) {
            unreadable = true;
          }
          return result ?? { exitCode: 127, stdout: "", stderr: "" };
        },
      }),
  });
  return unreadable
    ? {
        status: "unknown",
        issue:
          "The System keychain could not be read within the plan's probe deadline",
      }
    : prepared;
}

/** Effects of {@link ensureMacTrustCaddyLocalCa}; injectable for tests. */
export type MacTrustDeps = {
  readonly confirm: () => Promise<boolean>;
  readonly checkTrust: (input: {
    readonly certPath: string;
  }) => Promise<MacTrustCheck>;
  readonly explicitlyNonInteractive: () => boolean;
  /** `sudo -n true` with stdin ignored; its exit code. */
  readonly probe: (argv: readonly string[]) => Promise<number>;
  /** A root command with the terminal attached; its exit code. */
  readonly runRoot: (argv: readonly string[]) => Promise<number>;
};

function defaultDeps(): MacTrustDeps {
  return {
    confirm: async () =>
      await confirmSafe({
        message:
          "Trust Caddy Local CA in macOS System keychain? (enables trusted https://*.hack; requires sudo)",
        initialValue: true,
        nonInteractive: "accept-default",
      }),
    checkTrust: checkMacCaTrust,
    explicitlyNonInteractive: isExplicitlyNonInteractive,
    probe: async (argv) =>
      (await exec([...argv], { stdin: "ignore" })).exitCode,
    runRoot: async (argv) => await run([...argv], { stdin: "inherit" }),
  };
}

export async function ensureMacTrustCaddyLocalCa(
  input: { readonly certPath: string },
  deps: MacTrustDeps = defaultDeps()
): Promise<boolean> {
  if (!(await deps.confirm())) {
    logger.info({
      message:
        "Skipped macOS System keychain trust; leaving host TLS env unchanged.",
    });
    return false;
  }

  const prepared = await prepareMacTrust({
    certPath: input.certPath,
    checkTrust: deps.checkTrust,
  });
  if (prepared.status === "ineligible") {
    logger.warn({ message: prepared.issue });
    return false;
  }
  if (prepared.status === "trusted") {
    logger.info({
      message: "Current Caddy Local CA is trusted in macOS System keychain",
    });
    return true;
  }

  if (
    deps.explicitlyNonInteractive() &&
    (await deps.probe(MAC_SUDO_PROBE_ARGV)) !== 0
  ) {
    logger.info({
      message:
        "Skipped macOS System keychain trust (non-interactive; sudo would prompt for a password). Run `hack global trust` interactively to finish browser trust.",
    });
    return false;
  }

  logger.step({
    message: "Installing Caddy Local CA to System keychain (requires sudo)…",
  });
  const installExit = await deps.runRoot(prepared.argv);

  if (installExit !== 0) {
    logger.warn({
      message: `Failed to trust Caddy Local CA (exit ${installExit}). You may see HTTPS warnings in the browser.`,
    });
    return false;
  }

  const installed = await deps.checkTrust(input);
  if (!installed.trusted) {
    logger.warn({
      message:
        installed.issue ??
        "macOS TLS trust verification failed after installation",
    });
    return false;
  }

  logger.success({ message: "Trusted Caddy Local CA (macOS System keychain)" });
  note(
    [
      "If your browser still shows a warning, restart the browser.",
      "To remove later: Keychain Access → System → search 'Caddy Local Authority'.",
    ].join("\n"),
    "TLS"
  );
  return true;
}
