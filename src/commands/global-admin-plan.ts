/**
 * `hack global trust|install --plan --json` (HACK-2218, R11): the steps the
 * real command would take, in order, each marked root or user, with the
 * exact argv of every root command, without running any of them.
 *
 * Contract:
 * - Plans are phase-local. They come from one read-only look at the host and
 *   the same decision functions the real command uses
 *   (`prepareLinuxSystemTrust`, `prepareMacTrust`), whose prepared argv the
 *   real command then runs; nothing here rebuilds argv separately.
 * - A root step's `argv` is the spawned argv, after privilege wrapping (the
 *   vetted sudo and fixed environment on Linux; PATH `sudo` on macOS), and
 *   `stdin` gives the byte count and SHA-256 of what it is fed.
 * - A step that only runs under a condition says so in `when`; alternatives
 *   (a probe that can skip the next step) are marked. Where a later phase
 *   depends on something the run itself creates or reads first, the plan is
 *   `complete: false` with the reason, and invents no argv for it.
 * - Planning runs only read-only probes, never a planned action, a `sudo`
 *   probe, a write, a prompt or a starter.
 */
import { createHash } from "node:crypto";
import type { CaddyCaIdentity } from "../lib/caddy-ca-identity.ts";
import {
  renderShellCommand,
  type ValidatedCa,
  validateCaddyRootPem,
} from "../lib/linux-trust.ts";
import type {
  LinuxTrustHost,
  PreparedLinuxSystemTrust,
} from "../lib/linux-trust-setup.ts";
import { trustedSudoInvocation } from "../lib/privileged-sudo.ts";
import {
  MAC_SUDO_PROBE_ARGV,
  type MacTrustCheck,
  type PreparedMacTrust,
} from "./global-mac-trust.ts";

export const ADMIN_PLAN_SCHEMA = "hack.global-admin-plan.v1";

export type PlanStep = {
  /** 1-based position in the run. */
  readonly order: number;
  readonly privilege: "root" | "user";
  readonly id: string;
  readonly description: string;
  /** Root steps: the exact spawned argv. */
  readonly argv?: readonly string[];
  /** Root steps: `argv` as one copyable shell line. */
  readonly shell?: string;
  /** What the step reads on stdin: its size and digest, never its bytes. */
  readonly stdin?: {
    readonly bytes: number;
    readonly sha256: string;
    readonly content: string;
  };
  /** When the real command takes this step. */
  readonly when: string;
  /** For a probe: the step it can skip, by id. */
  readonly gates?: string;
};

export type AdminPlan = {
  readonly schema: typeof ADMIN_PLAN_SCHEMA;
  readonly command: "trust" | "install";
  readonly platform: string;
  /** Set when the real command would refuse to run at all. */
  readonly refused: string | null;
  /** False when a later phase cannot be known before the run. */
  readonly complete: boolean;
  readonly blocked: readonly {
    readonly phase: string;
    readonly reason: string;
    readonly prerequisite: string;
  }[];
  readonly steps: readonly PlanStep[];
};

type StepInput = Omit<PlanStep, "order">;

function numbered(steps: readonly StepInput[]): readonly PlanStep[] {
  return steps.map((step, index) => ({ order: index + 1, ...step }));
}

function rootStep(opts: {
  readonly id: string;
  readonly description: string;
  readonly argv: readonly string[];
  readonly input?: { readonly text: string; readonly content: string };
  readonly when: string;
  readonly gates?: string;
}): StepInput {
  return {
    privilege: "root",
    id: opts.id,
    description: opts.description,
    argv: opts.argv,
    shell: renderShellCommand(opts.argv),
    ...(opts.input
      ? {
          stdin: {
            bytes: Buffer.byteLength(opts.input.text),
            sha256: createHash("sha256").update(opts.input.text).digest("hex"),
            content: opts.input.content,
          },
        }
      : {}),
    when: opts.when,
    ...(opts.gates ? { gates: opts.gates } : {}),
  };
}

function userStep(id: string, description: string, when: string): StepInput {
  return { privilege: "user", id, description, when };
}

function plan(opts: {
  readonly command: AdminPlan["command"];
  readonly platform: string;
  readonly refused?: string;
  readonly blocked?: AdminPlan["blocked"];
  readonly steps?: readonly StepInput[];
}): AdminPlan {
  const blocked = opts.blocked ?? [];
  return {
    schema: ADMIN_PLAN_SCHEMA,
    command: opts.command,
    platform: opts.platform,
    refused: opts.refused ?? null,
    complete: opts.refused === undefined && blocked.length === 0,
    blocked,
    steps: numbered(opts.steps ?? []),
  };
}

// --- hack global trust -----------------------------------------------------

