import type { HackEnvStorageSummary, HackEnvValueState } from "./hack-env.ts";

export type HackEnvSharedState =
  | "local_only"
  | "plaintext_compatible"
  | "portable_bundle"
  | "broker_managed";

export type HackEnvClassification = {
  readonly trustModel: string;
  readonly custody: string;
  readonly portability: string;
  readonly sharedState: HackEnvSharedState;
};

export type HackEnvJsonClassification = {
  readonly trust_model: string;
  readonly custody: string;
  readonly portability: string;
  readonly shared_state: HackEnvSharedState;
};

export type HackEnvValueStorageJson = {
  readonly kind: "plaintext" | "secret";
  readonly backend: string;
  readonly location: string;
  readonly mode: string;
  readonly trust_model: string;
  readonly classification: HackEnvJsonClassification;
};

export type HackEnvStorageJson = {
  readonly contract: {
    readonly path: string;
    readonly trust_model: string;
    readonly classification: HackEnvJsonClassification;
  };
  readonly local_plaintext: {
    readonly path: string;
    readonly exists: boolean;
    readonly trust_model: string;
    readonly mirrored_to_backend: boolean;
    readonly fallback: {
      readonly enabled: boolean;
      readonly source: string;
      readonly trust_model: string;
      readonly classification: HackEnvJsonClassification;
    };
    readonly classification: HackEnvJsonClassification;
  };
  readonly local_secrets: {
    readonly backend: string;
    readonly location: string;
    readonly mode: string;
    readonly provider: string | null;
    readonly trust_model: string;
    readonly classification: HackEnvJsonClassification;
  };
  readonly portable_state: {
    readonly status: string;
    readonly trust_model: string;
    readonly message: string;
    readonly classification: HackEnvJsonClassification;
  };
  readonly compatibility_mode: {
    readonly plaintext_target: string;
    readonly secret_backend: string;
    readonly plaintext_mirrored_to_backend: boolean;
    readonly summary: string;
  };
};

export type HackEnvAggregateStatusJson = HackEnvJsonClassification & {
  readonly summary: string;
  readonly detail: string;
};

export type HackEnvBackendStrategyStatus = {
  readonly storageMode: string;
  readonly trustModel: string;
  readonly portability: string;
  readonly plaintextCompatibility: string;
  readonly classification: HackEnvClassification;
};

export function serializeEnvClassificationForJson(input: {
  readonly classification: HackEnvClassification;
}): HackEnvJsonClassification {
  return {
    trust_model: input.classification.trustModel,
    custody: input.classification.custody,
    portability: input.classification.portability,
    shared_state: input.classification.sharedState,
  };
}

export function describeEnvAggregateStatusForJson(input: {
  readonly storage: HackEnvStorageSummary;
}): HackEnvAggregateStatusJson {
  const classification = describeAggregateClassification({
    storage: input.storage,
  });
  const summary = describeAggregateSummary({
    classification,
  });
  const detail = describeAggregateDetail({
    classification,
  });

  return {
    ...serializeEnvClassificationForJson({ classification }),
    summary,
    detail,
  };
}

export function serializeEnvStorageForJson(input: {
  readonly storage: HackEnvStorageSummary;
}): HackEnvStorageJson {
  return {
    contract: {
      path: input.storage.contract.path,
      trust_model: input.storage.contract.trustModel,
      classification: serializeEnvClassificationForJson({
        classification: describeContractClassification({
          storage: input.storage,
        }),
      }),
    },
    local_plaintext: {
      path: input.storage.localPlaintext.path,
      exists: input.storage.localPlaintext.exists,
      trust_model: input.storage.localPlaintext.trustModel,
      mirrored_to_backend: input.storage.localPlaintext.mirroredToBackend,
      fallback: {
        enabled: input.storage.localPlaintext.fallback.enabled,
        source: input.storage.localPlaintext.fallback.source,
        trust_model: input.storage.localPlaintext.fallback.trustModel,
        classification: serializeEnvClassificationForJson({
          classification: describeLocalPlaintextFallbackClassification(),
        }),
      },
      classification: serializeEnvClassificationForJson({
        classification: describeLocalPlaintextClassification(),
      }),
    },
    local_secrets: {
      backend: input.storage.localSecrets.backend,
      location: input.storage.localSecrets.location,
      mode: input.storage.localSecrets.mode,
      provider: input.storage.localSecrets.provider ?? null,
      trust_model: input.storage.localSecrets.trustModel,
      classification: serializeEnvClassificationForJson({
        classification: describeLocalSecretsClassification({
          storage: input.storage,
        }),
      }),
    },
    portable_state: {
      status: input.storage.portableState.status,
      trust_model: input.storage.portableState.trustModel,
      message: input.storage.portableState.message,
      classification: serializeEnvClassificationForJson({
        classification: describePortableStateClassification({
          storage: input.storage,
        }),
      }),
    },
    compatibility_mode: {
      plaintext_target: input.storage.localPlaintext.path,
      secret_backend: input.storage.localSecrets.backend,
      plaintext_mirrored_to_backend:
        input.storage.localPlaintext.mirroredToBackend,
      summary: input.storage.localPlaintext.mirroredToBackend
        ? "Plaintext values are bundled in the configured backend and materialize to .hack/.env for compatibility."
        : "Plaintext values materialize to .hack/.env and secret values materialize to the configured secret backend.",
    },
  };
}

