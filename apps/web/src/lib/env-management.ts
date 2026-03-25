import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const REPO_ROOT = resolve(process.cwd(), "../..");
const STATUS_COMMAND = "./dist/hack env list --json";
const BACKEND_COMMAND = "./dist/hack env backend status --json";
const RUNTIME_STATUS_ARGS = ["index.ts", "env", "list", "--json"] as const;
const RUNTIME_BACKEND_ARGS = [
  "index.ts",
  "env",
  "backend",
  "status",
  "--json",
] as const;
const execFileAsync = promisify(execFile);

type EnvClassificationPayload = {
  readonly trust_model: string;
  readonly custody: string;
  readonly portability: string;
  readonly shared_state: string;
};

type EnvValueStoragePayload = {
  readonly kind: string;
  readonly backend: string;
  readonly location: string;
  readonly mode: string;
  readonly trust_model: string;
  readonly classification: EnvClassificationPayload;
};

type EnvVariablePayload = {
  readonly key: string;
  readonly required: boolean;
  readonly source: string;
  readonly services: readonly string[] | null;
  readonly resolved_from: string | null;
  readonly storage: EnvValueStoragePayload;
  readonly value?: string | null;
};

type EnvListCommandPayload = {
  readonly project?: string;
  readonly env_selection: {
    readonly requested: string | null;
    readonly default: string | null;
    readonly effective: string | null;
    readonly overlay_path: string | null;
    readonly overlay_exists: boolean;
  };
  readonly status: EnvClassificationPayload & {
    readonly summary: string;
    readonly detail: string;
  };
  readonly storage: {
    readonly local_plaintext: {
      readonly path: string;
      readonly exists: boolean;
      readonly trust_model: string;
      readonly mirrored_to_backend: boolean;
      readonly fallback: {
        readonly enabled: boolean;
        readonly source: string;
        readonly trust_model: string;
        readonly classification: EnvClassificationPayload;
      };
      readonly classification: EnvClassificationPayload;
    };
    readonly local_secrets: {
      readonly backend: string;
      readonly location: string;
      readonly mode: string;
      readonly provider: string | null;
      readonly trust_model: string;
      readonly classification: EnvClassificationPayload;
    };
    readonly portable_state: {
      readonly status: string;
      readonly trust_model: string;
      readonly message: string;
      readonly classification: EnvClassificationPayload;
    };
    readonly compatibility_mode: {
      readonly plaintext_target: string;
      readonly secret_backend: string;
      readonly plaintext_mirrored_to_backend: boolean;
      readonly summary: string;
    };
  };
  readonly vars?: readonly EnvVariablePayload[];
  readonly missing_required: readonly string[];
};

type EnvBackendCommandPayload = {
  readonly backend: string;
  readonly allow_env_auth_refs?: boolean;
  readonly store_plaintext_in_backend?: boolean;
  readonly encrypted_file?: {
    readonly path: string;
  };
  readonly encrypted_file_key_env?: string;
  readonly cloud?: {
    readonly provider: string | null;
    readonly project: string | null;
    readonly secretPrefix?: string;
  };
  readonly status: {
    readonly storage_mode: string;
    readonly trust_model: string;
    readonly portability: string;
    readonly plaintext_compatibility: string;
    readonly classification: EnvClassificationPayload;
  };
};

type EnvClassification = {
  readonly trustModel: string;
  readonly custody: string;
  readonly portability: string;
  readonly sharedState: string;
};

type EnvVariableStorage = {
  readonly kind: string;
  readonly backend: string;
  readonly location: string;
  readonly mode: string;
  readonly trustModel: string;
  readonly classification: EnvClassification;
};

export type EnvVariableState = {
  readonly key: string;
  readonly required: boolean;
  readonly source: string;
  readonly resolvedSource: string | null;
  readonly services: readonly string[] | null;
  readonly storage: EnvVariableStorage;
};

type CommandRunner = <TPayload>(input: {
  readonly args: readonly string[];
}) => Promise<{
  readonly payload: TPayload | null;
  readonly output: string;
}>;

