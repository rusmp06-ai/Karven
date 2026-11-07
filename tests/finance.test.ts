import { beforeEach, afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { schema, schemaV1, migrationV2, migrationV3 } from '../src/lib/schema';
import { createCrm } from '../src/lib/crm';
import { createFinance } from '../src/lib/finance';
import { createTripOperations } from '../src/lib/trip-operations';
import { createFleet } from '../src/lib/fleet';
import { owner, seedOwner } from './helpers';
import type { Actor } from '../src/lib/access';
let db:PGlite,crm:ReturnType<typeof createCrm>,finance:ReturnType<typeof createFinance>,fleet:ReturnType<typeof createFleet>;
let tripId:string,driverId:string,vehicleId:string,bookingId:string;
const key=()=>randomUUID();
const expense=(amount='100',paidBy='park')=>({tripId,amount,paidBy,category:'fuel',description:'Топливо для рейса',requestId:key()});
const payment=(amount='1000')=>({bookingId,amount,method:'cash',requestId:key()});
const refund=(amount='100')=>({bookingId,amount,method:'cash',reason:'Согласованный возврат',requestId:key()});
const approve=()=>({tripId,fee:'300',note:'Согласовано с водителем',requestId:key()});
async function complete() {
 await db.query("UPDATE trips SET departure_at=now()-interval '2 hours',ends_at=now()+interval '2 hours' WHERE id=$1",[tripId]);
 const bookings=(await crm.dashboard()).bookings.filter(b=>b.trip_id===tripId&&b.status==='confirmed');
 for(const booking of bookings)for(let position=0;position<booking.passenger_count;position++)await createTripOperations(db,owner).attendance({bookingId:booking.id,position,status:'boarded',requestId:key()});
 await finance.completeTrip({tripId,requestId:key()});
}
beforeEach(async()=>{
 db=new PGlite();await db.exec(schema);await seedOwner(db);crm=createCrm(db,owner);finance=createFinance(db,owner);fleet=createFleet(db,owner);
 tripId=await crm.createTrip({origin:'Бишкек',destination:'Каракол',departureAt:new Date(Date.now()+86400000).toISOString(),capacity:4,currency:'KGS'});
 driverId=await fleet.saveDriver({name:'Водитель',phone:'+996555123456',kind:'staff',status:'available',licenseNumber:'AB123',licenseExpires:'2099-01-01'});
 vehicleId=await fleet.saveVehicle({plate:'TEST123',model:'Toyota',capacity:4,ownerName:'Парк',kind:'park',status:'available'});
 await fleet.assign({tripId,driverId,vehicleId,endsAt:new Date(Date.now()+86400000+6*3600000).toISOString()});
 bookingId=await crm.createBooking({tripId,name:'Клиент',phone:'+996555111222',seats:1,total:'1000'});
},30000);
afterEach(async()=>{await db.close();});
it('частичный возврат уменьшает стоимость и оплату, не увеличивая задолженность',async()=>{
 await crm.addPayment(payment('600'));await finance.refund(refund('100'));
 const b=(await crm.dashboard()).bookings[0];
 expect(b).toMatchObject({original_total_minor:100000,total_minor:90000,paid_minor:50000,refunded_minor:10000});
 expect(b.total_minor-b.paid_minor).toBe(40000);
 await expect(crm.addPayment(payment('401'))).rejects.toThrow('превышает');await crm.addPayment(payment('400'));
 expect((await crm.dashboard()).bookings[0].paid_minor).toBe(90000);
});
it('отмена с полным возвратом атомарна, сохраняет историю и освобождает места',async()=>{
 await crm.addPayment(payment());const input={bookingId,reason:'Клиент отменил поездку',method:'transfer',requestId:key()};
 await Promise.all([finance.cancelWithRefund(input),finance.cancelWithRefund(input)]);
 const data=await crm.dashboard();expect(data.trips[0].occupied).toBe(0);expect(data.bookings[0]).toMatchObject({status:'cancelled',paid_minor:0,total_minor:0,refunded_minor:100000});
 expect((await db.query('SELECT * FROM payments')).rows).toHaveLength(1);expect((await db.query('SELECT * FROM refunds')).rows).toHaveLength(1);
 expect((await finance.report()).trips[0]).toMatchObject({revenue_minor:0,received_minor:100000,refunded_minor:100000,cash_minor:0});
});
it('защищает от повторного платежа, возврата и повторного использования ключа',async()=>{
 const p=payment('600');await Promise.all([crm.addPayment(p),crm.addPayment(p)]);
 expect((await db.query('SELECT * FROM payments')).rows).toHaveLength(1);
 await expect(crm.addPayment({...p,amount:'601'})).rejects.toThrow('идентификатор');
 const r=refund('400');await Promise.all([finance.refund(r),finance.refund(r)]);
 expect((await db.query('SELECT * FROM refunds')).rows).toHaveLength(1);
 await expect(finance.refund(refund('201'))).rejects.toThrow('превышает');
 const results=await Promise.allSettled([finance.refund(refund('150')),finance.refund(refund('150'))]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
});
it('не оставляет чек повторной операции после неудачи',async()=>{
 const r=refund('100');await expect(finance.refund(r)).rejects.toThrow('превышает');
 expect((await db.query('SELECT * FROM mutation_receipts WHERE request_id=$1',[r.requestId])).rows).toHaveLength(0);
 await crm.addPayment(payment());await finance.refund(r);
 expect((await db.query('SELECT * FROM refunds')).rows).toHaveLength(1);
});
it('завершает рейс однократно, сохраняет долги и закрывает бронирование/отмену',async()=>{
 await expect(finance.completeTrip({tripId,requestId:key()})).rejects.toThrow('до отправления');
 await complete();await finance.completeTrip({tripId,requestId:key()});
 expect((await db.query("SELECT * FROM audit_events WHERE action='trip.completed'")).rows).toHaveLength(1);
 const data=await crm.dashboard();expect(data.trips[0].status).toBe('completed');expect(data.bookings[0].total_minor-data.bookings[0].paid_minor).toBe(100000);
 await expect(crm.createBooking({tripId,name:'Другой',phone:'+996555333444',seats:1,total:'100'})).rejects.toThrow('закрыто');
 await expect(crm.cancelBooking(bookingId)).rejects.toThrow('завершённого');
 await expect(finance.cancelWithRefund({bookingId,reason:'Отмена после рейса',method:'cash',requestId:key()})).rejects.toThrow('завершённого');
 await crm.addPayment(payment());expect((await crm.dashboard()).bookings[0].paid_minor).toBe(100000);
});
it('для завершения требуется назначение ресурсов',async()=>{
 await db.query("UPDATE trips SET driver_id=NULL,vehicle_id=NULL,departure_at=now()-interval '2 hours' WHERE id=$1",[tripId]);
 await expect(finance.completeTrip({tripId,requestId:key()})).rejects.toThrow('назначьте');
});
it('учитывает расходы парка и водителя, фиксирует расчёт и выплачивает частями',async()=>{
 await crm.addPayment(payment());await finance.addExpense(expense('100','park'));await finance.addExpense(expense('200','driver'));
 await expect(finance.approveSettlement(approve())).rejects.toThrow('завершите');
 await complete();const approval=approve();await finance.approveSettlement(approval);await finance.approveSettlement(approval);
 let t=(await finance.report()).trips[0];expect(t).toMatchObject({revenue_minor:100000,expenses_minor:30000,fee_minor:30000,reimbursement_minor:20000,result_minor:40000,cash_minor:90000});
 const first={tripId,amount:'200',method:'cash',requestId:key()};await Promise.all([finance.payDriver(first),finance.payDriver(first)]);
 await finance.payDriver({tripId,amount:'300',method:'transfer',requestId:key()});
 t=(await finance.report()).trips[0];expect(t.paid_driver_minor).toBe(50000);expect(t.cash_minor).toBe(40000);
 await expect(finance.payDriver({tripId,amount:'0.01',method:'cash',requestId:key()})).rejects.toThrow('превышает');
 await expect(finance.addExpense(expense())).rejects.toThrow('зафиксированы');
 await expect(finance.approveSettlement(approve())).rejects.toThrow('утверждён');
});
it('не допускает переплату водителю при конкурентных запросах',async()=>{
 await complete();await finance.approveSettlement(approve());
 const results=await Promise.allSettled([finance.payDriver({tripId,amount:'200',method:'cash',requestId:key()}),finance.payDriver({tripId,amount:'200',method:'cash',requestId:key()})]);
 expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect((await finance.report()).trips[0].paid_driver_minor).toBe(20000);
});
it('аннулирует расход без удаления и не меняет утверждённые расходы',async()=>{
 const input=expense();await Promise.all([finance.addExpense(input),finance.addExpense(input)]);
 const e=(await finance.report()).expenses[0];expect((await finance.report()).expenses).toHaveLength(1);
 await finance.voidExpense({expenseId:e.id,reason:'Ошибочная запись',requestId:key()});
 expect((await finance.report()).trips[0].expenses_minor).toBe(0);expect((await finance.report()).expenses[0].voided_at).not.toBeNull();
 await finance.addExpense(expense());const other=(await finance.report()).expenses.find(e=>!e.voided_at)!;
 await complete();await finance.approveSettlement(approve());
 await expect(finance.voidExpense({expenseId:other.id,reason:'Попытка изменить',requestId:key()})).rejects.toThrow('зафиксированы');
});
it('нельзя перенести расходы прежнего водителя на нового при замене',async()=>{
 await finance.addExpense(expense('100','driver'));
 const other=await fleet.saveDriver({name:'Другой водитель',phone:'+996555555555',kind:'partner',status:'available',licenseNumber:'AB456',licenseExpires:'2099-01-01'});
 await expect(fleet.assign({tripId,driverId:other,vehicleId,endsAt:new Date(Date.now()+86400000+6*3600000).toISOString()})).rejects.toThrow('прежнего водителя');
});
it('водитель видит только собственный расчёт без финансов парка',async()=>{
 const driver:Actor={...owner,role:'driver',driver_id:driverId};
 await finance.addExpense(expense('100','driver'));await finance.addExpense(expense('50','park'));
 const report=await createFinance(db,driver).report();expect(report.trips).toHaveLength(1);expect(report.expenses).toHaveLength(1);expect(report.trips[0].revenue_minor).toBeNull();expect(report.trips[0].cash_minor).toBeNull();expect(report.refunds).toEqual([]);
 const outsider:Actor={...driver,driver_id:randomUUID()};expect((await createFinance(db,outsider).report()).trips).toHaveLength(0);
 for(const operation of ['completeTrip','refund','cancelWithRefund','addExpense','voidExpense','approveSettlement','payDriver'] as const)await expect(createFinance(db,driver)[operation]({})).rejects.toThrow('прав');
});
it('диспетчер может учитывать расходы, но не возвраты, утверждения и выплаты',async()=>{
 const dispatcher:Actor={...owner,role:'dispatcher'};const f=createFinance(db,dispatcher);
 await f.addExpense(expense());expect((await f.report()).expenses).toHaveLength(1);
 for(const operation of ['refund','cancelWithRefund','voidExpense','approveSettlement','payDriver'] as const)await expect(f[operation]({})).rejects.toThrow('прав');
});
it('после возврата на завершённом рейсе результат уменьшается, расчёт водителя сохраняется',async()=>{
 await crm.addPayment(payment());await complete();await finance.approveSettlement(approve());await finance.refund(refund('100'));
 const t=(await finance.report()).trips[0];expect(t).toMatchObject({revenue_minor:90000,refunded_minor:10000,result_minor:60000,fee_minor:30000});
});
it('миграция 3 сохраняет оплаты и пользователей базы версии 2',async()=>{
 const old=new PGlite();try{
  await old.exec(schemaV1+migrationV2);await seedOwner(old);
  await old.exec(migrationV3);await old.exec(migrationV3);
  expect((await old.query('SELECT * FROM users')).rows).toHaveLength(1);
  expect((await old.query('SELECT * FROM schema_migrations')).rows).toHaveLength(3);
 }finally{await old.close();}
});