/** Read-only inputs of the trust plan; the real command's own sources. */
export type TrustPlanDeps = {
  readonly platform: NodeJS.Platform;
  /** The real command refuses (native runtime, slim mode); its message. */
  readonly refusal: () => string | null;
  readonly certPath: string;
  /** Linux: the runtime witness (vetted Docker reads, nothing written). */
  readonly inspectIdentity: () => Promise<CaddyCaIdentity>;
  /** The export's text, or null when it is absent or unreadable. */
  readonly readExport: () => Promise<string | null>;
  /** Linux: the trust host (read-only use: files, tool and sudo lookup). */
  readonly linuxHost?: LinuxTrustHost;
  readonly prepareLinux: (opts: {
    readonly host: LinuxTrustHost;
    readonly ca: ValidatedCa;
    readonly manualCertPath: string;
  }) => Promise<PreparedLinuxSystemTrust>;
  /** macOS: whether `docker info` answers (bounded). */
  readonly dockerAnswers: () => Promise<boolean>;
  /**
   * macOS, Docker answering: the CA the run's export would copy, selected
   * the way the export selects Caddy (the installed Compose file's `caddy`
   * service) and read without writing: its PEM; "none" when the export
   * would keep the current file (no single Caddy container); "unknown" when
   * it could not be read.
   */
  readonly readExportSource: () => Promise<
    { readonly pem: string } | "none" | "unknown"
  >;
  readonly prepareMac: (opts: {
    readonly certPath: string;
    readonly checkTrust?: (input: {
      readonly certPath: string;
    }) => Promise<MacTrustCheck>;
  }) => Promise<PreparedMacTrust>;
  /** Whether the run is explicitly non-interactive (flag or env). */
  readonly explicitlyNonInteractive: () => boolean;
};

export async function planGlobalTrust(deps: TrustPlanDeps): Promise<AdminPlan> {
  const base = { command: "trust", platform: deps.platform } as const;
  const refusal = deps.refusal();
  if (refusal !== null) {
    return plan({ ...base, refused: refusal });
  }
  if (deps.platform === "linux") {
    return await planLinuxTrust(deps);
  }
  if (deps.platform === "darwin") {
    return await planMacTrust(deps);
  }
  return plan({
    ...base,
    steps: [
      userStep(
        "manual",
        "Trust automation is only implemented for macOS and Linux; export the CA with `hack global ca` and trust it manually",
        "always"
      ),
    ],
  });
}

const LINUX_TRUST_CONFIRM =
  "after you confirm the system-wide trust prompt on an interactive terminal; never with --no-interactive or without a TTY (the command then prints these steps instead)";

/**
 * The CA bytes the Linux run will trust, and the user step that refreshes
 * the export first, or the plan that stops here.
 */
async function linuxTrustCa(
  deps: TrustPlanDeps
): Promise<
  | { readonly ca: ValidatedCa; readonly steps: readonly StepInput[] }
  | { readonly stop: AdminPlan }
> {
  const base = { command: "trust", platform: "linux" } as const;
  const identity = await deps.inspectIdentity();
  if (!identity.currentPem) {
    return {
      stop: plan({
        ...base,
        blocked: [
          {
            phase: "system trust",
            reason: `${identity.message}: the CA to trust is read from the running Caddy`,
            prerequisite: "hack global up",
          },
        ],
      }),
    };
  }
  // The run trusts the export's bytes; a stale export is first rewritten
  // from the runtime CA exactly (caddy-ca-export.ts).
  const steps: StepInput[] = [];
  let pem = identity.currentPem;
  if (identity.state === "current") {
    const exported = await deps.readExport();
    if (exported === null) {
      return {
        stop: plan({
          ...base,
          blocked: [
            {
              phase: "system trust",
              reason: "The exported CA could not be read",
              prerequisite: `a readable ${deps.certPath}`,
            },
          ],
        }),
      };
    }
    pem = exported;
  } else {
    steps.push(
      userStep(
        "refresh-ca-export",
        `Rewrite ${deps.certPath} from the running Caddy's CA`,
        "always (the export is not current)"
      )
    );
  }
  const validated = await validateCaddyRootPem({ pem });
  if (!validated.ok) {
    return {
      stop: plan({
        ...base,
        refused: `${validated.issue}; no trust store would be changed`,
      }),
    };
  }
  return { ca: validated.ca, steps };
}

