import { expect, test } from "bun:test";

import {
  buildEnvManagementState,
  loadEnvManagementState,
} from "../src/lib/env-management";

test("env management keeps local-only plaintext-compatible state distinct from broker-managed env", () => {
  const state = buildEnvManagementState({
    list: {
      project: "hack-cli",
      env_selection: {
        requested: null,
        default: null,
        effective: null,
        overlay_path: null,
        overlay_exists: false,
      },
      status: {
        trust_model: "local_only",
        custody: "machine_local",
        portability: "local_only",
        shared_state: "plaintext_compatible",
        summary: "Local-only env with plaintext compatibility",
        detail:
          "Hack still materializes plain env values to .hack/.env for compatibility, and this repo is not using broker-managed shared env custody.",
      },
      storage: {
        local_plaintext: {
          path: "/repo/.hack/.env",
          exists: true,
          trust_model: "unenforced_plaintext_file",
          mirrored_to_backend: false,
          fallback: {
            enabled: true,
            source: "process_env",
            trust_model: "ambient_process_env",
            classification: {
              trust_model: "ambient_process_env",
              custody: "ambient_process_env",
              portability: "local_only",
              shared_state: "local_only",
            },
          },
          classification: {
            trust_model: "unenforced_plaintext_file",
            custody: "local_plaintext_file",
            portability: "local_only",
            shared_state: "plaintext_compatible",
          },
        },
        local_secrets: {
          backend: "encrypted_file",
          location: "~/.hack/secrets.enc.json",
          mode: "native",
          provider: null,
          trust_model: "local_secret_backend",
          classification: {
            trust_model: "local_secret_backend",
            custody: "local_secret_backend",
            portability: "local_only",
            shared_state: "local_only",
          },
        },
        portable_state: {
          status: "not_configured",
          trust_model: "local_only",
          message: "Portable encrypted bundles are not configured yet.",
          classification: {
            trust_model: "local_only",
            custody: "machine_local",
            portability: "local_only",
            shared_state: "plaintext_compatible",
          },
        },
        compatibility_mode: {
          plaintext_target: "/repo/.hack/.env",
          secret_backend: "encrypted_file",
          plaintext_mirrored_to_backend: false,
          summary:
            "Plaintext values materialize to .hack/.env and secret values materialize to the configured secret backend.",
        },
      },
      vars: [
        {
          key: "PUBLIC_URL",
          required: true,
          source: "plain_env",
          services: ["web"],
          resolved_from: "dotenv",
          value: "https://hack-cli.hack",
          storage: {
            kind: "plaintext",
            backend: "dotenv",
            location: "/repo/.hack/.env",
            mode: "file",
            trust_model: "unenforced_plaintext_file",
            classification: {
              trust_model: "unenforced_plaintext_file",
              custody: "local_plaintext_file",
              portability: "local_only",
              shared_state: "plaintext_compatible",
            },
          },
        },
        {
          key: "API_KEY",
          required: false,
          source: "keychain",
          services: ["auth"],
          resolved_from: "keychain",
          value: "***",
          storage: {
            kind: "secret",
            backend: "encrypted_file",
            location: "~/.hack/secrets.enc.json",
            mode: "native",
            trust_model: "local_secret_backend",
            classification: {
              trust_model: "local_secret_backend",
              custody: "local_secret_backend",
              portability: "local_only",
              shared_state: "local_only",
            },
          },
        },
      ],
      missing_required: [],
    },
    backend: {
      backend: "encrypted_file",
      allow_env_auth_refs: false,
      store_plaintext_in_backend: false,
      encrypted_file: {
        path: "~/.hack/secrets.enc.json",
      },
      encrypted_file_key_env: "HACK_SECRETS_FILE_KEY",
      cloud: {
        provider: null,
        project: null,
        secretPrefix: "hack",
      },
      status: {
        storage_mode: "Encrypted local file storage",
        trust_model: "Machine-local secret custody",
        portability:
          "Not portable by default; copy and key-sharing are explicit user actions",
        plaintext_compatibility:
          "Secret keys use this backend, while non-secret .env-compatible values still live in .hack/.env.",
        classification: {
          trust_model: "local_secret_backend",
          custody: "local_secret_backend",
          portability: "local_only",
          shared_state: "plaintext_compatible",
        },
      },
    },
  });

  expect(state.status.sharedState).toBe("plaintext_compatible");
  expect(state.status.portability).toBe("local_only");
  expect(state.status.detail).toContain("not using broker-managed");
  expect(state.backend.classification.sharedState).toBe("plaintext_compatible");
  expect(state.localPlaintext.classification.custody).toBe(
    "local_plaintext_file"
  );
  expect(state.variables).toHaveLength(2);
  const publicUrl = state.variables.find((entry) => entry.key === "PUBLIC_URL");
  expect(publicUrl?.storage.kind).toBe("plaintext");
  expect(publicUrl?.storage.backend).toBe("dotenv");
  expect(publicUrl?.storage.classification.custody).toBe(
    "local_plaintext_file"
  );
  const apiKey = state.variables.find((entry) => entry.key === "API_KEY");
  expect(apiKey?.source).toBe("keychain");
  expect(apiKey?.resolvedSource).toBe("keychain");
  expect(apiKey?.storage.kind).toBe("secret");
  expect(apiKey?.storage.classification.sharedState).toBe("local_only");
  expect(state.portableState.classification.sharedState).not.toBe(
    "broker_managed"
  );
});

