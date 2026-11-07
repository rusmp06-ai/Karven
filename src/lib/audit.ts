import { randomUUID } from 'node:crypto';
import type {DbTransaction} from './database-types';
import type { Actor } from './access';
export type Tx = DbTransaction;
export async function recordAudit(tx:Tx,actor:Actor,id:string,action:string,details:object={}) {
 await tx.query('INSERT INTO audit_events(id,entity_id,action,details,actor_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,action,JSON.stringify(details),actor.id]);
}
