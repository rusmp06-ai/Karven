import type { NextConfig } from 'next';
const config: NextConfig = {
  experimental:{serverActions:{bodySizeLimit:'65mb'}},
  serverExternalPackages: ['@electric-sql/pglite'],
};
export default config;
