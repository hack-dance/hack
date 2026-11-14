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
  applyLinuxDns,
  type LinuxDnsHost,
  linuxDnsRootSteps,
} from "../lib/linux-dns-setup.ts";
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
import type { DockerBackend } from "../lib/runtime-guidance.ts";
import {
  macAuthorizationArgv,
  macDnsmasqNeedsStart,
  macFlushCommands,
  macPrivilegedAttempts,
  macResolverArgv,
  macRestartCommands,
} from "./global-install-actions.ts";
import {
  MAC_SUDO_PROBE_ARGV,
  type MacTrustCheck,
  type PreparedMacTrustPlan,
} from "./global-mac-trust.ts";

export const ADMIN_PLAN_SCHEMA = "hack.global-admin-plan.v1";

/**
 * A bounded `docker info` result as the plan reads it: exit 0 answers;
 * another completed exit is a definite no; a timeout (124), a failure to
 * start (127, or no result) is unknown, never "down".
 */
export function classifyDockerInfo(
  result: { readonly exitCode: number } | null
): boolean | "unknown" {
  if (result === null || result.exitCode === 124 || result.exitCode === 127) {
    return "unknown";
  }
  return result.exitCode === 0;
}

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
  return steps.map((step, index) => ({ ...step, order: index + 1 }));
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

export type MacInstallSnapshot = {
  readonly brew: string | null;
  readonly dnsmasqInstalled: boolean | "unknown";
  readonly services: string | null;
  readonly helperPath: string;
  readonly helperInstalled: boolean;
  /** Existing custom resolver files are retained; built-in ones are offered again. */
  readonly resolverDomains: readonly string[];
  readonly authorization: null | Parameters<typeof macAuthorizationArgv>[0];
  readonly authorizationRefusal: string | null;
  readonly authorizationUnknown?: boolean;
};

export type InstallPlanDeps = {
  readonly platform: NodeJS.Platform;
  readonly refusal: () => string | null;
  readonly preflight: () => Promise<
    string | { readonly unresolved: string } | null
  >;
  readonly domains: readonly string[];
  readonly dockerStartup: () => Promise<{
    readonly reachable: boolean | "unknown";
    readonly backend: DockerBackend | null;
  }>;
  readonly useStaticIps: () => Promise<boolean | "unknown">;
  readonly linuxHost?: LinuxDnsHost;
  readonly sudoPath: () => Promise<string | null>;
  readonly unreadableLinux: () => boolean;
  readonly macSnapshot: () => Promise<MacInstallSnapshot>;
  readonly trust: () => Promise<AdminPlan>;
};

/** Plan install from read-only inputs, using the same prepared root argv as execution. */
export async function planGlobalInstall(
  deps: InstallPlanDeps
): Promise<AdminPlan> {
  const base = { command: "install", platform: deps.platform } as const;
  const refusal = deps.refusal() ?? (await deps.preflight());
  if (typeof refusal === "object" && refusal !== null) {
    return plan({
      ...base,
      blocked: [
        {
          phase: "custom-domain preflight",
          reason: refusal.unresolved,
          prerequisite: "Readable host-domain ownership state, then plan again",
        },
      ],
    });
  }
  if (refusal !== null) {
    return plan({ ...base, refused: refusal });
  }
  const steps: StepInput[] = [
    userStep(
      "dependencies",
      "Ensure bundled optional tools; on macOS offer Homebrew chafa and mkcert",
      "after custom-domain ownership preflight"
    ),
  ];
  const blocked: AdminPlan["blocked"][number][] = [];
  const docker = await deps.dockerStartup();
  if (
    docker.reachable === "unknown" ||
    (!docker.reachable && docker.backend === null)
  ) {
    blocked.push({
      phase: "Docker startup",
      reason:
        "Docker reachability or its startup backend could not be determined",
      prerequisite:
        "A readable Docker status and detected startup backend, then plan again",
    });
  } else if (!docker.reachable && docker.backend !== null) {
    const when =
      "after optional dependencies and confirmation to start Docker; non-interactive runs accept the default";
    steps.push(
      docker.backend.id === "docker-systemd"
        ? rootStep({
            id: "docker-start",
            description: "Start the Docker system service",
            argv: docker.backend.startCommand,
            when,
          })
        : userStep(
            "docker-start",
            "Start the detected desktop Docker backend",
            when
          )
    );
  }
  steps.push(
    userStep(
      "networks",
      "Ensure shared ingress and logging networks",
      "after Docker is ready"
    ),
    userStep(
      "global-files",
      "Materialize global Compose files and schemas, prompting before overwriting different files",
      "after network setup"
    )
  );
  const mac = deps.platform === "darwin" ? await deps.macSnapshot() : null;
  if (mac) {
    appendMacStartup(mac, steps, blocked);
  }
  steps.push(
    userStep(
      "global-stack",
      "Start Caddy and logging Compose services and the optional user daemon",
      "after global-up dnsmasq on macOS; no administrator rights for this step"
    )
  );
  return mac
    ? await finishMacInstallPlan(deps, mac, steps, blocked)
    : await finishLinuxInstallPlan(deps, steps, blocked);
}

