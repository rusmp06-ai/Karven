export function isServerless(){return process.env.CRM_DEPLOYMENT==='netlify'||process.env.NETLIFY==='true'}
export function backupLimit(){return isServerless()?3*1024*1024:64*1024*1024}
