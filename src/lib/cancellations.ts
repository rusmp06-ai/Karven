import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database,DbTransaction} from './database-types';
import {requireRole,type Actor} from './access';
import {BusinessError,toMinor} from './crm';
import {recordAudit} from './audit';
import {once} from './idempotency';
import {activeShift} from './cash-shifts';
import {queueNotification} from './notification-events';
export const cancelInput=z.object({bookingId:z.uuid(),initiator:z.enum(['client','park']),reason:z.string().trim().min(3).max(1000),retained:z.string().regex(/^\d{1,7}(\.\d{1,2})?$/).default('0'),retentionReason:z.string().trim().max(1000).default(''),requestId:z.uuid(),version:z.coerce.number().int().min(1).optional()});
export type Cancellation={booking_id:string;initiator:string;reason:string;retention_reason:string;paid_at_cancel_minor:number;retained_minor:number;return_due_minor:number;returned_minor:number;outstanding_minor:number;created_by:string|null;actor_name:string|null;created_at:string;legacy:boolean;name:string;phone:string;trip_id:string;origin:string;destination:string;currency:string};
export async function cancelBookingInTx(tx:DbTransaction,actor:Actor,input:z.infer<typeof cancelInput>){
 const b=(await tx.query<{id:string;trip_id:string;status:string;version:number;contact_name:string;contact_phone:string;total_minor:number;origin:string;destination:string;departure_at:string;currency:string;trip_status:string}>(`SELECT b.*,t.origin,t.destination,t.departure_at,t.currency,t.status AS trip_status FROM bookings b JOIN trips t ON t.id=b.trip_id WHERE b.id=$1 FOR UPDATE OF b,t`,[input.bookingId])).rows[0];
 if(!b)throw new BusinessError('Бронь не найдена');if(b.status==='cancelled')return null;
 if(input.version!==undefined&&b.version!==input.version)throw new BusinessError('Бронь уже изменена. Обновите карточку и проверьте условия отмены');
 if(b.trip_status==='completed')throw new BusinessError('Завершённую поездку нельзя отменить; оформите корректировку или частичный возврат');
 if((await tx.query('SELECT position FROM passenger_attendance WHERE booking_id=$1 LIMIT 1',[b.id])).rows.length)throw new BusinessError('Сначала проверьте и исправьте отметки пассажиров');
 const paid=Number((await tx.query<{n:string}>('SELECT ((SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE booking_id=$1)-(SELECT COALESCE(SUM(amount_minor),0) FROM refunds WHERE booking_id=$1))::text AS n',[b.id])).rows[0].n),retained=toMinor(input.retained);
 if(retained>paid)throw new BusinessError('Удержание не может превышать фактически полученную сумму');if(input.initiator==='park'&&retained>0)throw new BusinessError('При отмене парком возврат полный, удержание запрещено');if(retained>0&&input.retentionReason.length<3)throw new BusinessError('Укажите основание удержания');
 const due=paid-retained;await tx.query('INSERT INTO booking_cancellations(booking_id,initiator,reason,retention_reason,paid_at_cancel_minor,retained_minor,return_due_minor,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[b.id,input.initiator,input.reason,input.retentionReason,paid,retained,due,actor.id]);
 await tx.query("UPDATE bookings SET status='cancelled',version=version+1 WHERE id=$1",[b.id]);
 const payload={bookingId:b.id,name:b.contact_name,phone:b.contact_phone,tripId:b.trip_id,route:`${b.origin} → ${b.destination}`,departureAt:new Date(b.departure_at).toISOString(),currency:b.currency,initiator:input.initiator,reason:input.reason,retentionReason:input.retentionReason,paidMinor:paid,retainedMinor:retained,returnDueMinor:due,manager:actor.name};
 await recordAudit(tx,actor,b.id,'booking.cancelled',payload);await queueNotification(tx,`${input.requestId}:${b.id}:cancel`,'booking.cancelled',b.id,payload);return payload;
}
export function createCancellations(db:Database,actor:Actor){return {
 async cancel(raw:unknown){requireRole(actor,'owner','dispatcher');const input=cancelInput.parse(raw);await db.transaction(tx=>once(tx,actor,input.requestId,'cancellation.create',input,async()=>{await cancelBookingInTx(tx,actor,input);}));},
 async returnMoney(raw:unknown){requireRole(actor,'owner','dispatcher');const input=z.object({bookingId:z.uuid(),amount:z.string().regex(/^\d{1,7}(\.\d{1,2})?$/),method:z.enum(['cash','transfer','card']),reference:z.string().trim().min(3).max(500),confirmed:z.literal('yes'),requestId:z.uuid()}).parse(raw),amount=toMinor(input.amount);if(amount<=0)throw new BusinessError('Сумма возврата должна быть больше нуля');
  await db.transaction(tx=>once(tx,actor,input.requestId,'cancellation.return',input,async()=>{
   const c=(await tx.query<{return_due_minor:number;status:string;contact_name:string;contact_phone:string;currency:string;origin:string;destination:string}>(`SELECT c.*,b.status,b.contact_name,b.contact_phone,t.currency,t.origin,t.destination FROM booking_cancellations c JOIN bookings b ON b.id=c.booking_id JOIN trips t ON t.id=b.trip_id WHERE c.booking_id=$1 FOR UPDATE OF c,b`,[input.bookingId])).rows[0];if(!c||c.status!=='cancelled')throw new BusinessError('Отменённая бронь не найдена');
   const returned=Number((await tx.query<{n:string}>('SELECT COALESCE(SUM(amount_minor),0)::text AS n FROM refunds WHERE cancellation_booking_id=$1',[input.bookingId])).rows[0].n);if(amount>c.return_due_minor-returned)throw new BusinessError('Возврат превышает оставшееся обязательство перед клиентом');
   const shift=await activeShift(tx,actor,input.method==='cash'),id=randomUUID();await tx.query('INSERT INTO refunds(id,booking_id,amount_minor,method,reason,created_by,shift_id,cancellation_booking_id) VALUES($1,$2,$3,$4,$5,$6,$7,$2)',[id,input.bookingId,amount,input.method,input.reference,actor.id,shift]);
   const payload={bookingId:input.bookingId,refundId:id,name:c.contact_name,phone:c.contact_phone,route:`${c.origin} → ${c.destination}`,currency:c.currency,amountMinor:amount,remainingMinor:c.return_due_minor-returned-amount,method:input.method,reference:input.reference,manager:actor.name};
   await recordAudit(tx,actor,input.bookingId,'booking.refunded',payload);await queueNotification(tx,`${input.requestId}:refund`,'booking.refunded',input.bookingId,payload);
  }));
 },
 async list():Promise<Cancellation[]>{requireRole(actor,'owner','dispatcher');const rows=(await db.query<Cancellation>(`SELECT c.*,b.contact_name AS name,b.contact_phone AS phone,b.trip_id,t.origin,t.destination,t.currency,u.name AS actor_name,COALESCE(r.n,0)::integer AS returned_minor,(c.return_due_minor-COALESCE(r.n,0))::integer AS outstanding_minor FROM booking_cancellations c JOIN bookings b ON b.id=c.booking_id JOIN trips t ON t.id=b.trip_id LEFT JOIN users u ON u.id=c.created_by LEFT JOIN(SELECT cancellation_booking_id,SUM(amount_minor) AS n FROM refunds WHERE cancellation_booking_id IS NOT NULL GROUP BY cancellation_booking_id)r ON r.cancellation_booking_id=c.booking_id ORDER BY c.created_at DESC,c.booking_id`)).rows;return rows.map(r=>({...r,created_at:new Date(r.created_at).toISOString()}));}
 };}
