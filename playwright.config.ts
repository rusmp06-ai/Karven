import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
export default defineConfig({
 testDir:'./e2e',workers:1,timeout:90000,
 use:{actionTimeout:10000,baseURL:'http://127.0.0.1:3100',headless:true,launchOptions:{executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']}},
 webServer:{command:'node scripts/seed-e2e.mjs && '+(process.env.E2E_PRODUCTION==='true'?'npm start -- --port 3100':'npm run dev -- --port 3100'),url:'http://127.0.0.1:3100/login',reuseExistingServer:false,timeout:90000,env:{KARVEN_E2E_SEED:'true',DATABASE_DIR:mkdtempSync(path.join(tmpdir(),'karven-e2e-')),CRM_ADMIN_USER:'e2e-owner',CRM_ADMIN_PASSWORD:'e2e-owner-password-1234',CRM_COOKIE_SECURE:'false',DATABASE_URL:'',CRM_DEPLOYMENT:'',NETLIFY:'',CRM_TELEGRAM_KEY:'',...(process.env.KARVEN_E2E_PG_URL?{DATABASE_URL:process.env.KARVEN_E2E_PG_URL,CRM_DEPLOYMENT:'netlify',CRM_TELEGRAM_KEY:'ab'.repeat(32)}:{})}},
});
