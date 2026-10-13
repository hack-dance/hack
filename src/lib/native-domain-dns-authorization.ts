import {
  ADMINISTRATOR_PROMPT_HINT,
  type AdministratorAuthorization,
  type AdministratorAuthorizationFailure,
  describeAdministratorAuthorizationFailure,
  requestAdministratorAuthorization,
} from "./admin-authorization.ts";
import { confirmSafe } from "./interactivity.ts";
import type { NativeDnsActivationDependencies } from "./native-domain-dns-activate.ts";

/** The `hack global dns` change a native DNS authorizer approves. */
export type NativeDnsAuthorizationAction = "activate" | "deactivate";

/**
 * The native administrator prompt did not complete after the user approved the
 * change. Carries only the closed failure class, never sudo output.
 */
export class NativeDnsAdministratorAuthorizationError extends Error {
  readonly outcome = "authorization-failed" as const;
  readonly failure: AdministratorAuthorizationFailure;

  constructor(
    result: Extract<AdministratorAuthorization, { readonly status: "failed" }>
  ) {
    super(
      `macOS administrator authorization did not complete (${describeAdministratorAuthorizationFailure(result)}); nothing changed. ${ADMINISTRATOR_PROMPT_HINT}`
    );
    this.name = "NativeDnsAdministratorAuthorizationError";
    this.failure = result.failure;
  }
}

/**
 * Native administrator prompt after an approved DNS change. A failed prompt
 * throws, so it is reported as an authorization failure and never as the
 * user's decline.
 */
export async function requireNativeAdministratorAuthorization(
  opts: {
    readonly requestAdministrator?: () => Promise<AdministratorAuthorization>;
  } = {}
): Promise<true> {
  const request =
    opts.requestAdministrator ??
    (async () => await requestAdministratorAuthorization());
  const result = await request();
  if (result.status === "failed") {
    throw new NativeDnsAdministratorAuthorizationError(result);
  }
  return true;
}

export interface NativeDnsAuthorizerDependencies {
  /** True only when a human can answer the confirmation and the sudo prompt. */
  readonly isInteractive: () => boolean;
  readonly confirm: (message: string) => Promise<boolean>;
  /** Shows the native `sudo -v` prompt; later privileged steps use `sudo -n`. */
  readonly requestAdministrator: () => Promise<AdministratorAuthorization>;
}

const DEFAULTS: NativeDnsAuthorizerDependencies = {
  isInteractive: () => process.stdin.isTTY === true,
  confirm: async (message) =>
    await confirmSafe({
      message,
      initialValue: false,
      nonInteractive: "decline",
    }),
  requestAdministrator: async () => await requestAdministratorAuthorization(),
};

/** Confirmation text naming exactly the owned claim the change touches. */
export function nativeDnsConfirmationMessage(opts: {
  readonly action: NativeDnsAuthorizationAction;
  readonly domain: string;
}): string {
  if (opts.action === "activate") {
    return `Activate only *.${opts.domain} at 127.0.0.1 via a new dnsmasq claim and /etc/resolver file? This restarts dnsmasq; existing v4 suffixes remain unchanged.`;
  }
  return `Deactivate only the owned *.${opts.domain} DNS claim? This restarts dnsmasq; the existing v4 parent remains unchanged.`;
}

/**
 * Authorizer for `hack global dns activate|deactivate`.
 *
 * Contract:
 * - Without an interactive terminal, or when the user declines, it returns
 *   false (a decline) and never reaches sudo.
 * - After an approval it shows the native administrator prompt. A failed
 *   prompt throws NativeDnsAdministratorAuthorizationError instead of
 *   returning false, so the caller reports authorization-failed, not denied.
 * - The activation and deactivation flows call it before any privileged step,
 *   so no `sudo -n` step runs before the prompt succeeds.
 */
export function createNativeDnsAuthorizer(opts: {
  readonly action: NativeDnsAuthorizationAction;
  readonly domain: string;
  readonly dependencies?: Partial<NativeDnsAuthorizerDependencies>;
}): NativeDnsActivationDependencies["authorize"] {
  const deps = { ...DEFAULTS, ...opts.dependencies };
  return async () => {
    if (!deps.isInteractive()) {
      return false;
    }
    const accepted = await deps.confirm(
      nativeDnsConfirmationMessage({ action: opts.action, domain: opts.domain })
    );
    if (!accepted) {
      return false;
    }
    return await requireNativeAdministratorAuthorization({
      requestAdministrator: deps.requestAdministrator,
    });
  };
}
