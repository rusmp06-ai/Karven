import type { NextConfig } from 'next';
const config: NextConfig = {
  async headers(){return [{source:'/sw.js',headers:[{key:'Cache-Control',value:'no-cache, no-store, must-revalidate'},{key:'Service-Worker-Allowed',value:'/'}]}]},
  experimental:{serverActions:{bodySizeLimit:process.env.CRM_DEPLOYMENT==='netlify'||process.env.NETLIFY==='true'?'4mb':'65mb'}},
  outputFileTracingIncludes:{'/*':['./node_modules/@electric-sql/pglite/dist/**/*','./assets/fonts/**/*']},
  serverExternalPackages: ['@electric-sql/pglite','pg'],
};
export default config;
