import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNativeProjectInput } from "../src/backends/native-project-input.ts";
import { requireNativeStaticStartReview } from "../src/backends/native-project-start-preflight.ts";
import {
  type invokeNativeRuntime,
  nativeRuntimeFailure,
} from "../src/backends/native-runtime-client.ts";
import { readNativeStartRefusals } from "../src/backends/native-start-refusals.ts";

const roots: string[] = [];
const namespace = "a".repeat(64);
const planId = "b".repeat(64);
const reason =
  "Native publishes only TCP ports; keep UDP publication on the Compose backend.";
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-static-review-"));
  roots.push(root);
  const composeFile = join(root, "compose.json");
  await Bun.write(
    composeFile,
    JSON.stringify({ services: { web: { image: "example" } } })
  );
  const input = await prepareNativeProjectInput({
    projectRoot: root,
    projectDir: join(root, ".hack"),
    composeFile,
  });
  const calls: (readonly string[])[] = [];
  let normalized = "";
  let document = "";
  let refusals: unknown = [];
  let compatible = true;
  const invoke: typeof invokeNativeRuntime = async ({ args }) => {
    calls.push(args);
    expect(args.slice(0, 2)).toEqual(["project", "plan"]);
    if (args.includes("--normalized-file")) {
      normalized = args[args.indexOf("--normalized-file") + 1] ?? "";
      document = await readFile(normalized, "utf8");
    }
    return {
      plan_id: planId,
      start_refusals: refusals,
      plan: {
        namespace,
        compose_sha256: input.originalSha256,
        enrollment_compatible: compatible,
        services: { web: { active: true } },
      },
    };
  };
  return {
    opts: {
      runtime: { home: root, binary: "/not-invoked" },
      projectRoot: root,
      composeFile,
      input,
      profiles: ["selected"],
      buildServices: new Set<string>(),
      invoke,
    },
    calls,
    normalized: () => normalized,
    document: () => JSON.parse(document),
    refuse: (value: unknown) => {
      refusals = value;
    },
    incompatible: () => {
      compatible = false;
    },
  };
}

test("static admission uses only bound read-only plans and removes its temporary input", async () => {
  const f = await fixture();
  await requireNativeStaticStartReview(f.opts);
  expect(f.calls).toHaveLength(2);
  for (const args of f.calls) {
    expect(args).toContain("--profile");
    expect(args).toContain("selected");
  }
  expect(f.calls[1]).toContain(f.opts.input.originalSha256);
  expect(f.calls[1]).toContain(namespace);
  expect(await Bun.file(f.normalized()).exists()).toBe(false);
});

test("a fresh branch uses its own namespace selection for both static reviews", async () => {
  const f = await fixture();
  await requireNativeStaticStartReview({ ...f.opts, branch: "feature-check" });
  expect(f.calls).toHaveLength(2);
  for (const args of f.calls) {
    expect(args[args.indexOf("--branch") + 1]).toBe("feature-check");
  }
});

test("a deferred restore does not select retained branch authority during static review", async () => {
  const f = await fixture();
  await requireNativeStaticStartReview({
    ...f.opts,
    branch: "feature-check",
    deferredRestore: true,
  });
  expect(f.calls).toHaveLength(2);
  for (const args of f.calls) {
    expect(args).not.toContain("--branch");
  }
});

test("a static refusal preserves only its code, fixed message and admitted service", async () => {
  const f = await fixture();
  f.refuse([
    {
      code: "graph_port_publication",
      message_fixed: true,
      message: reason,
      service: "web",
      output: "synthetic-private",
    },
  ]);
  const error: unknown = await requireNativeStaticStartReview(f.opts).catch(
    (failure: unknown) => failure
  );
  expect(nativeRuntimeFailure(error)).toEqual({
    code: "graph_port_publication",
    message: reason,
    service: "web",
    startupPhase: "static-preflight",
  });
  expect(String(error)).toContain("no VM was started");
  expect(String(error)).not.toContain("synthetic-private");
  expect(await Bun.file(f.normalized()).exists()).toBe(false);
});

test.each([
  undefined,
  {},
  [null],
  [{ code: "not valid", message: "synthetic-private" }],
])("missing or malformed static admission refuses before a provider call (%j)", async (value) => {
  const f = await fixture();
  f.refuse(value);
  await expect(requireNativeStaticStartReview(f.opts)).rejects.toThrow(
    "static start review is unavailable"
  );
  expect(await Bun.file(f.normalized()).exists()).toBe(false);
});

test("an incompatible static plan refuses even without a start-driver finding", async () => {
  const f = await fixture();
  f.incompatible();
  await expect(requireNativeStaticStartReview(f.opts)).rejects.toThrow(
    "does not admit this configuration"
  );
});

test("an admitted build is projected only for review and keeps the caller's input unchanged", async () => {
  const f = await fixture();
  const input = {
    ...f.opts.input,
    normalizedComposeJson: JSON.stringify({
      services: { web: { build: ".", ports: ["18080:8080/udp"] } },
    }),
  };
  await requireNativeStaticStartReview({
    ...f.opts,
    input,
    buildServices: new Set(["web"]),
  });
  expect(f.document()).toEqual({
    services: {
      web: { image: `sha256:${"0".repeat(64)}`, ports: ["18080:8080/udp"] },
    },
  });
  expect(JSON.parse(input.normalizedComposeJson).services.web).toEqual({
    build: ".",
    ports: ["18080:8080/udp"],
  });
});

test("shared refusal decoding drops authored text and unknown services, and rejects a corrupt list whole", () => {
  expect(
    readNativeStartRefusals(
      [
        {
          code: "graph_budget",
          message: "synthetic-private",
          service: "foreign",
        },
      ],
      ["web"]
    )
  ).toEqual([{ code: "graph_budget" }]);
  expect(
    readNativeStartRefusals([{ code: "graph_budget" }, null], ["web"])
  ).toBeNull();
  expect(
    readNativeStartRefusals(new Array(4097).fill({ code: "graph_budget" }), [
      "web",
    ])
  ).toBeNull();
});
