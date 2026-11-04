import type { NextConfig } from "next";
import { loadEnvConfig } from "@next/env";

// .env.local is not loaded yet when this file runs; load it so ZECHUNT_DEV_ORIGINS applies.
loadEnvConfig(process.cwd());

const nextConfig: NextConfig = {
  // Lets phones on the same Wi-Fi load dev assets (two-device testing).
  // e.g. ZECHUNT_DEV_ORIGINS=192.168.1.11
  allowedDevOrigins: (process.env.ZECHUNT_DEV_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  // Frontend-only deployments (Vercel) forward every API call to the backend box that
  // owns the database, the worker and the wallet. Unset locally and on the backend.
  async rewrites() {
    const api = process.env.ZECHUNT_BACKEND_URL?.replace(/\/+$/, "");
    return { beforeFiles: api ? [{ source: "/api/:path*", destination: `${api}/api/:path*` }] : [], afterFiles: [], fallback: [] };
  },
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
