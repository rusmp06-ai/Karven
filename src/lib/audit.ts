import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { Actor } from './access';
export type Tx = Parameters<Parameters<PGlite['transaction']>[0]>[0];
export async function recordAudit(tx:Tx,actor:Actor,id:string,action:string,details:object={}) {
 await tx.query('INSERT INTO audit_events(id,entity_id,action,details,actor_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,action,JSON.stringify(details),actor.id]);
}
