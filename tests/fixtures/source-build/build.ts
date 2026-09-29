import { chmod } from "node:fs/promises";
import { buildArtifact, inputIdentity } from "./artifact.ts";

const source = "/source";
const root = "/artifacts";
const contract: unknown = await Bun.file(`${source}/contract.json`).json();
if (
  typeof contract !== "object" ||
  contract === null ||
  !("fault" in contract)
) {
  throw new Error("Fixture contract missing");
}
const started = performance.now();
const cpuStarted = process.cpuUsage();
const inputId = await inputIdentity(source);
if (
  contract.fault === "tamper-on-reuse" &&
  (await Bun.file(`${root}/build/web.js`).exists())
) {
  await chmod(`${root}/build/web.js`, 0o644);
  await Bun.write(`${root}/build/web.js`, "tampered");
  await chmod(`${root}/build/web.js`, 0o444);
}
const result = await buildArtifact({
  root,
  inputId,
  fault: contract.fault === "interrupt",
  compile: async () => {
    const built = await Bun.build({
      entrypoints: [`${source}/server.ts`],
      target: "bun",
      sourcemap: "none",
    });
    if (!built.success || built.outputs.length !== 1) {
      throw new Error("Fixture Bun build failed");
    }
    const output = built.outputs[0];
    if (!output) {
      throw new Error("Missing bundle");
    }
    return new Uint8Array(await output.arrayBuffer());
  },
});
console.log(
  JSON.stringify({
    ...result,
    elapsedMs: performance.now() - started,
    cpuMicroseconds: process.cpuUsage(cpuStarted),
    residentBytesAfter: process.memoryUsage().rss,
  })
);
