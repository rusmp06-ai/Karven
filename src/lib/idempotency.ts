import { createHash } from 'node:crypto';
import type { Actor } from './access';
import type { Tx } from './audit';
import { BusinessError } from './crm';
// Called inside the same transaction as the mutation; failed operations leave no receipt.
export async function once(tx:Tx,actor:Actor,requestId:string,operation:string,payload:object,execute:()=>Promise<void>) {
 const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 const existing=(await tx.query<{actor_id:string;operation:string;payload_hash:string}>('SELECT * FROM mutation_receipts WHERE request_id=$1',[requestId])).rows[0];
 if(existing) {
  if(existing.actor_id!==actor.id||existing.operation!==operation||existing.payload_hash!==hash)throw new BusinessError('Этот идентификатор уже использован для другой операции. Обновите форму.');
  return;
 }
 await execute();
 await tx.query('INSERT INTO mutation_receipts(request_id,actor_id,operation,payload_hash) VALUES($1,$2,$3,$4)',[requestId,actor.id,operation,hash]);
}

// Creation does not replace the receipt table (unlike backup restore), so it can
// claim its receipt up front. A failed creation rolls the claim back with it.
export async function claimCreation(tx:Tx,actor:Actor,requestId:string,operation:string,payload:object){
 const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 const inserted=await tx.query<{request_id:string}>('INSERT INTO mutation_receipts(request_id,actor_id,operation,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT(request_id) DO NOTHING RETURNING request_id',[requestId,actor.id,operation,hash]);
 if(inserted.rows.length)return true;
 const existing=(await tx.query<{actor_id:string;operation:string;payload_hash:string}>('SELECT actor_id,operation,payload_hash FROM mutation_receipts WHERE request_id=$1',[requestId])).rows[0];
 if(!existing||existing.actor_id!==actor.id||existing.operation!==operation||existing.payload_hash!==hash)throw new BusinessError('Этот идентификатор уже использован для другой операции. Обновите форму.');
 return false;
}
