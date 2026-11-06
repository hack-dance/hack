import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adaptNativeGcloudEnvironment,
  nativeGcloudCredentialType,
  parseNativeGcloudSelection,
} from "../src/backends/native-gcloud-environment.ts";
import type { NativeProjectInput } from "../src/backends/native-project-input.ts";
import { nativeEnvironmentDelivery } from "../src/backends/native-project-start.ts";

const ADC = ".config/gcloud/application_default_credentials.json";
const REFUSAL =
  "Native gcloud adaptation refused: verify application-default login, the supported read-only ADC mount and selectors; values omitted.";
const user = {
  type: "authorized_user",
  client_id: "synthetic-client-id",
  client_secret: "synthetic-client-secret",
  refresh_token: "synthetic-refresh-token",
  quota_project_id: "synthetic-project",
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
/** A scratch home directory; the real HOME is never read. */
async function home(content: unknown = user, mode = 0o600): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-gcloud-")));
  roots.push(root);
  await mkdir(join(root, ".config/gcloud"), { recursive: true });
  const text = typeof content === "string" ? content : JSON.stringify(content);
  await writeFile(join(root, ADC), text, { mode });
  await chmod(join(root, ADC), mode);
  return root;
}
function input(
  services: Record<string, unknown>,
  managedEnvironment: Record<string, Record<string, string>> = {}
): NativeProjectInput {
  return {
    originalSha256: "a".repeat(64),
    normalizedComposeJson: JSON.stringify({ services }),
    managedEnvironment,
    lifecycleHostEnvironment: {},
    effectiveEnvName: null,
    environmentFiles: [],
    serviceNames: Object.keys(services),
  };
}
/** Delivery against a reviewed plan whose `active` flags are given per service. */
function deliver(
  value: NativeProjectInput,
  active: Record<string, boolean>
): ReturnType<typeof nativeEnvironmentDelivery> {
  return nativeEnvironmentDelivery({
    input: value,
    planId: "p".repeat(64),
    reviewedPlan: {
      services: Object.fromEntries(
        Object.entries(active).map(([name, flag]) => [name, { active: flag }])
      ),
    },
    run: "r".repeat(32),
  });
}
const standard = () =>
  input(
    {
      api: {
        image: "sha256:api",
        volumes: [
          "${HOME}/.config/gcloud/application_default_credentials.json:/srv/app/.config/gcloud/application_default_credentials.json:ro",
          "../src:/app:ro",
        ],
        environment: {
          GOOGLE_APPLICATION_CREDENTIALS:
            "/srv/app/.config/gcloud/application_default_credentials.json",
          GOOGLE_CLOUD_PROJECT: "public-project",
          SECRET: null,
        },
      },
      proxy: {
        image: "sha256:proxy",
        volumes: [
          {
            type: "bind",
            source: "~/.config/gcloud/application_default_credentials.json",
            target: "/config/adc.json",
            read_only: true,
          },
        ],
        environment: ["GOOGLE_APPLICATION_CREDENTIALS"],
      },
      other: { image: "sha256:other", volumes: ["data:/data"] },
    },
    {
      api: { SECRET: "synthetic-app-secret" },
      proxy: { GOOGLE_APPLICATION_CREDENTIALS: "/config/adc.json" },
    }
  );

test("file mode replaces only recognized read-only ADC binds with private file members", async () => {
  const root = await home();
  let mints = 0;
  const original = standard();
  const before = JSON.stringify(original);
  const result = await adaptNativeGcloudEnvironment({
    input: original,
    mode: "file",
    homeDirectory: root,
    mint: async () => {
      mints += 1;
    },
  });
  expect(JSON.stringify(original)).toBe(before);
  expect(mints).toBe(1);
  const compose = JSON.parse(result.input.normalizedComposeJson);
  expect(compose.services.api.volumes).toEqual(["../src:/app:ro"]);
  expect(compose.services.proxy.volumes).toEqual([]);
  expect(compose.services.other).toEqual({
    image: "sha256:other",
    volumes: ["data:/data"],
  });
  expect(compose.services.api.environment).toEqual({
    GOOGLE_APPLICATION_CREDENTIALS:
      "/srv/app/.config/gcloud/application_default_credentials.json",
    GOOGLE_CLOUD_PROJECT: "public-project",
    SECRET: null,
  });
  // A managed selector becomes the public mount target; files-only services keep no values.
  expect(compose.services.proxy.environment).toEqual({
    GOOGLE_APPLICATION_CREDENTIALS: "/config/adc.json",
  });
  expect(result.input.managedEnvironment).toEqual({
    api: { SECRET: "synthetic-app-secret" },
  });
  const files = result.input.managedFiles ?? {};
  expect(Object.keys(files).sort()).toEqual(["api", "proxy"]);
  expect(files.api?.map(({ name, target }) => ({ name, target }))).toEqual([
    {
      name: "gcloud-adc.json",
      target: "/srv/app/.config/gcloud/application_default_credentials.json",
    },
  ]);
  expect(files.proxy?.[0]?.target).toBe("/config/adc.json");
  expect(JSON.parse(files.proxy?.[0]?.content.toString() ?? "")).toEqual(user);
  expect(result.receipt).toEqual({
    mode: "file",
    types: ["authorized_user"],
    services: ["api", "proxy"],
  });
  const receipt = JSON.stringify(result.receipt);
  expect(receipt).not.toContain("synthetic");
  expect(result.input.normalizedComposeJson).not.toContain("synthetic-refresh");
});

