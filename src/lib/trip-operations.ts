import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { type Actor, requireRole, AccessError } from './access';
import { recordAudit, type Tx } from './audit';
import { BusinessError } from './crm';
import { once } from './idempotency';
import { passengerInput } from './orders';
const uuid=z.string().uuid();
const reason=z.string().trim().min(3,'Укажите причину (минимум 3 символа)').max(500);
const requestId=uuid;
type BookingRow={id:string;trip_id:string;status:string;seats:number;booking_type:'seats'|'vehicle';passenger_count:number;passengers:{name:string;phone:string}[];child_seats:number};
type TripRow={id:string;status:string;departure_at:Date;capacity:number;currency:string;origin:string;destination:string;driver_id:string|null};
async function bookingLock(tx:Tx,id:string) {
 const booking=(await tx.query<BookingRow>('SELECT * FROM bookings WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!booking||booking.status!=='confirmed')throw new BusinessError('Активная бронь не найдена');
 return booking;
}
async function tripLock(tx:Tx,id:string) {
 const trip=(await tx.query<TripRow>('SELECT * FROM trips WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!trip)throw new BusinessError('Рейс не найден');return trip;
}
async function requireUnmarked(tx:Tx,id:string) {
 if((await tx.query('SELECT position FROM passenger_attendance WHERE booking_id=$1 LIMIT 1',[id])).rows.length)throw new BusinessError('Сначала исправьте отметки посадки или неявки: заказ уже обработан');
}
function requireFuture(trip:TripRow) {
 if(trip.status!=='scheduled'||new Date(trip.departure_at).getTime()<=Date.now())throw new BusinessError('Операция доступна только до отправления запланированного рейса');
}
export function createTripOperations(db:PGlite,actor:Actor) {
 return {
  async transfer(raw:unknown) {
   requireRole(actor,'owner','dispatcher');
   const input=z.object({bookingId:uuid,targetTripId:uuid,reason,requestId}).parse(raw);
   await db.transaction(tx=>once(tx,actor,input.requestId,'booking.transfer',input,async()=>{
    const booking=await bookingLock(tx,input.bookingId);
    if(booking.trip_id===input.targetTripId)throw new BusinessError('Выберите другой рейс');
    const ordered=[booking.trip_id,input.targetTripId].sort();
    const locks=new Map<string,TripRow>();for(const id of ordered)locks.set(id,await tripLock(tx,id));
    const source=locks.get(booking.trip_id)!,target=locks.get(input.targetTripId)!;
    requireFuture(source);requireFuture(target);await requireUnmarked(tx,input.bookingId);
    if(source.currency!==target.currency)throw new BusinessError('Перенос возможен только в той же валюте');
    if(source.origin.trim().toLowerCase()!==target.origin.trim().toLowerCase()||source.destination.trim().toLowerCase()!==target.destination.trim().toLowerCase())throw new BusinessError('Выберите рейс того же направления');
    const used=(await tx.query<{used:number}>("SELECT COALESCE(SUM(seats),0)::integer AS used FROM bookings WHERE trip_id=$1 AND status='confirmed'",[target.id])).rows[0].used;
    const seats=booking.booking_type==='vehicle'?target.capacity:booking.passenger_count;
    if(booking.passenger_count>target.capacity||used+seats>target.capacity)throw new BusinessError('В целевом рейсе недостаточно свободных мест');
    await tx.query('UPDATE bookings SET trip_id=$2,seats=$3 WHERE id=$1',[input.bookingId,target.id,seats]);
    await recordAudit(tx,actor,input.bookingId,'booking.transferred',{fromTripId:source.id,toTripId:target.id,fromDeparture:new Date(source.departure_at).toISOString(),toDeparture:new Date(target.departure_at).toISOString(),reason:input.reason});
   }));
  },
  async resize(raw:unknown) {
   requireRole(actor,'owner','dispatcher');
   const input=z.object({bookingId:uuid,count:z.coerce.number().int().min(1).max(60),passengers:z.array(passengerInput).min(1).max(60),childSeats:z.coerce.number().int().min(0).max(60),reason,requestId}).parse(raw);
   if(input.passengers.length!==input.count)throw new BusinessError('Укажите данные каждого пассажира');
   if(input.childSeats>input.count)throw new BusinessError('Детских кресел не может быть больше пассажиров');
   await db.transaction(tx=>once(tx,actor,input.requestId,'booking.resize',input,async()=>{
    const booking=await bookingLock(tx,input.bookingId),trip=await tripLock(tx,booking.trip_id);requireFuture(trip);await requireUnmarked(tx,input.bookingId);
    const used=(await tx.query<{used:number}>("SELECT COALESCE(SUM(seats),0)::integer AS used FROM bookings WHERE trip_id=$1 AND id<>$2 AND status='confirmed'",[trip.id,input.bookingId])).rows[0].used;
    const seats=booking.booking_type==='vehicle'?trip.capacity:input.count;
    if(input.count>trip.capacity||used+seats>trip.capacity)throw new BusinessError('Недостаточно свободных мест');
    await tx.query('UPDATE bookings SET passenger_count=$2,seats=$3,passengers=$4,child_seats=$5 WHERE id=$1',[input.bookingId,input.count,seats,JSON.stringify(input.passengers),input.childSeats]);
    await recordAudit(tx,actor,input.bookingId,'booking.resized',{before:booking.passenger_count,after:input.count,reason:input.reason,priceUnchanged:true});
   }));
  },
  async attendance(raw:unknown) {
   requireRole(actor,'owner','dispatcher','driver');
   const input=z.object({bookingId:uuid,position:z.coerce.number().int().min(0).max(59),status:z.enum(['boarded','no_show','pending']),reason:z.string().trim().max(500).default(''),requestId}).parse(raw);
   await db.transaction(tx=>once(tx,actor,input.requestId,'passenger.attendance',input,async()=>{
    const booking=await bookingLock(tx,input.bookingId),trip=await tripLock(tx,booking.trip_id);
    if(actor.role==='driver'&&actor.driver_id!==trip.driver_id)throw new AccessError();
    if(trip.status!=='scheduled')throw new BusinessError('Рейс закрыт для отметок');
    if(input.position>=booking.passenger_count)throw new BusinessError('Пассажир не найден');
    if(!booking.passengers[input.position]?.name)throw new BusinessError('Сначала заполните имя пассажира в карточке заказа');
    const existing=(await tx.query<{status:string}>('SELECT status FROM passenger_attendance WHERE booking_id=$1 AND position=$2',[input.bookingId,input.position])).rows[0];
    if(existing?.status===input.status)return;
    if(existing||input.status==='pending') {
     requireRole(actor,'owner','dispatcher');
     if(input.reason.length<3)throw new BusinessError('Укажите причину исправления отметки');
    }
    const departure=new Date(trip.departure_at).getTime();
    if(input.status==='boarded'&&Date.now()<departure-2*3600000)throw new BusinessError('Посадку можно отмечать за 2 часа до отправления');
    if(input.status==='no_show'&&Date.now()<departure)throw new BusinessError('Неявку можно отметить только после времени отправления');
    if(input.status==='pending')await tx.query('DELETE FROM passenger_attendance WHERE booking_id=$1 AND position=$2',[input.bookingId,input.position]);
    else await tx.query('INSERT INTO passenger_attendance(booking_id,position,status,changed_by) VALUES($1,$2,$3,$4) ON CONFLICT(booking_id,position) DO UPDATE SET status=EXCLUDED.status,changed_by=EXCLUDED.changed_by,changed_at=now()',[input.bookingId,input.position,input.status,actor.id]);
    await recordAudit(tx,actor,input.bookingId,'passenger.attendance',{position:input.position,before:existing?.status??'pending',after:input.status,reason:input.reason});
   }));
  },
  async cancelTrip(raw:unknown) {
   requireRole(actor,'owner','dispatcher');
   const input=z.object({tripId:uuid,reason,method:z.enum(['cash','transfer','card']),confirmed:z.literal('yes'),requestId}).parse(raw);
   await db.transaction(tx=>once(tx,actor,input.requestId,'trip.cancel',input,async()=>{
    const trip=await tripLock(tx,input.tripId);
    if(trip.status==='cancelled')return;
    if(trip.status!=='scheduled')throw new BusinessError('Завершённый рейс отменять нельзя');
    if((await tx.query("SELECT a.booking_id FROM passenger_attendance a JOIN bookings b ON b.id=a.booking_id WHERE b.trip_id=$1 AND b.status='confirmed' LIMIT 1",[input.tripId])).rows.length)throw new BusinessError('В рейсе есть отметки пассажиров. Диспетчер должен сначала проверить и исправить их.');
    const bookings=(await tx.query<{id:string;net:number}>(`SELECT b.id,((SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE booking_id=b.id)-(SELECT COALESCE(SUM(amount_minor),0) FROM refunds WHERE booking_id=b.id))::integer AS net FROM bookings b WHERE b.trip_id=$1 AND b.status='confirmed' ORDER BY b.id FOR UPDATE`,[input.tripId])).rows;
    if(bookings.some(b=>b.net>0))requireRole(actor,'owner');
    for(const booking of bookings) {
     if(booking.net>0) {
      await tx.query('INSERT INTO refunds(id,booking_id,amount_minor,method,reason,created_by) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),booking.id,booking.net,input.method,input.reason,actor.id]);
      await recordAudit(tx,actor,booking.id,'booking.refunded',{amountMinor:booking.net,method:input.method,reason:input.reason,tripCancellation:true});
     }
     await tx.query("UPDATE bookings SET status='cancelled' WHERE id=$1",[booking.id]);
     await recordAudit(tx,actor,booking.id,'booking.cancelled',{refundMinor:booking.net,reason:input.reason,tripCancellation:true});
    }
    await tx.query("UPDATE trips SET status='cancelled',cancelled_at=now(),cancel_reason=$2 WHERE id=$1",[input.tripId,input.reason]);
    await recordAudit(tx,actor,input.tripId,'trip.cancelled',{reason:input.reason,bookingCount:bookings.length,refundMinor:bookings.reduce((sum,b)=>sum+b.net,0),method:input.method});
   }));
  },
 };
}
