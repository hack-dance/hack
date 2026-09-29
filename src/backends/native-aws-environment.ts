import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import type { NativeProjectInput } from "./native-project-input.ts";

const MAX_OUTPUT = 64 * 1024;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROFILE = /^[A-Za-z0-9_+=,.@-]{1,128}$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const SELECTORS = ["AWS_PROFILE", "AWS_DEFAULT_PROFILE"];
const CREDENTIAL_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
];

function refused(): Error {
  return new Error(
    "Native AWS adaptation refused: verify the explicit profile, supported read-only AWS mount and unexpired exported credentials; values omitted."
  );
}

export type NativeAwsExportSource = (opts: {
  readonly profile: string;
  readonly region?: string;
}) => Promise<{ readonly credentials: unknown; readonly region?: string }>;

/** Only stdout is captured privately; AWS diagnostics and ambient AWS values are omitted. */
function awsCommand(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_CLI_AUTO_PROMPT: "off",
      AWS_PAGER: "",
    };
    for (const key of ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME"]) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
    const child = spawn("aws", [...args], {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const stop = () => {
      // The unreaped direct child starts a new POSIX group owned by this request.
      if (
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already exited; never use a persisted PID or retry the AWS request.
        }
      }
      child.stdout?.destroy();
    };
    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stop();
      if (ok) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      } else {
        reject(refused());
      }
      for (const chunk of chunks) {
        chunk.fill(0);
      }
    };
    const timer = setTimeout(() => finish(false), 30_000);
    child.on("error", () => finish(false));
    child.stdout?.on("error", () => finish(false));
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_OUTPUT) {
        chunk.fill(0);
        finish(false);
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => finish(code === 0));
  });
}

const exportAwsProfile: NativeAwsExportSource = async ({
  profile,
  region: selectedRegion,
}) => {
  const text = await awsCommand([
    "configure",
    "export-credentials",
    "--profile",
    profile,
    "--format",
    "process",
  ]);
  const credentials: unknown = JSON.parse(text);
  const region =
    selectedRegion ??
    (
      await awsCommand(["configure", "get", "region", "--profile", profile])
    ).trim();
  return { credentials, region };
};

function awsMount(value: unknown, home: string): boolean {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Compose interpolation syntax.
  const sources = new Set(["${HOME}/.aws", "$HOME/.aws", join(home, ".aws")]);
  if (typeof value === "string") {
    const [source, target, mode, extra] = value.split(":");
    if (!(source?.includes(".aws") || target?.includes(".aws"))) {
      return false;
    }
    if (
      !(source && sources.has(source)) ||
      target !== "/root/.aws" ||
      mode !== "ro" ||
      extra !== undefined
    ) {
      throw refused();
    }
    return true;
  }
  if (!isRecord(value)) {
    throw refused();
  }
  const { source, target } = value;
  if (
    !(
      (typeof source === "string" && source.includes(".aws")) ||
      (typeof target === "string" && target.includes(".aws"))
    )
  ) {
    return false;
  }
  if (
    typeof source !== "string" ||
    !sources.has(source) ||
    target !== "/root/.aws" ||
    value.type !== "bind" ||
    value.read_only !== true ||
    Object.keys(value).some(
      (key) => !["type", "source", "target", "read_only"].includes(key)
    )
  ) {
    throw refused();
  }
  return true;
}

function serviceEnvironment(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (isRecord(value)) {
    return { ...value };
  }
  if (!Array.isArray(value)) {
    throw refused();
  }
  const output: Record<string, unknown> = {};
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw refused();
    }
    const equal = entry.indexOf("=");
    const key = equal < 0 ? entry : entry.slice(0, equal);
    if (!KEY.test(key) || Object.hasOwn(output, key)) {
      throw refused();
    }
    output[key] = equal < 0 ? null : entry.slice(equal + 1);
  }
  return output;
}

function removeSelectors(
  values: Record<string, unknown>,
  privateValues: Record<string, string>
): void {
  for (const key of SELECTORS) {
    delete values[key];
    delete privateValues[key];
  }
  for (const [key, allowed] of [
    ["AWS_CONFIG_FILE", ["/root/.aws/config", "/root/.aws/config.container"]],
    ["AWS_SHARED_CREDENTIALS_FILE", ["/root/.aws/credentials"]],
  ] as const) {
    for (const value of [values[key], privateValues[key]]) {
      if (
        value !== undefined &&
        value !== null &&
        !allowed.some((v) => v === value)
      ) {
        throw refused();
      }
    }
    delete values[key];
    delete privateValues[key];
  }
  for (const key of [
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  ]) {
    if (Object.hasOwn(values, key) || Object.hasOwn(privateValues, key)) {
      throw refused();
    }
  }
}

