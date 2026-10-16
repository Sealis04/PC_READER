import type { NextConfig } from "next";
import { resolve } from "node:path";

const config: NextConfig = {
  output: "standalone",
  transpilePackages: ["@pcreader/contracts"],
  poweredByHeader: false,
  // Monorepo: trace workspace packages (contracts) into the standalone build.
  outputFileTracingRoot: resolve(process.cwd(), ".."),
};

export default config;
