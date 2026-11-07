import type { NextConfig } from 'next';
const config: NextConfig = {
  experimental:{serverActions:{bodySizeLimit:process.env.CRM_DEPLOYMENT==='netlify'||process.env.NETLIFY==='true'?'4mb':'65mb'}},
  outputFileTracingIncludes:{'/*':['./node_modules/@electric-sql/pglite/dist/**/*']},
  serverExternalPackages: ['@electric-sql/pglite','pg'],
};
export default config;
