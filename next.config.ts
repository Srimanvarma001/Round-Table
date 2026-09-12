import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 and the document parsers are native / node-only. Keep them
  // external to the server bundle so the Node runtime can require them directly.
  serverExternalPackages: ['better-sqlite3', 'pdf-parse', 'mammoth', 'pino'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
