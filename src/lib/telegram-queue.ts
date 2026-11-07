import type {Tx} from './audit';
export async function queueBookingTelegram(tx:Tx,bookingId:string){
 await tx.query(`INSERT INTO telegram_outbox(booking_id,settings_version,payload)
 SELECT b.id,s.version,jsonb_build_object('name',b.contact_name,'phone',b.contact_phone,'origin',t.origin,'destination',t.destination,'departure_at',t.departure_at,'passenger_count',b.passenger_count,'booking_type',b.booking_type,'total',b.total_minor,'paid',(SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE booking_id=b.id),'currency',t.currency)
 FROM bookings b JOIN trips t ON t.id=b.trip_id CROSS JOIN telegram_settings s
 WHERE b.id=$1 AND s.id=1 AND s.enabled AND s.encrypted_token IS NOT NULL AND s.chat_id<>'' ON CONFLICT(booking_id) DO NOTHING`,[bookingId]);
}