test("env management surfaces portable encrypted bundles without implying broker custody", () => {
  const state = buildEnvManagementState({
    list: {
      project: "hack-cli",
      env_selection: {
        requested: "qa",
        default: "qa",
        effective: "qa",
        overlay_path: "/repo/.hack/.env.qa",
        overlay_exists: false,
      },
      status: {
        trust_model: "encrypted_backend_bundle",
        custody: "portable_encrypted_bundle",
        portability: "portable_encrypted_bundle",
        shared_state: "portable_bundle",
        summary: "Portable encrypted env bundle",
        detail:
          "Hack can move this env set by copying the encrypted bundle and key, but the values are still not broker-managed shared env state.",
      },
      storage: {
        local_plaintext: {
          path: "/repo/.hack/.env",
          exists: false,
          trust_model: "unenforced_plaintext_file",
          mirrored_to_backend: true,
          fallback: {
            enabled: true,
            source: "process_env",
            trust_model: "ambient_process_env",
            classification: {
              trust_model: "ambient_process_env",
              custody: "ambient_process_env",
              portability: "local_only",
              shared_state: "local_only",
            },
          },
          classification: {
            trust_model: "unenforced_plaintext_file",
            custody: "local_plaintext_file",
            portability: "local_only",
            shared_state: "plaintext_compatible",
          },
        },
        local_secrets: {
          backend: "encrypted_file",
          location: "/repo/.hack-secrets.enc.json",
          mode: "native",
          provider: null,
          trust_model: "local_secret_backend",
          classification: {
            trust_model: "local_secret_backend",
            custody: "local_secret_backend",
            portability: "local_only",
            shared_state: "local_only",
          },
        },
        portable_state: {
          status: "backend_bundle",
          trust_model: "encrypted_backend_bundle",
          message:
            "Plaintext and secret env values are bundled in the encrypted backend.",
          classification: {
            trust_model: "encrypted_backend_bundle",
            custody: "portable_encrypted_bundle",
            portability: "portable_encrypted_bundle",
            shared_state: "portable_bundle",
          },
        },
        compatibility_mode: {
          plaintext_target: "/repo/.hack/.env",
          secret_backend: "encrypted_file",
          plaintext_mirrored_to_backend: true,
          summary:
            "Plaintext values are bundled in the configured backend and materialize to .hack/.env for compatibility.",
        },
      },
      vars: [
        {
          key: "PORTABLE_TOKEN",
          required: false,
          source: "plain_env",
          services: ["api"],
          resolved_from: "portable_backend",
          value: "***",
          storage: {
            kind: "plaintext",
            backend: "encrypted_file",
            location: "/repo/.hack-secrets.enc.json",
            mode: "native",
            trust_model: "encrypted_backend_bundle",
            classification: {
              trust_model: "encrypted_backend_bundle",
              custody: "portable_encrypted_bundle",
              portability: "portable_encrypted_bundle",
              shared_state: "portable_bundle",
            },
          },
        },
      ],
      missing_required: ["DATABASE_URL"],
    },
    backend: {
      backend: "encrypted_file",
      allow_env_auth_refs: false,
      store_plaintext_in_backend: true,
      encrypted_file: {
        path: "/repo/.hack-secrets.enc.json",
      },
      encrypted_file_key_env: "HACK_SECRETS_FILE_KEY",
      cloud: {
        provider: null,
        project: null,
        secretPrefix: "hack",
      },
      status: {
        storage_mode: "Encrypted local file storage",
        trust_model: "Portable encrypted bundle",
        portability:
          "Portable by explicit encrypted bundle and key transfer; still not broker-managed",
        plaintext_compatibility:
          "Secret keys and plain env values are both bundled in this backend, while .hack/.env remains a compatibility output.",
        classification: {
          trust_model: "encrypted_backend_bundle",
          custody: "portable_encrypted_bundle",
          portability: "portable_encrypted_bundle",
          shared_state: "portable_bundle",
        },
      },
    },
  });

  expect(state.status.sharedState).toBe("portable_bundle");
  expect(state.status.custody).toBe("portable_encrypted_bundle");
  expect(state.backend.classification.sharedState).toBe("portable_bundle");
  expect(state.backend.status.portability).toContain("not broker-managed");
  expect(state.missingRequired).toEqual(["DATABASE_URL"]);
  expect(state.envSelectionLabel).toContain("qa");
  expect(state.variables).toHaveLength(1);
  expect(state.variables[0]?.key).toBe("PORTABLE_TOKEN");
  expect(state.variables[0]?.resolvedSource).toBe("portable_backend");
  expect(state.variables[0]?.storage.backend).toBe("encrypted_file");
  expect(state.variables[0]?.storage.classification.sharedState).toBe(
    "portable_bundle"
  );
});

test("env management falls back to an explicit unavailable state when repo-bound env commands fail", async () => {
  const state = await loadEnvManagementState({
    runCommandImplementation: async () => ({
      payload: null,
      output: "env command unavailable while apps/web is offline",
    }),
  });

  expect(state.ready).toBe(false);
  expect(state.status.summary).toBe("Env status unavailable");
  expect(state.status.sharedState).toBe("unavailable");
  expect(state.status.detail).toBe(
    "env command unavailable while apps/web is offline"
  );
  expect(state.backend.classification.sharedState).toBe("unavailable");
  expect(state.variables).toEqual([]);
  expect(state.statusCommand).toBe("./dist/hack env list --json");
  expect(state.backendCommand).toBe("./dist/hack env backend status --json");
});