export function describeValueStorageForJson(input: {
  readonly value: Pick<HackEnvValueState, "source" | "resolvedFrom">;
  readonly storage: HackEnvStorageSummary;
}): HackEnvValueStorageJson {
  if (input.value.source === "keychain") {
    return {
      kind: "secret",
      backend: input.storage.localSecrets.backend,
      location: input.storage.localSecrets.location,
      mode: input.storage.localSecrets.mode,
      trust_model: input.storage.localSecrets.trustModel,
      classification: serializeEnvClassificationForJson({
        classification: describeLocalSecretsClassification({
          storage: input.storage,
        }),
      }),
    };
  }

  if (input.value.resolvedFrom === "process") {
    return {
      kind: "plaintext",
      backend: "process_env",
      location: "process.env",
      mode: "ambient",
      trust_model: input.storage.localPlaintext.fallback.trustModel,
      classification: serializeEnvClassificationForJson({
        classification: describeLocalPlaintextFallbackClassification(),
      }),
    };
  }

  if (input.value.resolvedFrom === "portable_backend") {
    const classification =
      input.storage.localSecrets.backend === "keychain"
        ? describeAggregateClassification({
            storage: input.storage,
          })
        : describePortableStateClassification({
            storage: input.storage,
          });

    return {
      kind: "plaintext",
      backend: input.storage.localSecrets.backend,
      location: input.storage.localSecrets.location,
      mode: input.storage.localSecrets.mode,
      trust_model: input.storage.portableState.trustModel,
      classification: serializeEnvClassificationForJson({
        classification,
      }),
    };
  }

  return {
    kind: "plaintext",
    backend: "dotenv",
    location: input.storage.localPlaintext.path,
    mode: input.storage.localPlaintext.exists ? "file" : "derived",
    trust_model: input.storage.localPlaintext.trustModel,
    classification: serializeEnvClassificationForJson({
      classification: describeLocalPlaintextClassification(),
    }),
  };
}

export function describeBackendStrategyStatus(input: {
  readonly backend: "keychain" | "encrypted_file" | "cloud";
  readonly provider?: string | null;
  readonly storePlaintextInBackend: boolean;
}): HackEnvBackendStrategyStatus {
  const classification = describeBackendStrategyClassification({
    backend: input.backend,
    storePlaintextInBackend: input.storePlaintextInBackend,
  });
  const providerLabel = input.provider?.trim() || "provider";

  if (input.backend === "keychain") {
    return {
      storageMode: "Encrypted OS-managed secret storage",
      trustModel: "Machine-local secret custody",
      portability: "Not portable by default; values stay on this machine",
      plaintextCompatibility: input.storePlaintextInBackend
        ? "Secret keys and plain env values are both bundled in this backend, while .hack/.env remains a compatibility output."
        : "Secret keys use this backend, while non-secret .env-compatible values still live in .hack/.env.",
      classification,
    };
  }

  if (input.backend === "encrypted_file") {
    return {
      storageMode: "Encrypted local file storage",
      trustModel: input.storePlaintextInBackend
        ? "Portable encrypted bundle"
        : "Machine-local secret custody",
      portability: input.storePlaintextInBackend
        ? "Portable by explicit encrypted bundle and key transfer; still not broker-managed"
        : "Not portable by default; copy and key-sharing are explicit user actions",
      plaintextCompatibility: input.storePlaintextInBackend
        ? "Secret keys and plain env values are both bundled in this backend, while .hack/.env remains a compatibility output."
        : "Secret keys use this backend, while non-secret .env-compatible values still live in .hack/.env.",
      classification,
    };
  }

  return {
    storageMode: `Provider-targeted shim (${providerLabel}) backed by a local encrypted file today`,
    trustModel: input.storePlaintextInBackend
      ? "Portable encrypted bundle"
      : "Machine-local secret custody with provider-intent metadata",
    portability: input.storePlaintextInBackend
      ? "Portable by explicit encrypted bundle and key transfer; cloud mode still resolves through a local encrypted-file shim today and is not broker-managed."
      : "Not remotely portable yet; current cloud mode validates backend intent rather than publishing values off-machine",
    plaintextCompatibility: input.storePlaintextInBackend
      ? "Secret keys and plain env values are both bundled in this backend, while .hack/.env remains a compatibility output."
      : "Secret keys use this backend, while non-secret .env-compatible values still live in .hack/.env.",
    classification,
  };
}

