import type { NextConfig } from "next";
import { resolve } from "node:path";

const config: NextConfig = {
  // The Docker image sets NEXT_OUTPUT=standalone; local `next start` needs the default output.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  transpilePackages: ["@pcreader/contracts"],
  poweredByHeader: false,
  // Monorepo: trace workspace packages (contracts) into the standalone build.
  outputFileTracingRoot: resolve(process.cwd(), ".."),
};

export default config;
