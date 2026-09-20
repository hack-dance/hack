import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareNativeProjectInput } from "../src/backends/native-project-input.ts";
import { withNativeProjectReview } from "../src/backends/native-project-review.ts";

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
const namespace="a".repeat(64);
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