function appendMacStartup(
  mac: MacInstallSnapshot,
  steps: StepInput[],
  blocked: AdminPlan["blocked"][number][]
): void {
  const block = (phase: string, reason: string, prerequisite: string) =>
    blocked.push({ phase, reason, prerequisite });
  if (
    mac.dnsmasqInstalled === "unknown" ||
    (mac.brew && mac.dnsmasqInstalled && mac.services === null)
  ) {
    block(
      "global-up dnsmasq",
      "Homebrew's installed formula or service state could not be read",
      "Readable Homebrew formula and service state, then plan again"
    );
  } else if (
    mac.brew &&
    mac.dnsmasqInstalled &&
    macDnsmasqNeedsStart(mac.services ?? "")
  ) {
    appendMacRestart(
      steps,
      mac,
      "global-up",
      "when global up checks dnsmasq before starting Compose; failures warn and continue"
    );
  }
}

async function finishMacInstallPlan(
  deps: InstallPlanDeps,
  mac: MacInstallSnapshot,
  steps: StepInput[],
  blocked: AdminPlan["blocked"][number][]
): Promise<AdminPlan> {
  const base = { command: "install", platform: deps.platform } as const;
  const block = (phase: string, reason: string, prerequisite: string) =>
    blocked.push({ phase, reason, prerequisite });
  appendMacInstall({ mac, steps, blocked });
  const trust = await deps.trust();
  steps.push(
    userStep(
      "export-ca",
      "Export the CA from the Compose-selected Caddy container",
      "after macOS DNS bootstrap"
    )
  );
  for (const step of trust.steps) {
    if (step.id !== "export-ca" && step.id !== "start-docker") {
      steps.push({
        ...step,
        id: `install-${step.id}`,
        when: `after install exports its CA; ${step.when}`,
        ...(step.gates ? { gates: `install-${step.gates}` } : {}),
      });
    }
  }
  blocked.push(...trust.blocked);
  if (trust.refused !== null) {
    block(
      "keychain trust",
      trust.refused,
      "An eligible exported Caddy CA, then plan again"
    );
  }
  appendMacAuthorization(steps, mac, blocked);
  steps.push(
    userStep(
      "daemon-login",
      "Offer the per-user daemon login service where autostart and launchd access permit",
      "after recovery authorization; runs as the current user"
    )
  );
  return plan({ ...base, steps, blocked });
}

