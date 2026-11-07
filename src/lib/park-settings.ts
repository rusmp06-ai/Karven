import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PGlite} from '@electric-sql/pglite';
import {requireRole,type Actor} from './access';
import {BusinessError,toMinor} from './crm';
import {once} from './idempotency';
import {recordAudit} from './audit';
import {parkCurrencies,type ParkSettings,type RouteTemplate,type ParkConfig} from './park-config';
const settingsId='00000000-0000-4000-8000-000000000008';
const text=z.string().trim().min(1).max(120).transform(s=>s.replace(/\s+/g,' '));
const price=z.string().default('').transform(v=>v===''?null:toMinor(v));
export function createParkSettings(db:PGlite,actor:Actor){return {
 async list():Promise<ParkConfig>{
  requireRole(actor,'owner','dispatcher','driver');
  const park=(await db.query<ParkSettings>('SELECT name,default_currency,version FROM park_settings WHERE id=$1',[settingsId])).rows[0];
  const routes=actor.role==='driver'?[]:(await db.query<RouteTemplate>('SELECT id,origin,destination,currency,capacity,duration_minutes,seat_minor,vehicle_minor,active,version FROM route_templates WHERE ($1::boolean OR active) ORDER BY origin,destination,currency,id',[actor.role==='owner'])).rows;
  return {park,routes};
 },
 async savePark(raw:unknown){
  requireRole(actor,'owner');const input=z.object({name:z.string().trim().min(1).max(80),defaultCurrency:z.enum(parkCurrencies),version:z.coerce.number().int().min(1),requestId:z.uuid()}).parse(raw);
  await db.transaction(tx=>once(tx,actor,input.requestId,'park.settings',input,async()=>{
   const current=(await tx.query<{version:number}>('SELECT version FROM park_settings WHERE id=$1 FOR UPDATE',[settingsId])).rows[0];
   if(current.version!==input.version)throw new BusinessError('Настройки уже изменены. Обновите страницу.');
   await tx.query('UPDATE park_settings SET name=$2,default_currency=$3,version=version+1 WHERE id=$1',[settingsId,input.name,input.defaultCurrency]);
   await recordAudit(tx,actor,settingsId,'park.updated',{name:input.name,defaultCurrency:input.defaultCurrency});
  }));
 },
 async saveRoute(raw:unknown){
  requireRole(actor,'owner');const input=z.object({id:z.union([z.uuid(),z.literal('')]).default(''),version:z.coerce.number().int().min(1).default(1),origin:text,destination:text,currency:z.enum(parkCurrencies),capacity:z.coerce.number().int().min(1).max(60),durationMinutes:z.coerce.number().int().min(15).max(10080),seatPrice:price,vehiclePrice:price,active:z.enum(['true','false']).default('true'),requestId:z.uuid()}).parse(raw);
  if(input.origin.toLowerCase()===input.destination.toLowerCase())throw new BusinessError('Пункты отправления и назначения должны отличаться');
  await db.transaction(tx=>once(tx,actor,input.requestId,'route.save',input,async()=>{
   const duplicate=(await tx.query('SELECT id FROM route_templates WHERE lower(origin)=lower($1) AND lower(destination)=lower($2) AND currency=$3 AND ($4::uuid IS NULL OR id<>$4::uuid)',[input.origin,input.destination,input.currency,input.id||null])).rows;
   if(duplicate.length)throw new BusinessError('Маршрут в этой валюте уже есть, включая архив. Измените существующий шаблон.');
   const id=input.id||randomUUID();
   if(input.id){
    const current=(await tx.query<{version:number}>('SELECT version FROM route_templates WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!current)throw new BusinessError('Шаблон маршрута не найден');
    if(current.version!==input.version)throw new BusinessError('Маршрут уже изменён. Обновите страницу.');
    await tx.query('UPDATE route_templates SET origin=$2,destination=$3,currency=$4,capacity=$5,duration_minutes=$6,seat_minor=$7,vehicle_minor=$8,active=$9,version=version+1 WHERE id=$1',[id,input.origin,input.destination,input.currency,input.capacity,input.durationMinutes,input.seatPrice,input.vehiclePrice,input.active==='true']);
   }else await tx.query('INSERT INTO route_templates(id,origin,destination,currency,capacity,duration_minutes,seat_minor,vehicle_minor,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,input.origin,input.destination,input.currency,input.capacity,input.durationMinutes,input.seatPrice,input.vehiclePrice,input.active==='true']);
   await recordAudit(tx,actor,id,input.id?'route.updated':'route.created',{origin:input.origin,destination:input.destination,currency:input.currency,seatMinor:input.seatPrice,vehicleMinor:input.vehiclePrice,active:input.active==='true'});
  }));
 },
};}
