import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Shared TypeScript helpers (packages/core) ship as source.
  transpilePackages: ["@obd2/core"],
  // Old demo URLs from before the app shell.
  async redirects() {
    return [
      { source: "/live", destination: "/jobs", permanent: false },
      { source: "/billing", destination: "/workshop/billing", permanent: false },
      { source: "/immo", destination: "/key-programming", permanent: false },
      { source: "/can-studio", destination: "/jobs", permanent: false },
      { source: "/copilot/:id", destination: "/jobs", permanent: false },
    ];
  },
};

export default nextConfig;