test("version two envelope carries files only when members exist", async () => {
  const root = await home();
  const adapted = await adaptNativeGcloudEnvironment({
    input: standard(),
    mode: "file",
    homeDirectory: root,
    mint: async () => undefined,
  });
  const delivery = deliver(adapted.input, { api: true, proxy: true });
  expect(delivery.flags).toEqual(["--environment-stdin"]);
  const envelope = JSON.parse(delivery.payload?.toString() ?? "");
  expect(envelope.version).toBe(2);
  expect(envelope.services).toEqual({
    api: { SECRET: "synthetic-app-secret" },
  });
  expect(envelope.files.proxy).toEqual([
    {
      name: "gcloud-adc.json",
      target: "/config/adc.json",
      mode: "0400",
      content_b64: Buffer.from(JSON.stringify(user)).toString("base64"),
    },
  ]);
  const plain = deliver(standard(), { api: true, proxy: true });
  const v1 = JSON.parse(plain.payload?.toString() ?? "");
  expect(v1.version).toBe(1);
  expect(Object.hasOwn(v1, "files")).toBe(false);
  expect(deliver(input({ web: {} }), { web: true })).toEqual({ flags: [] });
});

test("file members are delivered only for profile-active services; normalization is unchanged", async () => {
  const root = await home();
  const authored = standard();
  const compose = JSON.parse(authored.normalizedComposeJson);
  compose.services.proxy.profiles = ["tools"];
  const optional = {
    ...authored,
    normalizedComposeJson: JSON.stringify(compose),
  };
  const adapted = await adaptNativeGcloudEnvironment({
    input: optional,
    mode: "file",
    homeDirectory: root,
    mint: async () => undefined,
  });
  // The inactive service is still normalized exactly as when it is selected.
  const normalized = JSON.parse(adapted.input.normalizedComposeJson);
  expect(normalized.services.proxy.volumes).toEqual([]);
  expect(normalized.services.proxy.environment).toEqual({
    GOOGLE_APPLICATION_CREDENTIALS: "/config/adc.json",
  });
  expect(Object.keys(adapted.input.managedFiles ?? {}).sort()).toEqual([
    "api",
    "proxy",
  ]);
  const delivery = deliver(adapted.input, {
    api: true,
    proxy: false,
    other: true,
  });
  const envelope = JSON.parse(delivery.payload?.toString() ?? "");
  expect(envelope.version).toBe(2);
  expect(Object.keys(envelope.files)).toEqual(["api"]);
  expect(envelope.files.api).toEqual([
    {
      name: "gcloud-adc.json",
      target: "/srv/app/.config/gcloud/application_default_credentials.json",
      mode: "0400",
      content_b64: Buffer.from(JSON.stringify(user)).toString("base64"),
    },
  ]);
  // A service missing from the reviewed plan is treated as inactive too.
  const unreviewed = deliver(adapted.input, { api: true });
  expect(
    Object.keys(JSON.parse(unreviewed.payload?.toString() ?? "").files)
  ).toEqual(["api"]);
  // When no active service owns a file member the envelope stays version 1.
  const valuesOnly = deliver(adapted.input, { api: false, proxy: false });
  const v1 = JSON.parse(valuesOnly.payload?.toString() ?? "");
  expect(v1.version).toBe(1);
  expect(Object.hasOwn(v1, "files")).toBe(false);
  expect(
    deliver(
      { ...adapted.input, managedEnvironment: {} },
      { api: false, proxy: false }
    )
  ).toEqual({ flags: [] });
});