async function finishLinuxInstallPlan(
  deps: InstallPlanDeps,
  steps: StepInput[],
  blocked: AdminPlan["blocked"][number][]
): Promise<AdminPlan> {
  const base = { command: "install", platform: deps.platform } as const;
  const block = (phase: string, reason: string, prerequisite: string) =>
    blocked.push({ phase, reason, prerequisite });
  if (deps.platform !== "linux" || !deps.linuxHost) {
    steps.push(
      userStep(
        "manual-dns",
        "Show manual wildcard DNS instructions; no administrator commands run",
        "after stack startup"
      )
    );
    return plan({ ...base, steps });
  }
  const staticIps = await deps.useStaticIps();
  if (staticIps === "unknown") {
    block(
      "Linux DNS",
      "The ingress network is absent or unreadable; install decides its subnet after starting Docker and ensuring the network",
      "An existing readable ingress network, then plan again"
    );
    return plan({ ...base, steps, blocked });
  }
  if (!staticIps) {
    steps.push(
      userStep(
        "skip-dns",
        "Skip Linux DNS: the existing ingress network lacks the fixed subnet",
        "after stack startup"
      )
    );
    return plan({ ...base, steps });
  }
  const dns = await applyLinuxDns({
    host: deps.linuxHost,
    domains: deps.domains,
    canPrompt: false,
    show: () => {
      throw new Error("Planning must not prompt");
    },
    confirm: () => {
      throw new Error("Planning must not confirm");
    },
  });
  if (
    deps.unreadableLinux() ||
    (dns.status === "manual" && dns.inspection.state === "bridge_missing")
  ) {
    block(
      "Linux DNS",
      "The host-visible bridge or resolver state is not known before bootstrap",
      "A running host-visible ingress bridge and readable resolver state, then plan again"
    );
  } else if (dns.status === "pending") {
    const sudo = await deps.sudoPath();
    if (sudo === null) {
      block(
        "Linux DNS",
        "No vetted system sudo is available",
        "A vetted system sudo, then plan again"
      );
    } else {
      for (const [index, step] of linuxDnsRootSteps(dns.plan).entries()) {
        steps.push(
          rootStep({
            id: `linux-dns-${index + 1}`,
            description: step.description,
            argv: trustedSudoInvocation({ sudo, argv: step.argv }),
            ...(step.input
              ? {
                  input: {
                    text: Buffer.from(step.input).toString("utf8"),
                    content: "managed DNS configuration",
                  },
                }
              : {}),
            when: "after bootstrap succeeds and you confirm DNS setup on an interactive terminal; later steps require previous success",
          })
        );
      }
    }
  } else {
    steps.push(
      userStep(
        "host-dns",
        "DNS is already configured or manual for the detected resolver; no administrator commands run",
        "after stack startup"
      )
    );
  }
  return plan({ ...base, steps, blocked });
}

function appendMacAttempts(
  steps: StepInput[],
  command: readonly string[],
  id: string,
  when: string
): void {
  // A script can generate a plan for a later terminal run. Keep both attempts
  // and describe the terminal guard instead of sampling the planning stdin.
  for (const [index, argv] of macPrivilegedAttempts({
    command,
    interactive: true,
  }).entries()) {
    steps.push(
      rootStep({
        id: `${id}-${index + 1}`,
        description: command.join(" "),
        argv,
        when:
          index === 0
            ? when
            : `${when}; only on an interactive terminal and only if the passwordless attempt fails`,
      })
    );
  }
}

function appendMacRestart(
  steps: StepInput[],
  mac: MacInstallSnapshot,
  prefix: string,
  when: string
): void {
  for (const [index, command] of macRestartCommands(mac).entries()) {
    appendMacAttempts(
      steps,
      command,
      `${prefix}-restart-${index + 1}`,
      index === 0
        ? when
        : `${when}; only if the recovery helper's attempts fail`
    );
  }
}

function appendMacInstall(opts: {
  readonly mac: MacInstallSnapshot;
  readonly steps: StepInput[];
  readonly blocked: AdminPlan["blocked"][number][];
}): void {
  const { mac, steps, blocked } = opts;
  if (!mac.brew) {
    steps.push(
      userStep(
        "skip-dns",
        "Skip macOS DNS bootstrap because Homebrew is absent",
        "after stack startup"
      )
    );
    return;
  }
  if (mac.dnsmasqInstalled !== true) {
    steps.push(
      userStep(
        "dnsmasq-formula",
        "Offer to install the dnsmasq Homebrew formula",
        "after stack startup"
      )
    );
    blocked.push({
      phase: "macOS DNS",
      reason:
        "dnsmasq is not confirmed installed; bootstrap may install it before reading its Homebrew prefix and preparing DNS",
      prerequisite:
        "An installed dnsmasq formula and readable Homebrew prefix, then plan again",
    });
    return;
  }
  steps.push(
    userStep(
      "dnsmasq-config",
      "Write or update the user-owned Homebrew dnsmasq configuration for managed domains and the reachable ingress target",
      "after stack startup"
    )
  );
  for (const [index, domain] of mac.resolverDomains.entries()) {
    steps.push(
      rootStep({
        id: `resolver-${index + 1}`,
        description: `Write /etc/resolver/${domain}`,
        argv: macResolverArgv(domain),
        when: "only after confirming this resolver file on an interactive terminal",
      })
    );
  }
  appendMacRestart(
    steps,
    mac,
    "dns-bootstrap",
    "after resolver offers; bootstrap stops if every restart attempt fails"
  );
  for (const [index, command] of macFlushCommands(mac).entries()) {
    appendMacAttempts(
      steps,
      command,
      `dns-flush-${index + 1}`,
      "after dnsmasq restart succeeds; each later cache command requires previous success"
    );
  }
}

