import {queueBookingTelegram} from './telegram-queue';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { type Actor, requireRole } from './access';
import { recordAudit, type Tx } from './audit';
import { once } from './idempotency';
import { detailsInput, type Passenger } from './orders';

export class BusinessError extends Error {}
const text = z.string().trim().min(1).max(120);
const uuid = z.string().uuid();
const money = z.string().regex(/^\d{1,7}(\.\d{1,2})?$/, 'Введите сумму с точностью до двух знаков');
export function toMinor(value: string): number {
  money.parse(value);
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export const tripInput = z.object({
  origin: text, destination: text, departureAt: z.iso.datetime({ offset: true }),
  capacity: z.coerce.number().int().min(1).max(60), currency: z.string().regex(/^[A-Z]{3}$/),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  requestId: uuid.default(()=>randomUUID()),
});
export const bookingInput = detailsInput.extend({
  tripId: uuid, seats: z.coerce.number().int().min(1).max(60), total: money,
  bookingType:z.enum(['seats','vehicle']).default('seats'),
  note: z.string().trim().max(1000).default(''),
  initialPayment:money.default('0'),initialPaymentMethod:z.enum(['cash','transfer','card']).default('cash'),
  requestId:uuid.default(()=>randomUUID()),
});
export const paymentInput = z.object({ bookingId: uuid, amount: money, method: z.enum(['cash', 'transfer', 'card']), requestId: z.string().uuid().default(()=>randomUUID()) });

export function createCrm(db: PGlite, actor:Actor) {
  async function audit(tx:Tx,id:string,action:string,details:object) {
    await recordAudit(tx,actor,id,action,details);
  }
  return {
    async createTrip(raw: unknown) {
      requireRole(actor,'owner','dispatcher');
      const input = tripInput.parse(raw);
      if (input.origin.toLowerCase() === input.destination.toLowerCase()) throw new BusinessError('Пункты отправления и назначения должны отличаться');
      const endsAt = input.endsAt ?? new Date(new Date(input.departureAt).getTime()+6*3600000).toISOString();
      if(new Date(endsAt)<=new Date(input.departureAt))throw new BusinessError('Окончание должно быть позже отправления');
      const id = randomUUID();
      return db.transaction(async tx => {
        await once(tx,actor,input.requestId,'trip.create',input,async()=>{
          if (new Date(input.departureAt).getTime() <= Date.now()) throw new BusinessError('Дата отправления должна быть в будущем');
          await tx.query('INSERT INTO trips(id,origin,destination,departure_at,capacity,currency,ends_at,create_request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id,input.origin,input.destination,input.departureAt,input.capacity,input.currency,endsAt,input.requestId]);
          await audit(tx,id,'trip.created',input);
        });
        return (await tx.query<{id:string}>('SELECT id FROM trips WHERE create_request_id=$1',[input.requestId])).rows[0].id;
      });
    },
    async createBooking(raw: unknown) {
      requireRole(actor,'owner','dispatcher');
      const input = bookingInput.parse(raw);
      const phone = input.phone;
      if (phone.length < 7 || phone.length > 15) throw new BusinessError('Проверьте номер телефона');
      const id = randomUUID();
      const initialPayment=toMinor(input.initialPayment);
      if(initialPayment>toMinor(input.total))throw new BusinessError('Предоплата превышает стоимость заказа');
      return db.transaction(async tx => {
        await once(tx,actor,input.requestId,'booking.create',input,async()=>{
        const { rows: trips } = await tx.query<{capacity:number; status:string; departure_at:Date}>('SELECT * FROM trips WHERE id=$1 FOR UPDATE', [input.tripId]);
        const trip = trips[0];
        if (!trip) throw new BusinessError('Рейс не найден');
        if (trip.status !== 'scheduled' || new Date(trip.departure_at).getTime() <= Date.now()) throw new BusinessError('Бронирование этого рейса закрыто');
        const { rows } = await tx.query<{used:number}>("SELECT COALESCE(SUM(seats),0)::integer AS used FROM bookings WHERE trip_id=$1 AND status='confirmed'",[input.tripId]);
        const reservedSeats=input.bookingType==='vehicle'?trip.capacity:input.seats;
        if(input.childSeats>input.seats)throw new BusinessError('Детских кресел не может быть больше пассажиров');
        if(input.passengers && input.passengers.length!==input.seats)throw new BusinessError('Укажите данные каждого пассажира');
        if(input.seats>trip.capacity)throw new BusinessError('Число пассажиров превышает вместимость рейса');
        if (rows[0].used + reservedSeats > trip.capacity) throw new BusinessError('Недостаточно свободных мест');
        const {rows: clients} = await tx.query<{id:string}>('INSERT INTO clients(id,name,phone) VALUES ($1,$2,$3) ON CONFLICT(phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id',[randomUUID(),input.name,phone]);
        await tx.query('INSERT INTO bookings(id,trip_id,client_id,seats,total_minor,note,booking_type,passenger_count,passengers,contact_name,contact_phone,pickup_address,dropoff_address,luggage,child_seats,source,create_request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',[id,input.tripId,clients[0].id,reservedSeats,toMinor(input.total),input.note,input.bookingType,input.seats,JSON.stringify(input.passengers??[{name:input.name,phone}]),input.name,phone,input.pickupAddress,input.dropoffAddress,input.luggage,input.childSeats,input.source,input.requestId]);
        await audit(tx,id,'booking.created',{tripId:input.tripId,seats:reservedSeats,passengerCount:input.seats,bookingType:input.bookingType,totalMinor:toMinor(input.total)});
        if(initialPayment>0){
          await tx.query('INSERT INTO payments(id,booking_id,amount_minor,method) VALUES($1,$2,$3,$4)',[randomUUID(),id,initialPayment,input.initialPaymentMethod]);
          await audit(tx,id,'payment.recorded',{amountMinor:initialPayment,method:input.initialPaymentMethod,initialPayment:true});
        }
        await queueBookingTelegram(tx,id);
        });
        return (await tx.query<{id:string}>('SELECT id FROM bookings WHERE create_request_id=$1',[input.requestId])).rows[0].id;
      });
    },
    async updateBookingDetails(raw:unknown) {
      requireRole(actor,'owner','dispatcher');
      const input=detailsInput.extend({bookingId:uuid,note:z.string().trim().max(1000).default('')}).parse(raw);
      await db.transaction(async tx=>{
        const booking=(await tx.query<{trip_id:string;status:string;passenger_count:number}>('SELECT trip_id,status,passenger_count FROM bookings WHERE id=$1 FOR UPDATE',[input.bookingId])).rows[0];
        if(!booking||booking.status!=='confirmed')throw new BusinessError('Активная бронь не найдена');
        const trip=(await tx.query<{status:string}>('SELECT status FROM trips WHERE id=$1 FOR UPDATE',[booking.trip_id])).rows[0];
        if(trip.status!=='scheduled')throw new BusinessError('Карточка завершённого рейса закрыта для изменения');
        if((await tx.query('SELECT position FROM passenger_attendance WHERE booking_id=$1 LIMIT 1',[input.bookingId])).rows.length)throw new BusinessError('Сначала исправьте отметки пассажиров перед изменением карточки');
        if(!input.passengers||input.passengers.length!==booking.passenger_count)throw new BusinessError('Укажите данные каждого пассажира');
        if(input.childSeats>booking.passenger_count)throw new BusinessError('Детских кресел не может быть больше пассажиров');
        await tx.query('UPDATE bookings SET contact_name=$2,contact_phone=$3,pickup_address=$4,dropoff_address=$5,luggage=$6,child_seats=$7,source=$8,passengers=$9,note=$10 WHERE id=$1',[input.bookingId,input.name,input.phone,input.pickupAddress,input.dropoffAddress,input.luggage,input.childSeats,input.source,JSON.stringify(input.passengers),input.note]);
        await audit(tx,input.bookingId,'booking.details_updated',{});
      });
    },
    async addPayment(raw: unknown) {
      requireRole(actor,'owner','dispatcher');
      const input = paymentInput.parse(raw);
      const amount = toMinor(input.amount);
      if (amount <= 0) throw new BusinessError('Сумма должна быть больше нуля');
      await db.transaction(tx => once(tx,actor,input.requestId,'payment.add',input,async()=>{
        const {rows} = await tx.query<{total_minor:number; status:string}>('SELECT * FROM bookings WHERE id=$1 FOR UPDATE',[input.bookingId]);
        const booking = rows[0];
        if (!booking || booking.status !== 'confirmed') throw new BusinessError('Активная бронь не найдена');
        const {rows: paid} = await tx.query<{amount:number}>('SELECT ((SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE booking_id=$1)-(SELECT COALESCE(SUM(amount_minor),0) FROM refunds WHERE booking_id=$1))::integer AS amount',[input.bookingId]);
        const refunded=Number((await tx.query<{amount:string}>('SELECT COALESCE(SUM(amount_minor),0) AS amount FROM refunds WHERE booking_id=$1',[input.bookingId])).rows[0].amount);
        if (paid[0].amount + amount > booking.total_minor-refunded) throw new BusinessError('Оплата превышает остаток по брони');
        await tx.query('INSERT INTO payments(id,booking_id,amount_minor,method) VALUES ($1,$2,$3,$4)',[randomUUID(),input.bookingId,amount,input.method]);
        await audit(tx,input.bookingId,'payment.recorded',{amountMinor:amount,method:input.method});
      }));
    },
    async cancelBooking(id: string) {
      requireRole(actor,'owner','dispatcher');
      uuid.parse(id);
      await db.transaction(async tx => {
        const {rows} = await tx.query<{status:string;trip_id:string}>('SELECT status,trip_id FROM bookings WHERE id=$1 FOR UPDATE',[id]);
        if (!rows[0]) throw new BusinessError('Бронь не найдена');
        if (rows[0].status === 'cancelled') return;
        const trip=(await tx.query<{status:string}>('SELECT status FROM trips WHERE id=$1 FOR UPDATE',[rows[0].trip_id])).rows[0];
        if(trip.status==='completed')throw new BusinessError('Нельзя отменить бронь завершённого рейса');
        if((await tx.query('SELECT position FROM passenger_attendance WHERE booking_id=$1 LIMIT 1',[id])).rows.length)throw new BusinessError('Сначала исправьте отметки пассажиров перед отменой');
        const {rows: paid} = await tx.query<{amount:number}>('SELECT ((SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE booking_id=$1)-(SELECT COALESCE(SUM(amount_minor),0) FROM refunds WHERE booking_id=$1))::integer AS amount',[id]);
        if (paid[0].amount > 0) throw new BusinessError('У брони есть оплаты. Для отмены требуется оформление возврата');
        await tx.query("UPDATE bookings SET status='cancelled' WHERE id=$1",[id]);
        await audit(tx,id,'booking.cancelled',{});
      });
    },
    async dashboard() {
      requireRole(actor,'owner','dispatcher','driver');
      const driverOnly=actor.role==='driver';
      const {rows: trips} = await db.query<Trip>(`SELECT t.*,d.name AS driver_name,v.plate AS vehicle_plate,v.model AS vehicle_model,COALESCE(SUM(b.seats) FILTER (WHERE b.status='confirmed'),0)::integer AS occupied FROM trips t LEFT JOIN drivers d ON d.id=t.driver_id LEFT JOIN vehicles v ON v.id=t.vehicle_id LEFT JOIN bookings b ON b.trip_id=t.id WHERE ($1::boolean=false OR t.driver_id=$2::uuid) GROUP BY t.id,d.name,v.plate,v.model ORDER BY departure_at`,[driverOnly,actor.driver_id]);
      const {rows: bookings} = await db.query<Booking>(`SELECT b.id,b.client_id,b.trip_id,b.seats,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('position',a.position,'status',a.status) ORDER BY a.position) FROM passenger_attendance a WHERE a.booking_id=b.id),'[]'::jsonb) AS attendance,
      CASE WHEN $1::boolean THEN '[]'::jsonb ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object('action',h.action,'at',h.created_at,'actor',u.name,'details',h.details) ORDER BY h.created_at DESC) FROM (SELECT * FROM audit_events WHERE entity_id=b.id ORDER BY created_at DESC,id DESC LIMIT 30) h LEFT JOIN users u ON u.id=h.actor_id),'[]'::jsonb) END AS history,b.booking_type,b.passenger_count,b.passengers,b.pickup_address,b.dropoff_address,b.luggage,b.child_seats,CASE WHEN $1::boolean THEN '' ELSE b.source END AS source,t.departure_at,t.status AS trip_status,b.total_minor AS original_total_minor,CASE WHEN b.status='cancelled' THEN 0 ELSE b.total_minor-COALESCE(r.refunded_minor,0)::integer END AS total_minor,COALESCE(r.refunded_minor,0)::integer AS refunded_minor,b.status,CASE WHEN $1::boolean THEN '' ELSE b.note END AS note,b.contact_name AS name,b.contact_phone AS phone,t.currency,t.origin,t.destination,(COALESCE(p.paid_minor,0)-COALESCE(r.refunded_minor,0))::integer AS paid_minor FROM bookings b JOIN clients c ON c.id=b.client_id JOIN trips t ON t.id=b.trip_id LEFT JOIN (SELECT booking_id,SUM(amount_minor) AS paid_minor FROM payments GROUP BY booking_id) p ON p.booking_id=b.id LEFT JOIN (SELECT booking_id,SUM(amount_minor) AS refunded_minor FROM refunds GROUP BY booking_id) r ON r.booking_id=b.id WHERE ($1::boolean=false OR (t.driver_id=$2::uuid AND b.status='confirmed')) ORDER BY b.created_at DESC`,[driverOnly,actor.driver_id]);
      return {trips,bookings};
    },
  };
}
export type Trip = {id:string;origin:string;destination:string;departure_at:Date;capacity:number;occupied:number;currency:string;status:string;ends_at:Date;driver_id:string|null;vehicle_id:string|null;driver_name:string|null;vehicle_plate:string|null;vehicle_model:string|null;completed_at:Date|null;cancelled_at:Date|null;cancel_reason:string|null};
export type Booking = {id:string;client_id?:string;trip_id:string;name:string;phone:string;seats:number;total_minor:number;original_total_minor:number;refunded_minor:number;paid_minor:number;currency:string;status:string;origin:string;destination:string;note:string;booking_type:'seats'|'vehicle';passenger_count:number;passengers:Passenger[];pickup_address:string;dropoff_address:string;luggage:string;child_seats:number;source:string;departure_at:Date;trip_status:string;attendance:{position:number;status:'boarded'|'no_show'}[];history:{action:string;at:string;actor:string|null;details:Record<string,unknown>}[]};