test("unsupported, writable, directory and duplicate ADC mounts refuse before reading", async () => {
  const root = await home();
  let mints = 0;
  const mint = async () => {
    mints += 1;
  };
  const source = "~/.config/gcloud/application_default_credentials.json";
  for (const volumes of [
    [`${source}:/config/adc.json`],
    [`${source}:/config/adc.json:rw`],
    [`${source}:/config/adc.json:ro:extra`],
    ["~/.config/gcloud:/root/.config/gcloud:ro"],
    ["/opt/other/application_default_credentials.json:/config/adc.json:ro"],
    [`${source}:relative/adc.json:ro`],
    [`${source}:/run/adc.json:ro`],
    [`${source}:/var/run/adc.json:ro`],
    [`${source}:/proc/adc.json:ro`],
    [`${source}:/config/../adc.json:ro`],
    [`${source}:/config/adc.json:ro`, `${source}:/other/adc.json:ro`],
    [`${source}:/config/adc.json:ro`, "data:/config"],
    [`${source}:/config/adc.json:ro`, "/host:/config/adc.json/inner"],
    [{ type: "bind", source, target: "/config/adc.json" }],
    [{ type: "bind", source, target: "/config/adc.json", read_only: false }],
    [
      {
        type: "bind",
        source,
        target: "/config/adc.json",
        read_only: true,
        bind: { propagation: "rprivate" },
      },
    ],
    [{ type: "volume", source, target: "/config/adc.json", read_only: true }],
    [42],
  ]) {
    await expect(
      adaptNativeGcloudEnvironment({
        input: input({ app: { image: "x", volumes } }),
        mode: "file",
        homeDirectory: root,
        mint,
      })
    ).rejects.toThrow(REFUSAL);
  }
  await expect(
    adaptNativeGcloudEnvironment({
      input: input({ app: { image: "x", volumes: ["../src:/app:ro"] } }),
      mode: "file",
      homeDirectory: root,
      mint,
    })
  ).rejects.toThrow(REFUSAL);
  await expect(
    adaptNativeGcloudEnvironment({
      input: input({
        app: {
          image: "x",
          volumes: [`${source}:/tmp/adc.json:ro`],
          tmpfs: ["/tmp"],
        },
      }),
      mode: "file",
      homeDirectory: root,
      mint,
    })
  ).rejects.toThrow(REFUSAL);
  expect(mints).toBe(0);
});