export type EnvManagementState = {
  readonly ready: boolean;
  readonly envSelectionLabel: string;
  readonly missingRequired: readonly string[];
  readonly status: EnvClassification & {
    readonly summary: string;
    readonly detail: string;
  };
  readonly backend: {
    readonly name: string;
    readonly classification: EnvClassification;
    readonly status: {
      readonly storageMode: string;
      readonly trustModel: string;
      readonly portability: string;
      readonly plaintextCompatibility: string;
    };
  };
  readonly localPlaintext: {
    readonly path: string;
    readonly exists: boolean;
    readonly classification: EnvClassification;
  };
  readonly localSecrets: {
    readonly backend: string;
    readonly location: string;
    readonly mode: string;
    readonly provider: string | null;
    readonly classification: EnvClassification;
  };
  readonly portableState: {
    readonly status: string;
    readonly message: string;
    readonly classification: EnvClassification;
  };
  readonly compatibilityMode: {
    readonly plaintextTarget: string;
    readonly secretBackend: string;
    readonly plaintextMirroredToBackend: boolean;
    readonly summary: string;
  };
  readonly variables: readonly EnvVariableState[];
  readonly statusCommand: string;
  readonly backendCommand: string;
};

export async function loadEnvManagementState(input?: {
  readonly runCommandImplementation?: CommandRunner;
}): Promise<EnvManagementState> {
  const runCommandImplementation =
    input?.runCommandImplementation ?? runEnvJsonCommand;
  const [listResult, backendResult] = await Promise.all([
    runCommandImplementation<EnvListCommandPayload>({
      args: RUNTIME_STATUS_ARGS,
    }),
    runCommandImplementation<EnvBackendCommandPayload>({
      args: RUNTIME_BACKEND_ARGS,
    }),
  ]);

  if (!(listResult.payload && backendResult.payload)) {
    return createFallbackEnvManagementState({
      output:
        listResult.output.trim().length > 0
          ? listResult.output
          : backendResult.output,
    });
  }

  return buildEnvManagementState({
    list: listResult.payload,
    backend: backendResult.payload,
  });
}

export function buildEnvManagementState(input: {
  readonly list: EnvListCommandPayload;
  readonly backend: EnvBackendCommandPayload;
}): EnvManagementState {
  return {
    ready: input.list.missing_required.length === 0,
    envSelectionLabel: formatEnvSelectionLabel({
      envSelection: input.list.env_selection,
    }),
    missingRequired: input.list.missing_required,
    status: {
      ...normalizeClassification(input.list.status),
      summary: input.list.status.summary,
      detail: input.list.status.detail,
    },
    backend: {
      name: input.backend.backend,
      classification: normalizeClassification(
        input.backend.status.classification
      ),
      status: {
        storageMode: input.backend.status.storage_mode,
        trustModel: input.backend.status.trust_model,
        portability: input.backend.status.portability,
        plaintextCompatibility: input.backend.status.plaintext_compatibility,
      },
    },
    localPlaintext: {
      path: input.list.storage.local_plaintext.path,
      exists: input.list.storage.local_plaintext.exists,
      classification: normalizeClassification(
        input.list.storage.local_plaintext.classification
      ),
    },
    localSecrets: {
      backend: input.list.storage.local_secrets.backend,
      location: input.list.storage.local_secrets.location,
      mode: input.list.storage.local_secrets.mode,
      provider: input.list.storage.local_secrets.provider,
      classification: normalizeClassification(
        input.list.storage.local_secrets.classification
      ),
    },
    portableState: {
      status: input.list.storage.portable_state.status,
      message: input.list.storage.portable_state.message,
      classification: normalizeClassification(
        input.list.storage.portable_state.classification
      ),
    },
    compatibilityMode: {
      plaintextTarget: input.list.storage.compatibility_mode.plaintext_target,
      secretBackend: input.list.storage.compatibility_mode.secret_backend,
      plaintextMirroredToBackend:
        input.list.storage.compatibility_mode.plaintext_mirrored_to_backend,
      summary: input.list.storage.compatibility_mode.summary,
    },
    variables: (input.list.vars ?? []).map((variable) =>
      normalizeEnvVariable({
        variable,
      })
    ),
    statusCommand: STATUS_COMMAND,
    backendCommand: BACKEND_COMMAND,
  };
}