async function planLinuxTrust(deps: TrustPlanDeps): Promise<AdminPlan> {
  const base = { command: "trust", platform: "linux" } as const;
  const resolved = await linuxTrustCa(deps);
  if ("stop" in resolved) {
    return resolved.stop;
  }
  const steps: StepInput[] = [...resolved.steps];
  const validated = { ca: resolved.ca };
  const host = deps.linuxHost;
  if (!host) {
    return plan({ ...base, refused: "No Linux trust host" });
  }
  const prepared = await deps.prepareLinux({
    host,
    ca: validated.ca,
    manualCertPath: deps.certPath,
  });
  if (prepared.status === "done") {
    const outcome = prepared.outcome;
    steps.push(
      userStep(
        "system-trust",
        outcome.status === "trusted"
          ? `The system trust store (${outcome.family}) already trusts this CA; no root step`
          : `System trust is manual (${"code" in outcome ? outcome.code : outcome.status}); no root step runs`,
        "always"
      )
    );
  } else {
    for (const [index, step] of prepared.rootSteps.entries()) {
      steps.push(
        rootStep({
          id: index === 0 ? "system-trust-install" : "system-trust-refresh",
          description:
            index === 0
              ? `Install the CA (SHA-256 ${validated.ca.fingerprint256}) into the ${prepared.family} trust anchors; root accepts only these exact bytes`
              : `Rebuild the ${prepared.family} system trust bundle`,
          argv: trustedSudoInvocation({
            sudo: prepared.sudoPath,
            argv: step.argv,
          }),
          ...(step.input === undefined
            ? {}
            : {
                input: {
                  text: step.input,
                  content: "the verified Caddy Local CA (PEM)",
                },
              }),
          when: LINUX_TRUST_CONFIRM,
        })
      );
    }
  }
  steps.push(
    userStep(
      "nss-trust",
      "Add or update Hack's CA in each browser NSS database you own (certutil, as you)",
      "when the system step did not fail"
    ),
    userStep(
      "host-tls-env",
      "Write Hack's host trust bundle and env script for CLI tools",
      "when the system and NSS steps succeeded"
    )
  );
  return plan({ ...base, steps });
}

const MAC_TRUST_CONFIRM =
  "after the keychain trust prompt; a non-interactive run accepts it";

/**
 * Which CA file the macOS run will trust, as the run decides it: Docker
 * answering means it first copies the CA from the Compose-selected Caddy
 * (keeping the current file when there is no single container); otherwise
 * it uses the current export, or starts Docker when there is none. Only a
 * CA known now (the current file, unchanged by the copy) decides the
 * keychain phase; anything else leaves it blocked.
 */
async function macTrustCa(deps: TrustPlanDeps): Promise<{
  readonly steps: readonly StepInput[];
  readonly unresolved: string | null;
  readonly exported: string | null;
}> {
  const exported = await deps.readExport();
  if (await deps.dockerAnswers()) {
    const copy = userStep(
      "export-ca",
      `Copy the CA of the Caddy in the installed Compose stack to ${deps.certPath} (docker cp)`,
      "always (Docker is running)"
    );
    const source = await deps.readExportSource();
    if (source === "unknown") {
      return {
        steps: [copy],
        exported,
        unresolved: "The running Caddy's CA could not be read",
      };
    }
    if (source !== "none" && source.pem !== exported) {
      return {
        steps: [copy],
        exported,
        unresolved:
          "The run first replaces the export with a different CA from the running Caddy; the keychain step is decided for that CA during the run",
      };
    }
    return { steps: [copy], exported, unresolved: null };
  }
  if (exported === null) {
    return {
      steps: [
        userStep(
          "start-docker",
          "Start the Docker backend, then copy the running Caddy's CA",
          "always (no exported CA and Docker is not running)"
        ),
      ],
      exported,
      unresolved:
        "There is no exported CA yet; the run starts Docker and exports it first",
    };
  }
  return { steps: [], exported, unresolved: null };
}

async function planMacTrust(deps: TrustPlanDeps): Promise<AdminPlan> {
  const base = { command: "trust", platform: "darwin" } as const;
  const resolved = await macTrustCa(deps);
  const steps: StepInput[] = [...resolved.steps];
  const hostEnv = userStep(
    "host-tls-env",
    "Write Hack's host trust bundle and env script, and set them for launchd (launchctl setenv)",
    "when the CA is eligible"
  );
  if (resolved.unresolved !== null) {
    return plan({
      ...base,
      blocked: [
        {
          phase: "keychain trust",
          reason: resolved.unresolved,
          prerequisite:
            "hack global up (so the running Caddy's CA is exported), then plan again",
        },
      ],
      steps: [...steps, hostEnv],
    });
  }
  if (resolved.exported === null) {
    // Docker answered but the export would keep a missing file.
    return plan({
      ...base,
      refused:
        "No exported Caddy Local CA and no Caddy container to copy it from",
    });
  }
  const decided = await deps.prepareMac({ certPath: deps.certPath });
  if (decided.status === "ineligible") {
    return plan({ ...base, refused: decided.issue });
  }
  if (decided.status === "trusted") {
    steps.push(
      userStep(
        "keychain-trust",
        "The System keychain already trusts this CA; no root step",
        "always"
      )
    );
  } else {
    if (deps.explicitlyNonInteractive()) {
      steps.push(
        rootStep({
          id: "sudo-probe",
          description:
            "Check that sudo needs no password (stdin ignored); otherwise the keychain step is skipped",
          argv: MAC_SUDO_PROBE_ARGV,
          when: MAC_TRUST_CONFIRM,
          gates: "keychain-trust",
        })
      );
    }
    steps.push(
      rootStep({
        id: "keychain-trust",
        description:
          "Trust the exported CA for TLS in the macOS System keychain",
        argv: decided.argv,
        when: MAC_TRUST_CONFIRM,
      })
    );
  }
  steps.push(hostEnv);
  return plan({ ...base, steps });
}
