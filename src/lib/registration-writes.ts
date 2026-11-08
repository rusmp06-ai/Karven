import {randomUUID} from 'node:crypto';
import type {z} from 'zod';
import type {Actor} from './access';
import type {Tx} from './audit';
import type {bookingInput,tripInput} from './crm';

export async function insertTrip(tx:Tx,actor:Actor,id:string,input:z.infer<typeof tripInput>,endsAt:string){
 await tx.query(`WITH created AS (
  INSERT INTO trips(id,origin,destination,departure_at,capacity,currency,ends_at,create_request_id)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
 ) INSERT INTO audit_events(id,entity_id,action,details,actor_id)
 SELECT $9,id,'trip.created',$10::jsonb,$11 FROM created`,[
  id,input.origin,input.destination,input.departureAt,input.capacity,input.currency,endsAt,input.requestId,randomUUID(),JSON.stringify(input),actor.id,
 ]);
}

export async function insertBooking(tx:Tx,actor:Actor,id:string,input:z.infer<typeof bookingInput>,reservedSeats:number,total:number,initialPayment:number){
 // Data-modifying CTEs share a snapshot: use RETURNING rows for the new booking
 // and the validated initial amount for Telegram, rather than rescanning tables.
 await tx.query(`WITH saved_client AS (
  INSERT INTO clients(id,name,phone) VALUES($3,$4,$5)
  ON CONFLICT(phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id
 ), saved_booking AS (
  INSERT INTO bookings(id,trip_id,client_id,seats,total_minor,note,booking_type,passenger_count,passengers,contact_name,contact_phone,pickup_address,dropoff_address,luggage,child_seats,source,create_request_id)
  SELECT $1,$2,c.id,$6,$7,$8,$9,$10,$11::jsonb,$4,$5,$12,$13,$14,$15,$16,$17 FROM saved_client c RETURNING *
 ), saved_payment AS (
  INSERT INTO payments(id,booking_id,amount_minor,method)
  SELECT $22,b.id,$18::integer,$19 FROM saved_booking b WHERE $18::integer>0 RETURNING booking_id,amount_minor
 ), booking_audit AS (
  INSERT INTO audit_events(id,entity_id,action,details,actor_id)
  SELECT $21,b.id,'booking.created',jsonb_build_object('tripId',b.trip_id,'seats',b.seats,'passengerCount',b.passenger_count,'bookingType',b.booking_type,'totalMinor',b.total_minor),$20 FROM saved_booking b
 ), payment_audit AS (
  INSERT INTO audit_events(id,entity_id,action,details,actor_id)
  SELECT $23,p.booking_id,'payment.recorded',jsonb_build_object('amountMinor',p.amount_minor,'method',$19::text,'initialPayment',true),$20 FROM saved_payment p
 ), queued AS (
  INSERT INTO telegram_outbox(booking_id,settings_version,payload)
  SELECT b.id,s.version,jsonb_build_object('name',b.contact_name,'phone',b.contact_phone,'origin',t.origin,'destination',t.destination,'departure_at',t.departure_at,'passenger_count',b.passenger_count,'booking_type',b.booking_type,'total',b.total_minor,'paid',$18::integer,'currency',t.currency)
  FROM saved_booking b JOIN trips t ON t.id=b.trip_id CROSS JOIN telegram_settings s
  WHERE s.id=1 AND s.enabled AND s.encrypted_token IS NOT NULL AND s.chat_id<>'' ON CONFLICT(booking_id) DO NOTHING
 ) SELECT id FROM saved_booking`,[
  id,input.tripId,randomUUID(),input.name,input.phone,reservedSeats,total,input.note,input.bookingType,input.seats,
  JSON.stringify(input.passengers??[{name:input.name,phone:input.phone}]),input.pickupAddress,input.dropoffAddress,input.luggage,input.childSeats,input.source,input.requestId,
  initialPayment,input.initialPaymentMethod,actor.id,randomUUID(),randomUUID(),randomUUID(),
 ]);
}