function describeContractClassification(input: {
  readonly storage: HackEnvStorageSummary;
}): HackEnvClassification {
  return {
    trustModel: input.storage.contract.trustModel,
    custody: "metadata_only",
    portability: "contract_only",
    sharedState: "local_only",
  };
}

function describeLocalPlaintextClassification(): HackEnvClassification {
  return {
    trustModel: "unenforced_plaintext_file",
    custody: "local_plaintext_file",
    portability: "local_only",
    sharedState: "plaintext_compatible",
  };
}

function describeLocalPlaintextFallbackClassification(): HackEnvClassification {
  return {
    trustModel: "ambient_process_env",
    custody: "ambient_process_env",
    portability: "local_only",
    sharedState: "local_only",
  };
}

function describeLocalSecretsClassification(input: {
  readonly storage: HackEnvStorageSummary;
}): HackEnvClassification {
  return {
    trustModel: input.storage.localSecrets.trustModel,
    custody: input.storage.localSecrets.trustModel,
    portability: "local_only",
    sharedState: "local_only",
  };
}

function describePortableStateClassification(input: {
  readonly storage: HackEnvStorageSummary;
}): HackEnvClassification {
  if (
    !input.storage.localPlaintext.mirroredToBackend ||
    input.storage.localSecrets.backend === "keychain"
  ) {
    return {
      trustModel: "local_only",
      custody: "machine_local",
      portability: "local_only",
      sharedState: "plaintext_compatible",
    };
  }

  return {
    trustModel: input.storage.portableState.trustModel,
    custody: "portable_encrypted_bundle",
    portability: "portable_encrypted_bundle",
    sharedState: "portable_bundle",
  };
}

function describeAggregateClassification(input: {
  readonly storage: HackEnvStorageSummary;
}): HackEnvClassification {
  if (
    input.storage.localPlaintext.mirroredToBackend &&
    input.storage.localSecrets.backend !== "keychain"
  ) {
    return {
      trustModel: input.storage.portableState.trustModel,
      custody: "portable_encrypted_bundle",
      portability: "portable_encrypted_bundle",
      sharedState: "portable_bundle",
    };
  }

  return {
    trustModel: "local_only",
    custody: "machine_local",
    portability: "local_only",
    sharedState: "plaintext_compatible",
  };
}

function describeAggregateSummary(input: {
  readonly classification: HackEnvClassification;
}): string {
  if (input.classification.sharedState === "portable_bundle") {
    return "Portable encrypted env bundle";
  }
  if (input.classification.sharedState === "broker_managed") {
    return "Broker-managed shared env";
  }
  if (input.classification.sharedState === "plaintext_compatible") {
    return "Local-only env with plaintext compatibility";
  }
  return "Local-only env";
}

function describeAggregateDetail(input: {
  readonly classification: HackEnvClassification;
}): string {
  if (input.classification.sharedState === "portable_bundle") {
    return "Hack can move this env set by copying the encrypted bundle and key, but the values are still not broker-managed shared env state.";
  }
  if (input.classification.sharedState === "broker_managed") {
    return "Hack resolves this env through broker-managed shared custody.";
  }
  if (input.classification.sharedState === "plaintext_compatible") {
    return "Hack still materializes plain env values to .hack/.env for compatibility, and this repo is not using broker-managed shared env custody.";
  }
  return "Hack resolves this env locally on the current machine. It is not broker-managed shared env state.";
}

function describeBackendStrategyClassification(input: {
  readonly backend: "keychain" | "encrypted_file" | "cloud";
  readonly storePlaintextInBackend: boolean;
}): HackEnvClassification {
  if (!input.storePlaintextInBackend) {
    if (input.backend === "cloud") {
      return {
        trustModel: "local_secret_backend_shim",
        custody: "local_secret_backend_shim",
        portability: "local_only",
        sharedState: "plaintext_compatible",
      };
    }

    return {
      trustModel: "local_secret_backend",
      custody: "local_secret_backend",
      portability: "local_only",
      sharedState: "plaintext_compatible",
    };
  }

  if (input.backend === "keychain") {
    return {
      trustModel: "local_only",
      custody: "machine_local",
      portability: "local_only",
      sharedState: "plaintext_compatible",
    };
  }

  return {
    trustModel: "encrypted_backend_bundle",
    custody: "portable_encrypted_bundle",
    portability: "portable_encrypted_bundle",
    sharedState: "portable_bundle",
  };
}
