import { inputIdentity, verifyArtifact } from "./artifact.ts";

await verifyArtifact({
  root: "/artifacts",
  inputId: await inputIdentity("/source"),
});
const bundlePath = "/artifacts/build/web.js";
await import(bundlePath);
