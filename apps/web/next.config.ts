import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

import { resolveAllowedDevOrigins } from "./src/lib/next-dev-origins";

const rootDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(rootDir, "../..");

const nextConfig: NextConfig = {
  allowedDevOrigins: resolveAllowedDevOrigins(),
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
