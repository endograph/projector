import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@projectors/core", "@projectors/sandbox-agent"],
};

export default nextConfig;
