import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareNativeProjectInput } from "../src/backends/native-project-input.ts";
import { selectNativeProjectRestore } from "../src/backends/native-project-restore.ts";
import { withNativeProjectReview } from "../src/backends/native-project-review.ts";
import type { invokeNativeRuntime } from "../src/backends/native-runtime-client.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hack-native-review-test-"));
  roots.push(root);
  const composeFile = join(root, "compose.json");
  await Bun.write(
    composeFile,
    JSON.stringify({ services: { web: { image: "example" } } })
  );
  const binary = join(root, "native");
  await Bun.write(
    binary,
    `#!${process.execPath}
import {createHash} from "node:crypto";
const args=process.argv.slice(2), value=(key)=>args[args.indexOf(key)+1];
const original=await Bun.file(value("--project")+"/"+value("--file")).text();
const hash=createHash("sha256").update(original).digest("hex");
const namespace=(args.includes("--branch") ? "c" : "a").repeat(64);
if(args.includes("--normalized-file") && (value("--expect-original")!==hash || value("--expect-namespace")!==namespace)) process.exit(4);
console.log(JSON.stringify({plan_id:"b".repeat(64),plan:{namespace,compose_sha256:hash}}));
`
  );
  await chmod(binary, 0o700);
  const input = await prepareNativeProjectInput({
    projectRoot: root,
    projectDir: join(root, ".hack"),
    composeFile,
  });
  return {
    projectRoot: root,
    composeFile,
    input,
    runtime: { binary, home: root },
  };
}

test("review pins native identities and removes its public temporary input", async () => {
  const options = await fixture();
  let file = "";
  await withNativeProjectReview({
    ...options,
    run: async (review) => {
      file =
        review.projectArgs[
          review.projectArgs.indexOf("--normalized-file") + 1
        ] ?? "";
      expect(review.namespace).toBe("a".repeat(64));
      expect(review.projectArgs).toContain(options.input.originalSha256);
      expect(await readFile(file, "utf8")).toBe(
        options.input.normalizedComposeJson
      );
      expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
    },
  });
  expect(await Bun.file(file).exists()).toBe(false);
});

test("an original edit after env preparation stops before the callback", async () => {
  const options = await fixture();
  await Bun.write(options.composeFile, '{"services":{"different":{}}}');
  let ran = false;
  await expect(
    withNativeProjectReview({
      ...options,
      run: async () => {
        ran = true;
      },
    })
  ).rejects.toThrow("input changed");
  expect(ran).toBe(false);
});

test("failed admission removes the temporary public input", async () => {
  const options = await fixture();
  let file = "";
  await expect(
    withNativeProjectReview({
      ...options,
      run: async (review) => {
        file =
          review.projectArgs[
            review.projectArgs.indexOf("--normalized-file") + 1
          ] ?? "";
        throw new Error("synthetic refusal");
      },
    })
  ).rejects.toThrow("synthetic refusal");
  expect(await Bun.file(file).exists()).toBe(false);
});

test("branch selection reaches both reviews and the exact execution arguments", async () => {
  const options = await fixture();
  await withNativeProjectReview({
    ...options,
    branch: "feature-a",
    run: async (review) => {
      expect(review.namespace).toBe("c".repeat(64));
      const index = review.projectArgs.indexOf("--branch");
      expect(index).toBeGreaterThan(-1);
      expect(review.projectArgs[index + 1]).toBe("feature-a");
      expect(
        review.projectArgs.filter((arg) => arg === "--branch")
      ).toHaveLength(1);
    },
  });
});

test("noncanonical branch review refuses before invoking the executor", async () => {
  const options = await fixture();
  await rm(options.runtime.binary);
  await expect(
    withNativeProjectReview({
      ...options,
      branch: "feature/raw",
      run: async () => {
        throw new Error("unreachable callback");
      },
    })
  ).rejects.toThrow("canonical branch");
});

const retained = {
  run: "d".repeat(32),
  owner: "e".repeat(32),
  namespace: "a".repeat(64),
  planId: "b".repeat(64),
};