function appendMacAuthorization(
  steps: StepInput[],
  mac: MacInstallSnapshot,
  blocked: AdminPlan["blocked"][number][]
): void {
  if (mac.authorizationUnknown) {
    blocked.push({
      phase: "recovery authorization",
      reason:
        "Helper parent ownership could not be read within the probe deadline",
      prerequisite: "Readable helper parent ownership, then plan again",
    });
    return;
  }
  if (mac.authorizationRefusal !== null) {
    steps.push(
      userStep(
        "recovery-unavailable",
        mac.authorizationRefusal,
        "after host trust; recovery authorization is skipped"
      )
    );
    return;
  }
  if (mac.authorization === null) {
    steps.push(
      userStep(
        "recovery-configured",
        "Recovery sudoers rule already exists; no authorization offer",
        "after host trust"
      )
    );
    return;
  }
  steps.push(
    userStep(
      "recovery-files",
      "Render the recovery helper and sudoers files and validate sudoers with visudo as the current user",
      "after confirming recovery authorization on an interactive terminal"
    )
  );
  for (const [id, argv] of Object.entries(
    macAuthorizationArgv(mac.authorization)
  )) {
    steps.push(
      rootStep({
        id: `recovery-${id}`,
        description: `Recovery authorization: ${id}`,
        argv,
        when: "after confirming recovery authorization, successful user visudo validation and root-controlled parent checks; later steps require prior success and the installed helper ownership check; sudo -k failure only warns",
      })
    );
  }
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
  /**
   * Linux, export not current: whether the export refresh may replace the
   * file (caddyCaExportReplaceable); "unknown" when it could not be read.
   */
  readonly exportReplaceable: () => Promise<
    "replaceable" | "refused" | "unknown"
  >;
  /** Linux: the trust host (read-only use: files, tool and sudo lookup). */
  readonly linuxHost?: LinuxTrustHost;
  readonly prepareLinux: (opts: {
    readonly host: LinuxTrustHost;
    readonly ca: ValidatedCa;
    readonly manualCertPath: string;
  }) => Promise<PreparedLinuxSystemTrust>;
  /**
   * macOS: whether `docker info` answers: true, false when it completed and
   * said no, "unknown" when it timed out or could not start (the real run's
   * own probe has no deadline, so a slow Docker may still answer it).
   */
  readonly dockerAnswers: () => Promise<boolean | "unknown">;
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
  }) => Promise<PreparedMacTrustPlan>;
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

/** Install exports after starting Compose and never falls back to an old export. */
export async function planGlobalInstallTrust(
  deps: TrustPlanDeps
): Promise<AdminPlan> {
  const source = await deps.readExportSource();
  if (source === "none") {
    return plan({
      command: "trust",
      platform: deps.platform,
      blocked: [
        {
          phase: "keychain trust",
          reason:
            "Install must locate the Caddy container after stack startup before exporting its CA; it does not fall back to an existing export",
          prerequisite:
            "A running Compose-selected Caddy container, then plan again",
        },
      ],
    });
  }
  return await planGlobalTrust({
    ...deps,
    dockerAnswers: async () => true,
    readExportSource: async () => source,
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
    // The refresh refuses a symlinked or non-regular export; then the real
    // run stops before any trust store (global-linux-trust.ts).
    const replaceable = await deps.exportReplaceable();
    if (replaceable === "refused") {
      return {
        stop: plan({
          ...base,
          refused: `${deps.certPath} is not current and is not a regular file; the export refresh refuses to replace it, so no trust store would be changed`,
        }),
      };
    }
    if (replaceable === "unknown") {
      return {
        stop: plan({
          ...base,
          blocked: [
            {
              phase: "system trust",
              reason:
                "Whether the stale exported CA can be replaced could not be read",
              prerequisite: `a readable ${deps.certPath}`,
            },
          ],
        }),
      };
    }
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
  const docker = await deps.dockerAnswers();
  if (docker === "unknown") {
    return {
      steps: [],
      exported,
      unresolved:
        "Docker did not answer in time; whether the run first copies a CA from the running Caddy is unknown",
    };
  }
  if (docker) {
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
  if (decided.status === "unknown") {
    return plan({
      ...base,
      steps: [...steps, hostEnv],
      blocked: [
        {
          phase: "keychain trust",
          reason: decided.issue,
          prerequisite: "Readable System keychain state, then plan again",
        },
      ],
    });
  }
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
