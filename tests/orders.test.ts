import { beforeEach,afterEach,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { schema,schemaV1,migrationV2,migrationV3,migrationV4 } from '../src/lib/schema';
import { createCrm } from '../src/lib/crm';
import { createFleet } from '../src/lib/fleet';
import { owner,seedOwner } from './helpers';
let db:PGlite,crm:ReturnType<typeof createCrm>,tripId:string;
const input=()=>({tripId,name:'Заказчик',phone:'+996555111222',seats:2,total:'2000',pickupAddress:'Бишкек, Чуй 10',dropoffAddress:'Каракол, Ленина 20',luggage:'2 чемодана',childSeats:1,source:'whatsapp',passengers:[{name:'Пассажир первый',phone:'+996555333444'},{name:'Пассажир второй',phone:''}]});
beforeEach(async()=>{db=new PGlite();await db.exec(schema);await seedOwner(db);crm=createCrm(db,owner);tripId=await crm.createTrip({origin:'Бишкек',destination:'Каракол',departureAt:new Date(Date.now()+86400000).toISOString(),capacity:4,currency:'KGS'});},30000);
afterEach(async()=>{await db.close()});
it('сохраняет заказчика отдельно от пассажиров и полную карточку',async()=>{
 await crm.createBooking(input());const b=(await crm.dashboard()).bookings[0];
 expect(b).toMatchObject({name:'Заказчик',phone:'996555111222',passenger_count:2,seats:2,pickup_address:'Бишкек, Чуй 10',dropoff_address:'Каракол, Ленина 20',luggage:'2 чемодана',child_seats:1,source:'whatsapp',booking_type:'seats'});
 expect(b.passengers).toEqual([{name:'Пассажир первый',phone:'996555333444'},{name:'Пассажир второй',phone:''}]);
});
it('вся машина занимает все места и не продаётся вместе с другими заказами',async()=>{
 const id=await crm.createBooking({...input(),bookingType:'vehicle'});
 expect((await crm.dashboard()).bookings[0]).toMatchObject({booking_type:'vehicle',seats:4,passenger_count:2});
 await expect(crm.createBooking(input())).rejects.toThrow('Недостаточно');await crm.cancelBooking(id);
 await crm.createBooking(input());await expect(crm.createBooking({...input(),bookingType:'vehicle'})).rejects.toThrow('Недостаточно');
});
it('одновременные обычный заказ и заказ машины не перепродают места',async()=>{
 const results=await Promise.allSettled([crm.createBooking(input()),crm.createBooking({...input(),bookingType:'vehicle'})]);
 expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect((await crm.dashboard()).trips[0].occupied).toBeLessThanOrEqual(4);
});
it('после смены машины эксклюзивный заказ занимает всю новую вместимость',async()=>{
 await crm.createBooking({...input(),bookingType:'vehicle'});const fleet=createFleet(db,owner);
 const driverId=await fleet.saveDriver({name:'Водитель',phone:'+996555888888',kind:'staff',status:'available',licenseNumber:'AB',licenseExpires:'2099-12-31'});
 const vehicle=(capacity:number,plate:string)=>fleet.saveVehicle({model:'Авто',plate,capacity,ownerName:'Парк',kind:'park',status:'available'});
 const assign=async(capacity:number)=>fleet.assign({tripId,driverId,vehicleId:await vehicle(capacity,`TEST${capacity}`),endsAt:new Date(Date.now()+90000000).toISOString()});
 await assign(6);expect((await crm.dashboard()).bookings[0].seats).toBe(6);await expect(crm.createBooking(input())).rejects.toThrow('Недостаточно');
 await assign(2);expect((await crm.dashboard()).bookings[0].seats).toBe(2);await expect(assign(1)).rejects.toThrow('пассажиров');
});
it('проверяет число пассажиров, телефоны и детские кресла',async()=>{
 await expect(crm.createBooking({...input(),passengers:input().passengers.slice(0,1)})).rejects.toThrow('каждого пассажира');
 await expect(crm.createBooking({...input(),childSeats:3})).rejects.toThrow('кресел');
 await expect(crm.createBooking({...input(),passengers:[{name:'Первый',phone:'bad'},{name:'Второй',phone:''}]})).rejects.toThrow();
 await expect(crm.createBooking({...input(),seats:5,bookingType:'vehicle',passengers:undefined})).rejects.toThrow('вместимость');
 expect((await crm.dashboard()).bookings).toHaveLength(0);
});
it('редактирует детали без изменения цены, мест и контактов другого заказа',async()=>{
 const id=await crm.createBooking(input());await crm.createBooking(input());
 await crm.updateBookingDetails({...input(),bookingId:id,name:'Другой контакт',phone:'+996555999000',pickupAddress:'Новый адрес'});
 const data=await crm.dashboard();const edited=data.bookings.find(b=>b.id===id)!;
 expect(edited).toMatchObject({name:'Другой контакт',phone:'996555999000',pickup_address:'Новый адрес',total_minor:200000,seats:2});
 expect(data.bookings.find(b=>b.id!==id)!.name).toBe('Заказчик');expect(data.trips[0].occupied).toBe(4);
 expect((await db.query("SELECT actor_id FROM audit_events WHERE action='booking.details_updated'")).rows).toHaveLength(1);
});
it('драйвер видит операционные детали только своего рейса и не меняет заказ',async()=>{
 const id=await crm.createBooking(input());const driverId=randomUUID();await db.query("INSERT INTO drivers(id,name,phone,kind,license_number,license_expires) VALUES($1,'Водитель','1234567','staff','AB','2099-01-01')",[driverId]);
 // Assignment pairs are protected by a constraint; create a matching vehicle for the fixture.
 const vehicleId=randomUUID();await db.query("INSERT INTO vehicles(id,plate,model,capacity,owner_name,kind) VALUES($1,'DRIVER-TEST','Авто',4,'Парк','park')",[vehicleId]);
 await db.query('UPDATE trips SET driver_id=$2,vehicle_id=$3 WHERE id=$1',[tripId,driverId,vehicleId]);
 const driver=createCrm(db,{...owner,role:'driver',driver_id:driverId});const own=(await driver.dashboard()).bookings[0];expect(own.passengers[0].name).toBe('Пассажир первый');expect(own.source).toBe('');
 await expect(driver.updateBookingDetails({...input(),bookingId:id})).rejects.toThrow('прав');
 expect((await createCrm(db,{...owner,role:'driver',driver_id:randomUUID()}).dashboard()).bookings).toHaveLength(0);
});
it('не меняет детали завершённого или отменённого заказа',async()=>{
 const id=await crm.createBooking(input());await crm.cancelBooking(id);await expect(crm.updateBookingDetails({...input(),bookingId:id})).rejects.toThrow('Активная');
 const other=await crm.createBooking(input());await db.query("UPDATE trips SET status='completed' WHERE id=$1",[tripId]);await expect(crm.updateBookingDetails({...input(),bookingId:other})).rejects.toThrow('завершённого');
});
it('миграция сохраняет старую бронь и не выдумывает неизвестных пассажиров',async()=>{
 const legacy=new PGlite();try{
  await legacy.exec(schemaV1+migrationV2+migrationV3);await seedOwner(legacy);
  const cid=randomUUID(),tid=randomUUID(),bid=randomUUID();
  await legacy.query('INSERT INTO clients(id,name,phone) VALUES($1,$2,$3)',[cid,'Старый клиент','996555123456']);
  await legacy.query("INSERT INTO trips(id,origin,destination,departure_at,ends_at,capacity,currency) VALUES($1,'А','Б',now(),now()+interval '1 hour',4,'KGS')",[tid]);
  await legacy.query('INSERT INTO bookings(id,trip_id,client_id,seats,total_minor) VALUES($1,$2,$3,3,50000)',[bid,tid,cid]);
  await legacy.exec(migrationV4);await legacy.exec(schema);
  const b=(await createCrm(legacy,owner).dashboard()).bookings[0];
  expect(b).toMatchObject({passenger_count:3,seats:3,total_minor:50000,name:'Старый клиент'});expect(b.passengers).toHaveLength(1);expect((await legacy.query('SELECT * FROM schema_migrations')).rows).toHaveLength(5);
 }finally{await legacy.close();}
});