test("selectors that point elsewhere or bypass the delivered file refuse", async () => {
  const root = await home();
  const volumes = [
    "~/.config/gcloud/application_default_credentials.json:/config/adc.json:ro",
  ];
  for (const [environment, managed] of [
    [{ GOOGLE_APPLICATION_CREDENTIALS: "/elsewhere.json" }, {}],
    [{ GOOGLE_APPLICATION_CREDENTIALS: null }, {}],
    [
      { GOOGLE_APPLICATION_CREDENTIALS: null },
      { GOOGLE_APPLICATION_CREDENTIALS: "/elsewhere.json" },
    ],
    [{ CLOUDSDK_CONFIG: "/config" }, {}],
    [{ GCE_METADATA_HOST: "metadata.internal" }, {}],
    [{ GCE_METADATA_IP: "192.0.2.1" }, {}],
    [{ CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: "/token" }, {}],
    [{ CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/other.json" }, {}],
    [{ GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: "1" }, {}],
    [{ PLAIN: null }, { CLOUDSDK_CONFIG: "synthetic-private" }],
  ] as const) {
    await expect(
      adaptNativeGcloudEnvironment({
        input: input(
          { app: { image: "x", volumes, environment } },
          Object.keys(managed).length > 0 ? { app: { ...managed } } : {}
        ),
        mode: "file",
        homeDirectory: root,
        mint: async () => undefined,
      })
    ).rejects.toThrow(REFUSAL);
  }
  // Without any declared selector the mount alone is accepted unchanged.
  const accepted = await adaptNativeGcloudEnvironment({
    input: input({ app: { image: "x", volumes } }),
    mode: "file",
    homeDirectory: root,
    mint: async () => undefined,
  });
  expect(accepted.receipt.services).toEqual(["app"]);
});

test("credential types admit user credentials and refuse keys and external accounts", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
  expect(nativeGcloudCredentialType(encode(user))).toBe("authorized_user");
  expect(
    nativeGcloudCredentialType(
      encode({
        type: "impersonated_service_account",
        service_account_impersonation_url:
          "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/synthetic:generateAccessToken",
        source_credentials: user,
        delegates: [],
      })
    )
  ).toBe("impersonated_service_account");
  for (const value of [
    { type: "service_account", private_key: "synthetic-key" },
    { type: "external_account", credential_source: { file: "/token" } },
    { type: "external_account_authorized_user", refresh_token: "x" },
    { ...user, client_secret: "" },
    { ...user, refresh_token: 1 },
    { type: "authorized_user" },
    {
      ...user,
      nested: { credential_source: { executable: { command: "x" } } },
    },
    {
      type: "impersonated_service_account",
      service_account_impersonation_url: "http://insecure",
      source_credentials: user,
    },
    {
      type: "impersonated_service_account",
      service_account_impersonation_url: "https://iam.example",
      source_credentials: { type: "service_account" },
    },
    [user],
    "text",
  ]) {
    expect(() => nativeGcloudCredentialType(encode(value))).toThrow(REFUSAL);
  }
  expect(() =>
    nativeGcloudCredentialType(Buffer.from([0x7b, 0xff, 0x7d]))
  ).toThrow(REFUSAL);
  expect(() => nativeGcloudCredentialType(Buffer.from("{"))).toThrow(REFUSAL);
});

test("unsafe or missing host ADC files refuse without calling gcloud", async () => {
  const volumes = [
    "~/.config/gcloud/application_default_credentials.json:/config/adc.json:ro",
  ];
  const attempt = async (root: string) => {
    let mints = 0;
    await expect(
      adaptNativeGcloudEnvironment({
        input: input({ app: { image: "x", volumes } }),
        mode: "file",
        homeDirectory: root,
        mint: async () => {
          mints += 1;
        },
      })
    ).rejects.toThrow(REFUSAL);
    expect(mints).toBe(0);
  };
  await attempt(await home(user, 0o660));
  await attempt(await home(user, 0o602));
  await attempt(await home("x".repeat(16 * 1024 + 1)));
  await attempt(await home(""));
  await attempt(await home({ type: "service_account", private_key: "k" }));
  const empty = await realpath(await mkdtemp(join(tmpdir(), "native-gcloud-")));
  roots.push(empty);
  await attempt(empty);
  const linked = await realpath(
    await mkdtemp(join(tmpdir(), "native-gcloud-"))
  );
  roots.push(linked);
  const target = await home();
  await mkdir(join(linked, ".config/gcloud"), { recursive: true });
  await symlink(join(target, ADC), join(linked, ADC));
  await attempt(linked);
  // Readable but not writable by others is accepted.
  const readable = await adaptNativeGcloudEnvironment({
    input: input({ app: { image: "x", volumes } }),
    mode: "file",
    homeDirectory: await home(user, 0o644),
    mint: async () => undefined,
  });
  expect(readable.receipt.types).toEqual(["authorized_user"]);
});

test("a failed mint or an ADC change during startup refuses with no files", async () => {
  const volumes = [
    "~/.config/gcloud/application_default_credentials.json:/config/adc.json:ro",
  ];
  const root = await home();
  await expect(
    adaptNativeGcloudEnvironment({
      input: input({ app: { image: "x", volumes } }),
      mode: "file",
      homeDirectory: root,
      mint: async () => {
        throw new Error("synthetic-token-output reauth required");
      },
    })
  ).rejects.toThrow(REFUSAL);
  const error = await adaptNativeGcloudEnvironment({
    input: input({ app: { image: "x", volumes } }),
    mode: "file",
    homeDirectory: root,
    mint: async () => {
      // A re-login replaces the file while the start is in progress.
      await rm(join(root, ADC));
      await writeFile(join(root, ADC), JSON.stringify(user), { mode: 0o600 });
    },
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(REFUSAL);
  expect((error as Error).message).not.toContain("synthetic");
});

test("selector-only recheck rewrites Compose identically without reading or minting", async () => {
  const root = await home();
  const full = await adaptNativeGcloudEnvironment({
    input: standard(),
    mode: "file",
    homeDirectory: root,
    mint: async () => undefined,
  });
  await rm(join(root, ADC));
  const recheck = await adaptNativeGcloudEnvironment({
    input: standard(),
    mode: "file",
    deliver: false,
    homeDirectory: root,
    mint: async () => {
      throw new Error("must not mint");
    },
  });
  expect(recheck.input.normalizedComposeJson).toBe(
    full.input.normalizedComposeJson
  );
  expect(recheck.input.managedEnvironment).toEqual(
    full.input.managedEnvironment
  );
  expect(recheck.input.managedFiles).toBeUndefined();
});

test("only the explicit file selector is accepted", () => {
  expect(parseNativeGcloudSelection(undefined)).toBeUndefined();
  expect(parseNativeGcloudSelection("")).toBeUndefined();
  expect(parseNativeGcloudSelection("file")).toEqual({ mode: "file" });
  for (const value of ["token", "FILE", "1", "true"]) {
    expect(() => parseNativeGcloudSelection(value)).toThrow(
      "HACK_NATIVE_GCLOUD_ADC accepts only `file`."
    );
  }
});
