import { beforeEach, afterEach, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { schema, schemaV1, migrationV2 } from '../src/lib/schema';
import { createCrm } from '../src/lib/crm';
import { createFleet } from '../src/lib/fleet';
import { createAuth, hashPassword, verifyPassword } from '../src/lib/auth';
import type { Actor } from '../src/lib/access';
import { owner, seedOwner } from './helpers';
let db:PGlite;
let fleet:ReturnType<typeof createFleet>;
let auth:ReturnType<typeof createAuth>;
let crm:ReturnType<typeof createCrm>;
const password='test-password-1234';
const start=new Date(Date.now()+86400000*3);
const date=(hours:number)=>new Date(start.getTime()+hours*3600000).toISOString();
const driverData={name:'Водитель',phone:'+996555123456',kind:'staff',status:'available',licenseNumber:'LICENSE-1',licenseExpires:'2099-12-31'};
const vehicleData={plate:'01 KG 123 ABC',model:'Toyota',capacity:4,ownerName:'Парк',kind:'park',status:'available'};
async function trip(hours=0,capacity=4) {return crm.createTrip({origin:'Бишкек',destination:'Каракол',departureAt:date(hours),endsAt:date(hours+4),capacity,currency:'KGS'});}
async function resources() {return {driverId:await fleet.saveDriver(driverData),vehicleId:await fleet.saveVehicle(vehicleData)};}
async function user(role:'dispatcher'|'driver',driverId?:string) {
 const id=await auth.createUser(owner,{username:role,name:role,password,role,driverId});
 return {id,name:role,username:role,role,driver_id:driverId??null} as Actor;
}
beforeEach(async()=>{db=new PGlite();await db.exec(schema);await seedOwner(db);fleet=createFleet(db,owner);auth=createAuth(db);crm=createCrm(db,owner);},30000);
afterEach(async()=>{await db.close();});
it('назначает ресурсы и синхронизирует вместимость с машиной',async()=>{
 const r=await resources(),id=await trip(0,10);
 await fleet.assign({...r,tripId:id,endsAt:date(4)});
 expect((await crm.dashboard()).trips[0]).toMatchObject({driver_id:r.driverId,vehicle_id:r.vehicleId,capacity:4,driver_name:'Водитель'});
 const audit=(await db.query<{actor_id:string}>("SELECT actor_id FROM audit_events WHERE action='trip.assigned'")).rows;
 expect(audit[0].actor_id).toBe(owner.id);
});
it('запрещает пересечение водителя и машины, разрешает соседние рейсы',async()=>{
 const r=await resources(),a=await trip(),b=await trip(2),c=await trip(4);
 await fleet.assign({...r,tripId:a,endsAt:date(4)});
 const otherVehicle=await fleet.saveVehicle({...vehicleData,plate:'OTHER'});
 const otherDriver=await fleet.saveDriver({...driverData,name:'Другой'});
 await expect(fleet.assign({...r,vehicleId:otherVehicle,tripId:b,endsAt:date(6)})).rejects.toThrow('пересекающийся');
 await expect(fleet.assign({...r,driverId:otherDriver,tripId:b,endsAt:date(6)})).rejects.toThrow('пересекающийся');
 await fleet.assign({...r,tripId:c,endsAt:date(8)});
});
it('не допускает конфликт при параллельных назначениях',async()=>{
 const r=await resources(),a=await trip(),b=await trip(1);
 const result=await Promise.allSettled([fleet.assign({...r,tripId:a,endsAt:date(4)}),fleet.assign({...r,tripId:b,endsAt:date(5)})]);
 expect(result.filter(x=>x.status==='fulfilled')).toHaveLength(1);
});
it('проверяет проданные места, затем применяет новую вместимость к бронированию',async()=>{
 const r=await resources(),id=await trip(0,8);
 await crm.createBooking({tripId:id,name:'Клиент',phone:'+996555111222',seats:5,total:'500'});
 await expect(fleet.assign({...r,tripId:id,endsAt:date(4)})).rejects.toThrow('меньше мест');
 const booking=(await crm.dashboard()).bookings[0];await crm.cancelBooking(booking.id);
 await fleet.assign({...r,tripId:id,endsAt:date(4)});
 await expect(crm.createBooking({tripId:id,name:'Клиент',phone:'+996555111222',seats:5,total:'500'})).rejects.toThrow('вместимость');
});
it('проверяет недоступность, удостоверение и порядок дат',async()=>{
 const r=await resources(),id=await trip();
 await expect(fleet.assign({...r,tripId:id,endsAt:date(-1)})).rejects.toThrow('позже');
 await fleet.saveVehicle({...vehicleData,id:r.vehicleId,status:'maintenance'});
 await expect(fleet.assign({...r,tripId:id,endsAt:date(4)})).rejects.toThrow('Автомобиль недоступен');
 await fleet.saveVehicle({...vehicleData,id:r.vehicleId});
 await fleet.saveDriver({...driverData,id:r.driverId,licenseExpires:'2020-01-01'});
 await expect(fleet.assign({...r,tripId:id,endsAt:date(4)})).rejects.toThrow('Удостоверение');
 await fleet.saveDriver({...driverData,id:r.driverId,status:'unavailable'});
 await expect(fleet.assign({...r,tripId:id,endsAt:date(4)})).rejects.toThrow('Водитель недоступен');
});
it('не даёт редактированием ресурса сломать назначенный рейс',async()=>{
 const r=await resources(),id=await trip();await fleet.assign({...r,tripId:id,endsAt:date(4)});
 await expect(fleet.saveVehicle({...vehicleData,id:r.vehicleId,capacity:2})).rejects.toThrow('конфликтуют');
 await expect(fleet.saveVehicle({...vehicleData,id:r.vehicleId,status:'maintenance'})).rejects.toThrow('конфликтуют');
 await expect(fleet.saveDriver({...driverData,id:r.driverId,status:'unavailable'})).rejects.toThrow('конфликтуют');
});
it('хеширует пароли с уникальной солью',async()=>{
 const a=await hashPassword(password),b=await hashPassword(password);
 expect(a).not.toBe(b);expect(a).not.toContain(password);
 expect(await verifyPassword(password,a)).toBe(true);expect(await verifyPassword('wrong',a)).toBe(false);
});
it('выдаёт сессию, хранит хеш токена и завершает её при выходе',async()=>{
 const dispatcher=await user('dispatcher');
 const session=await auth.login({username:'DISPATCHER',password});expect(session).not.toBeNull();
 expect((await auth.actor(session!.token))?.id).toBe(dispatcher.id);
 expect(await auth.actor('forged')).toBeNull();
 expect((await db.query<{token_hash:string}>('SELECT token_hash FROM sessions')).rows[0].token_hash).not.toBe(session!.token);
 await auth.logout(session!.token);expect(await auth.actor(session!.token)).toBeNull();
});
it('блокирует перебор, блокировку и сброс пароля применяет к сессиям',async()=>{
 const dispatcher=await user('dispatcher');
 for(let i=0;i<5;i++)expect(await auth.login({username:'dispatcher',password:'wrong'})).toBeNull();
 expect(await auth.login({username:'dispatcher',password})).toBeNull();
 await db.query("UPDATE login_attempts SET window_start=now()-interval '16 minutes'");
 const session=(await auth.login({username:'dispatcher',password}))!;
 await auth.setUserActive(owner,dispatcher.id,false);
 expect(await auth.actor(session.token)).toBeNull();expect(await auth.login({username:'dispatcher',password})).toBeNull();
 await auth.setUserActive(owner,dispatcher.id,true);
 const next=(await auth.login({username:'dispatcher',password}))!;
 await auth.resetPassword(owner,dispatcher.id,'new-password-1234');
 expect(await auth.actor(next.token)).toBeNull();expect(await auth.login({username:'dispatcher',password})).toBeNull();
 expect(await auth.login({username:'dispatcher',password:'new-password-1234'})).not.toBeNull();
 await expect(auth.setUserActive(owner,owner.id,false)).rejects.toThrow('собственную');
});
it('водитель видит только свои рейсы и пассажиров, не может менять данные',async()=>{
 const r=await resources(),id=await trip(),other=await trip(8);
 await fleet.assign({...r,tripId:id,endsAt:date(4)});
 await crm.createBooking({tripId:id,name:'Свои',phone:'+996555111222',seats:1,total:'100',note:'Внутренняя заметка'});
 await crm.createBooking({tripId:other,name:'Чужие',phone:'+996555111333',seats:1,total:'100'});
 const driver=await user('driver',r.driverId),driverCrm=createCrm(db,driver);
 const data=await driverCrm.dashboard();expect(data.trips.map(t=>t.id)).toEqual([id]);expect(data.bookings.map(b=>b.name)).toEqual(['Свои']);expect(data.bookings[0].note).toBe('');
 await expect(driverCrm.createTrip({})).rejects.toThrow('прав');
 await expect(driverCrm.createBooking({})).rejects.toThrow('прав');
 await expect(driverCrm.addPayment({})).rejects.toThrow('прав');
 await expect(driverCrm.cancelBooking(data.bookings[0].id)).rejects.toThrow('прав');
 await expect(createFleet(db,driver).list()).rejects.toThrow('прав');
 await expect(createFleet(db,driver).assign({})).rejects.toThrow('прав');
 await expect(auth.listUsers(driver)).rejects.toThrow('прав');
});
it('диспетчер управляет рейсами, но не доступом и журналом',async()=>{
 const dispatcher=await user('dispatcher');
 const id=await createCrm(db,dispatcher).createTrip({origin:'А',destination:'Б',departureAt:date(0),capacity:4,currency:'KGS'});
 expect(id).toBeTruthy();await createFleet(db,dispatcher).saveDriver(driverData);
 await expect(auth.createUser(dispatcher,{})).rejects.toThrow('прав');
 await expect(auth.resetPassword(dispatcher,owner.id,password)).rejects.toThrow('прав');
 await expect(auth.setUserActive(dispatcher,owner.id,false)).rejects.toThrow('прав');
 await expect(auth.auditLog(dispatcher)).rejects.toThrow('прав');
});
it('не выдаёт просроченную сессию и не возвращает пароли в списке',async()=>{
 await user('dispatcher');const session=(await auth.login({username:'dispatcher',password}))!;
 await db.query("UPDATE sessions SET expires_at=now()-interval '1 second'");expect(await auth.actor(session.token)).toBeNull();
 expect(JSON.stringify(await auth.listUsers(owner))).not.toContain('password_hash');
});
it('миграция сохраняет данные версии 1 и повторяется безопасно',async()=>{
 const legacy=new PGlite();
 try {
  await legacy.exec(schemaV1);
  await legacy.query("INSERT INTO trips(id,origin,destination,departure_at,capacity,currency) VALUES('00000000-0000-4000-8000-000000000099','А','Б',$1,4,'KGS')",[date(0)]);
  await legacy.exec(migrationV2);await legacy.exec(schema);
  const row=(await legacy.query<{origin:string;ends_at:Date}>('SELECT * FROM trips')).rows[0];
  expect(row.origin).toBe('А');expect(new Date(row.ends_at).getTime()).toBe(new Date(date(6)).getTime());
  expect((await legacy.query('SELECT * FROM schema_migrations')).rows).toHaveLength(5);
 } finally {await legacy.close();}
});