function credentials(
  value: unknown,
  now: number
): {
  values: Record<string, string>;
  expiry: string;
} {
  if (
    !isRecord(value) ||
    value.Version !== 1 ||
    typeof value.Expiration !== "string"
  ) {
    throw refused();
  }
  const expiry = Date.parse(value.Expiration);
  if (
    !(Number.isFinite(now) && Number.isFinite(expiry)) ||
    expiry <= now + 60_000
  ) {
    throw refused();
  }
  const result: Record<string, string> = {};
  for (const [source, target] of [
    ["AccessKeyId", "AWS_ACCESS_KEY_ID"],
    ["SecretAccessKey", "AWS_SECRET_ACCESS_KEY"],
    ["SessionToken", "AWS_SESSION_TOKEN"],
  ] as const) {
    const entry = value[source];
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      Buffer.byteLength(entry) > 16_384 ||
      entry.includes("\0")
    ) {
      throw refused();
    }
    result[target] = entry;
  }
  return { values: result, expiry: new Date(expiry).toISOString() };
}

function prepareServices(
  compose: Record<string, unknown> & { services: Record<string, unknown> },
  input: NativeProjectInput,
  home: string
) {
  const managed = { ...input.managedEnvironment };
  const selected: string[] = [];
  for (const [name, service] of Object.entries(compose.services)) {
    if (!isRecord(service)) {
      throw refused();
    }
    if (service.volumes === undefined) {
      continue;
    }
    if (!Array.isArray(service.volumes)) {
      throw refused();
    }
    const matches = service.volumes.filter((mount) => awsMount(mount, home));
    if (matches.length === 0) {
      continue;
    }
    if (matches.length !== 1) {
      throw refused();
    }
    service.volumes = service.volumes.filter((mount) => mount !== matches[0]);
    const environment = serviceEnvironment(service.environment);
    const privateValues = { ...managed[name] };
    removeSelectors(environment, privateValues);
    for (const key of CREDENTIAL_KEYS) {
      delete environment[key];
      delete privateValues[key];
    }
    service.environment = environment;
    managed[name] = privateValues;
    selected.push(name);
  }
  if (selected.length === 0) {
    throw refused();
  }
  return { managed, selected };
}

/** Explicit profile adaptation: credentials remain private, service scoped and ephemeral.
 * Only recognized read-only AWS mounts are replaced. No refresh or persistence is implied.
 */
export async function adaptNativeAwsEnvironment(opts: {
  readonly input: NativeProjectInput;
  readonly profile: string;
  readonly region?: string;
  readonly exportSource?: NativeAwsExportSource;
  readonly homeDirectory?: string;
  readonly now?: number;
}): Promise<{
  readonly input: NativeProjectInput;
  readonly receipt: {
    readonly profile: string;
    readonly expiry: string;
    readonly services: readonly string[];
  };
}> {
  try {
    if (
      !PROFILE.test(opts.profile) ||
      (opts.region !== undefined && !REGION.test(opts.region))
    ) {
      throw refused();
    }
    const compose: unknown = JSON.parse(opts.input.normalizedComposeJson);
    if (!(isRecord(compose) && isRecord(compose.services))) {
      throw refused();
    }
    const { managed, selected } = prepareServices(
      { ...compose, services: compose.services },
      opts.input,
      opts.homeDirectory ?? homedir()
    );
    const exported = await (opts.exportSource ?? exportAwsProfile)({
      profile: opts.profile,
      ...(opts.region ? { region: opts.region } : {}),
    });
    const credential = credentials(
      exported.credentials,
      opts.now ?? Date.now()
    );
    const region = opts.region ?? exported.region;
    if (!(region && REGION.test(region))) {
      throw refused();
    }
    for (const name of selected) {
      const service = compose.services[name];
      if (!(isRecord(service) && isRecord(service.environment))) {
        throw refused();
      }
      const values = { ...managed[name], ...credential.values };
      for (const key of ["AWS_REGION", "AWS_DEFAULT_REGION"]) {
        delete values[key];
      }
      managed[name] = values;
      Object.assign(
        service.environment,
        Object.fromEntries(
          Object.keys(credential.values).map((key) => [key, null])
        ),
        { AWS_REGION: region, AWS_DEFAULT_REGION: region }
      );
    }
    return {
      input: {
        ...opts.input,
        normalizedComposeJson: JSON.stringify(compose),
        managedEnvironment: managed,
      },
      receipt: {
        profile: opts.profile,
        expiry: credential.expiry,
        services: selected.sort(),
      },
    };
  } catch {
    throw refused();
  }
}
