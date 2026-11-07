import { randomUUID } from 'node:crypto';
import type {Database} from './database-types';
import { z } from 'zod';
import { type Actor, requireRole } from './access';
import { recordAudit, type Tx } from './audit';
import { BusinessError, toMinor } from './crm';
import { once } from './idempotency';
const uuid=z.string().uuid();
const amount=z.string().regex(/^\d{1,7}(\.\d{1,2})?$/,'Введите сумму с точностью до двух знаков');
const reason=z.string().trim().min(3,'Укажите причину (минимум 3 символа)').max(500);
const method=z.enum(['cash','transfer','card']);
const requestId=uuid;
async function tripLock(tx:Tx,id:string) {
 const trip=(await tx.query<{id:string;status:string;departure_at:Date;driver_id:string|null;vehicle_id:string|null}>('SELECT * FROM trips WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!trip)throw new BusinessError('Рейс не найден');
 return trip;
}
async function unlockedExpenses(tx:Tx,id:string) {
 if((await tx.query('SELECT trip_id FROM driver_settlements WHERE trip_id=$1',[id])).rows.length)throw new BusinessError('Расчёт уже утверждён: расходы зафиксированы');
}
export function createFinance(db:Database,actor:Actor) {
 return {
  async completeTrip(raw:unknown) {
   requireRole(actor,'owner','dispatcher');
   const input=z.object({tripId:uuid,requestId}).parse(raw);
   await db.transaction(tx=>once(tx,actor,input.requestId,'trip.complete',input,async()=>{
    const trip=await tripLock(tx,input.tripId);
    if(trip.status==='completed')return;
    if(trip.status!=='scheduled')throw new BusinessError('Отменённый рейс нельзя завершить');
    if(!trip.driver_id||!trip.vehicle_id)throw new BusinessError('Сначала назначьте водителя и автомобиль');
    if(new Date(trip.departure_at).getTime()>Date.now())throw new BusinessError('Нельзя завершить рейс до отправления');
    const pending=(await tx.query<{missing:number}>("SELECT COALESCE(SUM(b.passenger_count-(SELECT COUNT(*) FROM passenger_attendance a WHERE a.booking_id=b.id)),0)::integer AS missing FROM bookings b WHERE b.trip_id=$1 AND b.status='confirmed'",[input.tripId])).rows[0].missing;
    if(pending>0)throw new BusinessError(`Осталось отметить посадку или неявку пассажиров: ${pending}`);
    await tx.query("UPDATE trips SET status='completed',completed_at=now() WHERE id=$1",[input.tripId]);
    await recordAudit(tx,actor,input.tripId,'trip.completed');
   }));
  },
  async refund(raw:unknown) {
   requireRole(actor,'owner');
   const input=z.object({bookingId:uuid,amount,reason,method,requestId}).parse(raw);
   const value=toMinor(input.amount);
   if(value<=0)throw new BusinessError('Сумма возврата должна быть больше нуля');
   await db.transaction(tx=>once(tx,actor,input.requestId,'booking.refund',input,async()=>{
    const booking=(await tx.query<{status:string}>('SELECT status FROM bookings WHERE id=$1 FOR UPDATE',[input.bookingId])).rows[0];
    if(!booking||booking.status!=='confirmed')throw new BusinessError('Активная бронь не найдена');
    const net=(await tx.query<{amount:number}>('SELECT ((SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE booking_id=$1)-(SELECT COALESCE(SUM(amount_minor),0) FROM refunds WHERE booking_id=$1))::integer AS amount',[input.bookingId])).rows[0].amount;
    if(value>net)throw new BusinessError('Возврат превышает полученную сумму за вычетом прошлых возвратов');
    await tx.query('INSERT INTO refunds(id,booking_id,amount_minor,method,reason,created_by) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),input.bookingId,value,input.method,input.reason,actor.id]);
    await recordAudit(tx,actor,input.bookingId,'booking.refunded',{amountMinor:value,method:input.method,reason:input.reason});
   }));
  },
  async cancelWithRefund(raw:unknown) {
   requireRole(actor,'owner');
   const input=z.object({bookingId:uuid,reason,method,requestId}).parse(raw);
   await db.transaction(tx=>once(tx,actor,input.requestId,'booking.cancel_refund',input,async()=>{
    const booking=(await tx.query<{trip_id:string;status:string}>('SELECT trip_id,status FROM bookings WHERE id=$1 FOR UPDATE',[input.bookingId])).rows[0];
    if(!booking)throw new BusinessError('Бронь не найдена');
    if(booking.status==='cancelled')return;
    const trip=await tripLock(tx,booking.trip_id);
    if(trip.status==='completed')throw new BusinessError('Нельзя отменить бронь завершённого рейса. Для уменьшения стоимости оформите частичный возврат.');
    if((await tx.query('SELECT position FROM passenger_attendance WHERE booking_id=$1 LIMIT 1',[input.bookingId])).rows.length)throw new BusinessError('Сначала исправьте отметки пассажиров перед отменой');
    const net=(await tx.query<{amount:number}>('SELECT ((SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE booking_id=$1)-(SELECT COALESCE(SUM(amount_minor),0) FROM refunds WHERE booking_id=$1))::integer AS amount',[input.bookingId])).rows[0].amount;
    if(net>0) {
     await tx.query('INSERT INTO refunds(id,booking_id,amount_minor,method,reason,created_by) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),input.bookingId,net,input.method,input.reason,actor.id]);
     await recordAudit(tx,actor,input.bookingId,'booking.refunded',{amountMinor:net,method:input.method,reason:input.reason});
    }
    await tx.query("UPDATE bookings SET status='cancelled' WHERE id=$1",[input.bookingId]);
    await recordAudit(tx,actor,input.bookingId,'booking.cancelled',{refundMinor:net,reason:input.reason});
   }));
  },
  async addExpense(raw:unknown) {
   requireRole(actor,'owner','dispatcher');
   const input=z.object({tripId:uuid,amount,category:z.enum(['fuel','toll','parking','other']),paidBy:z.enum(['park','driver']),description:reason,requestId}).parse(raw);
   const value=toMinor(input.amount);if(value<=0)throw new BusinessError('Расход должен быть больше нуля');
   await db.transaction(tx=>once(tx,actor,input.requestId,'expense.add',input,async()=>{
    const trip=await tripLock(tx,input.tripId);await unlockedExpenses(tx,input.tripId);
    if(input.paidBy==='driver'&&!trip.driver_id)throw new BusinessError('Сначала назначьте водителя');
    const id=randomUUID();
    await tx.query('INSERT INTO trip_expenses(id,trip_id,amount_minor,category,paid_by,description,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,input.tripId,value,input.category,input.paidBy,input.description,actor.id]);
    await recordAudit(tx,actor,input.tripId,'expense.recorded',{expenseId:id,amountMinor:value,paidBy:input.paidBy,category:input.category});
   }));
  },
  async voidExpense(raw:unknown) {
   requireRole(actor,'owner');
   const input=z.object({expenseId:uuid,reason,requestId}).parse(raw);
   await db.transaction(tx=>once(tx,actor,input.requestId,'expense.void',input,async()=>{
    const expense=(await tx.query<{trip_id:string;voided_at:Date|null}>('SELECT trip_id,voided_at FROM trip_expenses WHERE id=$1 FOR UPDATE',[input.expenseId])).rows[0];
    if(!expense)throw new BusinessError('Расход не найден');
    if(expense.voided_at)return;
    await tripLock(tx,expense.trip_id);await unlockedExpenses(tx,expense.trip_id);
    await tx.query('UPDATE trip_expenses SET voided_at=now(),void_reason=$2 WHERE id=$1',[input.expenseId,input.reason]);
    await recordAudit(tx,actor,expense.trip_id,'expense.voided',{expenseId:input.expenseId,reason:input.reason});
   }));
  },
  async approveSettlement(raw:unknown) {
   requireRole(actor,'owner');
   const input=z.object({tripId:uuid,fee:amount,note:reason,requestId}).parse(raw);
   const fee=toMinor(input.fee);
   await db.transaction(tx=>once(tx,actor,input.requestId,'settlement.approve',input,async()=>{
    const trip=await tripLock(tx,input.tripId);
    if(!['completed','cancelled'].includes(trip.status)||!trip.driver_id)throw new BusinessError('Сначала завершите или отмените рейс с назначенным водителем');
    if((await tx.query('SELECT trip_id FROM driver_settlements WHERE trip_id=$1',[input.tripId])).rows.length)throw new BusinessError('Расчёт уже утверждён');
    const reimbursement=(await tx.query<{amount:string}>("SELECT COALESCE(SUM(amount_minor),0) AS amount FROM trip_expenses WHERE trip_id=$1 AND paid_by='driver' AND voided_at IS NULL",[input.tripId])).rows[0].amount;
    await tx.query('INSERT INTO driver_settlements(trip_id,driver_id,fee_minor,reimbursement_minor,note,approved_by) VALUES($1,$2,$3,$4,$5,$6)',[input.tripId,trip.driver_id,fee,reimbursement,input.note,actor.id]);
    await recordAudit(tx,actor,input.tripId,'settlement.approved',{feeMinor:fee,reimbursementMinor:Number(reimbursement),note:input.note});
   }));
  },
  async payDriver(raw:unknown) {
   requireRole(actor,'owner');
   const input=z.object({tripId:uuid,amount,method,requestId}).parse(raw);
   const value=toMinor(input.amount);if(value<=0)throw new BusinessError('Выплата должна быть больше нуля');
   await db.transaction(tx=>once(tx,actor,input.requestId,'driver.payout',input,async()=>{
    const settlement=(await tx.query<{fee_minor:number;reimbursement_minor:string}>('SELECT * FROM driver_settlements WHERE trip_id=$1 FOR UPDATE',[input.tripId])).rows[0];
    if(!settlement)throw new BusinessError('Сначала утвердите расчёт с водителем');
    const paid=Number((await tx.query<{amount:string}>('SELECT COALESCE(SUM(amount_minor),0) AS amount FROM driver_payouts WHERE trip_id=$1',[input.tripId])).rows[0].amount);
    if(value>settlement.fee_minor+Number(settlement.reimbursement_minor)-paid)throw new BusinessError('Выплата превышает остаток расчёта с водителем');
    await tx.query('INSERT INTO driver_payouts(id,trip_id,amount_minor,method,created_by) VALUES($1,$2,$3,$4,$5)',[randomUUID(),input.tripId,value,input.method,actor.id]);
    await recordAudit(tx,actor,input.tripId,'driver.paid',{amountMinor:value,method:input.method});
   }));
  },
  async report():Promise<FinanceReport> {
   requireRole(actor,'owner','dispatcher','driver');
   const driverOnly=actor.role==='driver';
   const trips=(await db.query<FinanceTrip>(`SELECT t.id,t.origin,t.destination,t.currency,t.status,t.driver_id,d.name AS driver_name,
    COALESCE(b.revenue,0)::float8 AS revenue_minor,COALESCE(p.amount,0)::float8 AS received_minor,COALESCE(r.amount,0)::float8 AS refunded_minor,
    COALESCE(e.amount,0)::float8 AS expenses_minor,COALESCE(e.driver_amount,0)::float8 AS driver_expenses_minor,
    s.fee_minor, s.reimbursement_minor::float8, s.note AS settlement_note, s.approved_at,
    COALESCE(o.amount,0)::float8 AS paid_driver_minor,
    (COALESCE(p.amount,0)-COALESCE(r.amount,0)-COALESCE(e.park_amount,0)-COALESCE(o.amount,0))::float8 AS cash_minor,
    CASE WHEN s.trip_id IS NULL AND t.status='cancelled' AND t.driver_id IS NULL THEN -COALESCE(e.amount,0)::float8 WHEN s.trip_id IS NULL THEN NULL ELSE (COALESCE(b.revenue,0)-COALESCE(e.amount,0)-s.fee_minor)::float8 END AS result_minor
    FROM trips t LEFT JOIN drivers d ON d.id=t.driver_id
    LEFT JOIN (SELECT b.trip_id,SUM(b.total_minor-COALESCE(r.amount,0)) AS revenue FROM bookings b LEFT JOIN (SELECT booking_id,SUM(amount_minor) AS amount FROM refunds GROUP BY booking_id) r ON r.booking_id=b.id WHERE b.status='confirmed' GROUP BY b.trip_id) b ON b.trip_id=t.id
    LEFT JOIN (SELECT b.trip_id,SUM(p.amount_minor) AS amount FROM payments p JOIN bookings b ON b.id=p.booking_id GROUP BY b.trip_id) p ON p.trip_id=t.id
    LEFT JOIN (SELECT b.trip_id,SUM(r.amount_minor) AS amount FROM refunds r JOIN bookings b ON b.id=r.booking_id GROUP BY b.trip_id) r ON r.trip_id=t.id
    LEFT JOIN (SELECT trip_id,SUM(amount_minor) AS amount,SUM(amount_minor) FILTER(WHERE paid_by='driver') AS driver_amount,SUM(amount_minor) FILTER(WHERE paid_by='park') AS park_amount FROM trip_expenses WHERE voided_at IS NULL GROUP BY trip_id) e ON e.trip_id=t.id
    LEFT JOIN driver_settlements s ON s.trip_id=t.id
    LEFT JOIN (SELECT trip_id,SUM(amount_minor) AS amount FROM driver_payouts GROUP BY trip_id) o ON o.trip_id=t.id
    WHERE ($1::boolean=false OR t.driver_id=$2::uuid) ORDER BY t.departure_at DESC`,[driverOnly,actor.driver_id])).rows;
   const expenses=(await db.query<Expense>(`SELECT e.id,e.trip_id,e.amount_minor,e.category,e.paid_by,e.description,e.voided_at,e.void_reason,e.created_at FROM trip_expenses e JOIN trips t ON t.id=e.trip_id WHERE ($1::boolean=false OR (t.driver_id=$2::uuid AND e.paid_by='driver')) ORDER BY e.created_at DESC`,[driverOnly,actor.driver_id])).rows;
   const payouts=(await db.query<Payout>(`SELECT p.id,p.trip_id,p.amount_minor,p.method,p.created_at FROM driver_payouts p JOIN trips t ON t.id=p.trip_id WHERE ($1::boolean=false OR t.driver_id=$2::uuid) ORDER BY p.created_at DESC`,[driverOnly,actor.driver_id])).rows;
   const refunds=driverOnly?[]:(await db.query<Refund>(`SELECT r.id,b.trip_id,r.booking_id,r.amount_minor,r.method,r.reason,r.created_at,b.contact_name AS name FROM refunds r JOIN bookings b ON b.id=r.booking_id JOIN clients c ON c.id=b.client_id ORDER BY r.created_at DESC`)).rows;
   return {trips:trips.map(t=>driverOnly?{...t,revenue_minor:null,received_minor:null,refunded_minor:null,expenses_minor:null,cash_minor:null,result_minor:null}:t),expenses,payouts,refunds};
  },
 };
}
export type FinanceTrip={id:string;origin:string;destination:string;currency:string;status:string;driver_id:string|null;driver_name:string|null;revenue_minor:number|null;received_minor:number|null;refunded_minor:number|null;expenses_minor:number|null;driver_expenses_minor:number;fee_minor:number|null;reimbursement_minor:number|null;settlement_note:string|null;approved_at:Date|null;paid_driver_minor:number;cash_minor:number|null;result_minor:number|null};
export type Expense={id:string;trip_id:string;amount_minor:number;category:string;paid_by:string;description:string;voided_at:Date|null;void_reason:string|null;created_at:Date};
export type Payout={id:string;trip_id:string;amount_minor:number;method:string;created_at:Date};
export type Refund={id:string;trip_id:string;booking_id:string;amount_minor:number;method:string;reason:string;created_at:Date;name:string};
export type FinanceReport={trips:FinanceTrip[];expenses:Expense[];payouts:Payout[];refunds:Refund[]};