function createFallbackEnvManagementState(input: {
  readonly output: string;
}): EnvManagementState {
  const detail =
    input.output.trim().length > 0
      ? input.output.trim()
      : "Hack could not read the local env status commands for this repo.";
  const unavailableClassification = {
    trustModel: "unavailable",
    custody: "unavailable",
    portability: "unavailable",
    sharedState: "unavailable",
  } as const;

  return {
    ready: false,
    envSelectionLabel: "Unavailable",
    missingRequired: [],
    status: {
      ...unavailableClassification,
      summary: "Env status unavailable",
      detail,
    },
    backend: {
      name: "unknown",
      classification: unavailableClassification,
      status: {
        storageMode: "Unavailable",
        trustModel: "Unavailable",
        portability: "Unavailable",
        plaintextCompatibility: "Unavailable",
      },
    },
    localPlaintext: {
      path: ".hack/.env",
      exists: false,
      classification: unavailableClassification,
    },
    localSecrets: {
      backend: "unknown",
      location: "Unavailable",
      mode: "unknown",
      provider: null,
      classification: unavailableClassification,
    },
    portableState: {
      status: "unknown",
      message: "Portable env status is unavailable.",
      classification: unavailableClassification,
    },
    compatibilityMode: {
      plaintextTarget: ".hack/.env",
      secretBackend: "unknown",
      plaintextMirroredToBackend: false,
      summary: "Env compatibility status is unavailable.",
    },
    variables: [],
    statusCommand: STATUS_COMMAND,
    backendCommand: BACKEND_COMMAND,
  };
}

async function runEnvJsonCommand<TPayload>(input: {
  readonly args: readonly string[];
}): Promise<{
  readonly payload: TPayload | null;
  readonly output: string;
}> {
  try {
    const result = await execFileAsync("bun", input.args, {
      cwd: REPO_ROOT,
      env: { ...process.env },
    });
    const output = result.stdout.trim();
    return {
      payload: parseJsonPayload<TPayload>({ output }),
      output,
    };
  } catch (error) {
    const output = readCommandOutput({ error });
    return {
      payload: parseJsonPayload<TPayload>({ output }),
      output,
    };
  }
}

function parseJsonPayload<TPayload>(input: {
  readonly output: string;
}): TPayload | null {
  const output = input.output.trim();
  if (!output.startsWith("{")) {
    return null;
  }

  try {
    return JSON.parse(output) as TPayload;
  } catch {
    return null;
  }
}

function readCommandOutput(input: { readonly error: unknown }): string {
  if (
    input.error &&
    typeof input.error === "object" &&
    "stdout" in input.error &&
    typeof input.error.stdout === "string"
  ) {
    return input.error.stdout.trim();
  }
  if (input.error instanceof Error) {
    return input.error.message;
  }
  return "";
}

function normalizeClassification(
  input: EnvClassificationPayload
): EnvClassification {
  return {
    trustModel: input.trust_model,
    custody: input.custody,
    portability: input.portability,
    sharedState: input.shared_state,
  };
}

function normalizeEnvVariable(input: {
  readonly variable: EnvVariablePayload;
}): EnvVariableState {
  return {
    key: input.variable.key,
    required: input.variable.required,
    source: input.variable.source,
    resolvedSource: input.variable.resolved_from,
    services: input.variable.services,
    storage: {
      kind: input.variable.storage.kind,
      backend: input.variable.storage.backend,
      location: input.variable.storage.location,
      mode: input.variable.storage.mode,
      trustModel: input.variable.storage.trust_model,
      classification: normalizeClassification(
        input.variable.storage.classification
      ),
    },
  };
}

function formatEnvSelectionLabel(input: {
  readonly envSelection: EnvListCommandPayload["env_selection"];
}): string {
  if (!input.envSelection.effective) {
    return "base (.hack/.env only)";
  }

  const overlayLabel = input.envSelection.overlay_path
    ? ` overlaid by ${input.envSelection.overlay_path}`
    : "";
  return `${input.envSelection.effective}${overlayLabel}`;
}
