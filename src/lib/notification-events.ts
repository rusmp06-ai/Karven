import {randomUUID} from 'node:crypto';
import type {DbTransaction} from './database-types';
export type EventKind='booking.cancelled'|'booking.refunded'|'trip.cancelled'|'report.document';
export async function queueNotification(tx:DbTransaction,eventKey:string,kind:EventKind,entityId:string,payload:object){
 let frozen=payload;if(kind.startsWith('booking.')){const row=(await tx.query<Record<string,unknown>>(`SELECT b.contact_name AS name,b.contact_phone AS phone,t.origin||' → '||t.destination AS route,t.currency,t.departure_at AS "departureAt" FROM bookings b JOIN trips t ON t.id=b.trip_id WHERE b.id=$1`,[entityId])).rows[0];frozen={...row,...payload};}
 if(kind==='trip.cancelled'){const row=(await tx.query<Record<string,unknown>>(`SELECT origin||' → '||destination AS route,currency,departure_at AS "departureAt" FROM trips WHERE id=$1`,[entityId])).rows[0];frozen={...row,...payload};}
 await tx.query(`INSERT INTO telegram_events(id,event_key,kind,entity_id,settings_version,payload) SELECT $1,$2,$3,$4,s.version,$5::jsonb FROM telegram_settings s WHERE s.id=1 AND s.enabled AND s.encrypted_token IS NOT NULL AND s.chat_id<>'' ON CONFLICT(event_key) DO NOTHING`,[randomUUID(),eventKey,kind,entityId,JSON.stringify(frozen)]);
}
