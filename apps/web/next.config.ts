import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export — deployable to any static host (PRD Part B §14):
  output: "export",
  images: { unoptimized: true },
  devIndicators: false,
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
