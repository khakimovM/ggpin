import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Linting runs once, from the root flat config (`npm run lint`, CI), not again inside builds.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
