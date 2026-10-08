import { resolve } from "node:path";
import { rendererCanary } from "./cli-renderer-canary.ts";

declare const __RENDERER_CONTROL_COMPILED__: boolean | undefined;

const mode = process.argv[2];
const root = process.argv[3];
if (!root) {
  throw new Error("Renderer loading control requires its owned root.");
}

if (mode === "build") {
  const result = await Bun.build({
    entrypoints: [import.meta.path],
    target: "bun",
    compile: {
      outfile: root,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    plugins: [rendererCanary],
    define: { __RENDERER_CONTROL_COMPILED__: "true" },
  });
  if (!result.success) {
    throw new Error("Renderer loading control compilation failed.");
  }
  process.stdout.write("built\n");
} else {
  if (
    typeof __RENDERER_CONTROL_COMPILED__ === "undefined" ||
    !__RENDERER_CONTROL_COMPILED__
  ) {
    await Bun.plugin(rendererCanary);
  }
  process.chdir(resolve(root, "project"));
  if (mode === "tui-selected" || mode === "tui-missing-project") {
    Object.defineProperty(process.stdout, "isTTY", { value: true });
  }

  let args: string[];
  switch (mode) {
    case "version":
      args = ["--version"];
      break;
    case "help":
      args = ["--help"];
      break;
    case "remote-help":
      args = ["help", "remote"];
      break;
    case "tui-help":
      args = ["tui", "--help"];
      break;
    case "tui-refused":
    case "tui-selected":
      args = ["tui"];
      break;
    case "remote-selected":
      args = ["remote", "monitor"];
      break;
    case "tui-missing-project":
      args = ["tui", "--path", resolve(root, "missing")];
      break;
    case "remote-missing-project":
      args = ["remote", "monitor", "--path", resolve(root, "missing")];
      break;
    default:
      throw new Error("Unknown renderer loading control.");
  }
  const { runCli } = await import("../../packages/cli/index.ts");
  process.exitCode = await runCli(args);
}
