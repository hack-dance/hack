import { CliUsageError } from "../cli/command.ts";
import { exec } from "./shell.ts";

const UNSAFE_URL_CHARACTERS = /[\s\u0000-\u001f\u007f]/u;
const HTTP_STATUS = /^[1-5][0-9]{2}$/u;

export type BrowserObservation =
  | "unknown"
  | "works"
  | "fails"
  | "permission-denied";

/** Manual observations are scoped to this exact URL, never inferred from CLI health. */
export function parseBrowserNetworkOptions(input: {
  readonly url?: string;
  readonly result?: string;
}): { readonly url: string | null; readonly observation: BrowserObservation } {
  const observation = input.result ?? "unknown";
  if (
    observation !== "unknown" &&
    observation !== "works" &&
    observation !== "fails" &&
    observation !== "permission-denied"
  ) {
    throw new CliUsageError(
      "--browser-result must be unknown, works, fails, or permission-denied"
    );
  }
  if (!input.url) {
    if (observation !== "unknown") {
      throw new CliUsageError(
        "--browser-result requires --browser-url for the same manually tested target"
      );
    }
    return { url: null, observation };
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new CliUsageError(
      "--browser-url must be an HTTPS origin without credentials, path, query, or fragment"
    );
  }
  if (
    input.url.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    UNSAFE_URL_CHARACTERS.test(input.url)
  ) {
    throw new CliUsageError(
      "--browser-url must be an HTTPS origin without credentials, path, query, or fragment"
    );
  }
  return { url: `${url.origin}/`, observation };
}

type HttpsProbe =
  | { readonly outcome: "response"; readonly status: number }
  | { readonly outcome: "failed" };

/** Normal TLS validation, no redirects, cookies, curl config, credentials or response-body output. */
export async function probeBrowserTarget(
  url: string,
  execute: typeof exec = exec
): Promise<HttpsProbe> {
  try {
    const result = await execute(
      [
        "curl",
        "--disable",
        "--silent",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        "--proto",
        "=https",
        "--connect-timeout",
        "3",
        "--max-time",
        "5",
        "--max-filesize",
        "1048576",
        "--url",
        url,
      ],
      { stdin: "ignore", timeoutMs: 6000 }
    );
    if (result.exitCode !== 0 || !HTTP_STATUS.test(result.stdout)) {
      return { outcome: "failed" };
    }
    return { outcome: "response", status: Number(result.stdout) };
  } catch {
    return { outcome: "failed" };
  }
}

export async function checkBrowserLocalNetwork(input: {
  readonly platform: string;
  readonly url: string | null;
  readonly observation: BrowserObservation;
  readonly probe?: (url: string) => Promise<HttpsProbe>;
}): Promise<{
  readonly name: string;
  readonly status: "ok" | "warn";
  readonly message: string;
}> {
  const name = "browser local network";
  if (input.platform !== "darwin") {
    return {
      name,
      status: "ok",
      message:
        "Not applicable: this diagnostic concerns macOS browser Local Network privacy.",
    };
  }
  if (!input.url) {
    return {
      name,
      status: "warn",
      message:
        "Browser path unverified. Open the local HTTPS origin manually, then rerun with --browser-url https://your-app.hack.local --browser-result works|fails|permission-denied. CLI health does not verify browser permission.",
    };
  }
  const result = await (input.probe ?? probeBrowserTarget)(input.url);
  const cliWorks =
    result.outcome === "response" &&
    result.status >= 200 &&
    result.status < 300;
  const cli =
    result.outcome === "response"
      ? `CLI verified HTTPS returned HTTP ${result.status} (normal CLI proxy settings apply; redirect destinations are not checked)`
      : "CLI verified HTTPS did not succeed";
  const target = new URL(input.url).origin;
  if (!cliWorks) {
    return {
      name,
      status: "warn",
      message: `${target}: ${cli}; browser observation: ${input.observation}. Cannot isolate a browser-only failure; review DNS, TLS, routing and service checks first. No permission state was inspected.`,
    };
  }
  if (input.observation === "works") {
    return {
      name,
      status: "ok",
      message: `${target}: ${cli}; browser works according to your manual observation. No permission state was inspected.`,
    };
  }
  if (input.observation === "unknown") {
    return {
      name,
      status: "warn",
      message: `${target}: ${cli}, but the browser path remains unverified. Open this same origin manually and rerun with --browser-result works|fails|permission-denied.`,
    };
  }
  const finding =
    input.observation === "permission-denied"
      ? "You reported a browser permission denial"
      : "You reported a browser-only failure; Local Network permission is one possible cause (not confirmed)";
  return {
    name,
    status: "warn",
    message: `${target}: ${cli}. ${finding}. On macOS 15 or later, check System Settings > Privacy & Security > Local Network for the affected browser/app. If disabled, enable it manually, quit and reopen that app, then recheck this same origin and rerun Doctor. Browser proxy, extension or TLS settings can also differ. Doctor does not inspect or change privacy settings.`,
  };
}
