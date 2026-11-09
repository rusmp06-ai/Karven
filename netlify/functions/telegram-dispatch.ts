import {getDb} from '../../src/lib/db';
import {dispatchTelegram} from '../../src/lib/telegram';
import {withWorkspace} from '../../src/lib/workspace-lock';

// Netlify invokes scheduled functions in production; there is no public cron API.
export async function handler(){
 const db=await withWorkspace(()=>getDb());await dispatchTelegram(db,3);
 return {statusCode:204};
}
