import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@projectors/core", "@projectors/demo-agent"],
};

export default nextConfig;