async function legacyFixture() {
  const options = await fixture();
  const calls: string[][] = [];
  const selected: Record<string, unknown> = {
    run: retained.run,
    owner: retained.owner,
    namespace: retained.namespace,
    plan: retained.planId,
    generation: "f".repeat(64),
  };
  const unbranched: Record<string, unknown> = {
    namespace: retained.namespace,
    source: await realpath(options.projectRoot),
    compose_sha256: options.input.originalSha256,
  };
  const invoke: typeof invokeNativeRuntime = async ({ args }) => {
    calls.push([...args]);
    if (args[0] === "graph") {
      return selected;
    }
    if (!args.includes("--branch")) {
      return { plan_id: retained.planId, plan: unbranched };
    }
    return {
      plan_id: retained.planId,
      plan: { ...unbranched, namespace: "c".repeat(64) },
    };
  };
  return { options, calls, selected, unbranched, invoke };
}

test("legacy retained review uses native unbranched authority and rechecks restore selection", async () => {
  const { options, calls, invoke } = await legacyFixture();
  let temporary = "";
  await withNativeProjectReview({
    ...options,
    branch: "feature-a",
    retained,
    invoke,
    run: async (review) => {
      expect(review.namespace).toBe(retained.namespace);
      expect(review.projectArgs).not.toContain("--branch");
      temporary =
        review.projectArgs[
          review.projectArgs.indexOf("--normalized-file") + 1
        ] ?? "";
      expect(await Bun.file(temporary).text()).toBe(
        options.input.normalizedComposeJson
      );
      const selection = await selectNativeProjectRestore({
        runtime: options.runtime,
        projectRoot: options.projectRoot,
        restore: retained,
        review,
        invoke,
      });
      expect(selection.run).toBe(retained.run);
      expect(selection.flags).toEqual(["--expect-generation", "f".repeat(64)]);
    },
  });
  expect(calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
    "project plan",
    "graph restore-selection",
    "project plan",
    "project plan",
    "graph restore-selection",
  ]);
  expect(await Bun.file(temporary).exists()).toBe(false);
});

test("fresh and current branch-native review never consult legacy restore authority", async () => {
  for (const saved of [undefined, { ...retained, namespace: "c".repeat(64) }]) {
    const { options, calls, invoke } = await legacyFixture();
    await withNativeProjectReview({
      ...options,
      branch: "feature-a",
      retained: saved,
      invoke,
      run: async (review) => {
        expect(review.namespace).toBe("c".repeat(64));
        expect(review.projectArgs).toContain("--branch");
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((args) => args.includes("--branch"))).toBe(true);
  }
});

test("legacy review rejects changed native selection before unbranched review", async () => {
  for (const key of ["run", "owner", "namespace", "plan", "generation"]) {
    const { options, calls, selected, invoke } = await legacyFixture();
    selected[key] = "invalid";
    await expect(
      withNativeProjectReview({
        ...options,
        branch: "feature-a",
        retained,
        invoke,
        run: async () => {
          throw new Error("unexpected callback");
        },
      })
    ).rejects.toThrow("restore selection changed");
    expect(calls).toHaveLength(2);
  }
});

test("legacy review rejects a different project, namespace or edited original without admission", async () => {
  for (const key of ["source", "namespace", "compose_sha256"]) {
    const { options, calls, unbranched, invoke } = await legacyFixture();
    const originalInvoke: typeof invokeNativeRuntime = async (request) => {
      if (request.args[0] === "project" && !request.args.includes("--branch")) {
        unbranched[key] = "foreign";
      }
      return await invoke(request);
    };
    await expect(
      withNativeProjectReview({
        ...options,
        branch: "feature-a",
        retained,
        invoke: originalInvoke,
        run: async () => {
          throw new Error("unexpected callback");
        },
      })
    ).rejects.toThrow("retained project review changed");
    expect(calls).toHaveLength(3);
  }
});

test("legacy review cleans temporary input and refuses selection drift after review", async () => {
  const { options, selected, invoke } = await legacyFixture();
  let temporary = "";
  await expect(
    withNativeProjectReview({
      ...options,
      branch: "feature-a",
      retained,
      invoke,
      run: async (review) => {
        temporary =
          review.projectArgs[
            review.projectArgs.indexOf("--normalized-file") + 1
          ] ?? "";
        selected.owner = "0".repeat(32);
        await selectNativeProjectRestore({
          runtime: options.runtime,
          projectRoot: options.projectRoot,
          restore: retained,
          review,
          invoke,
        });
      },
    })
  ).rejects.toThrow("restore selection changed");
  expect(await Bun.file(temporary).exists()).toBe(false);
});
