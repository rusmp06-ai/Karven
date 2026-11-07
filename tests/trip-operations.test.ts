import {beforeEach,afterEach,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {schema,schemaV1,migrationV2,migrationV3,migrationV4,migrationV5} from '../src/lib/schema';
import {createCrm} from '../src/lib/crm';
import {createFinance} from '../src/lib/finance';
import {createFleet} from '../src/lib/fleet';
import {createTripOperations} from '../src/lib/trip-operations';
import {owner,seedOwner} from './helpers';
import type {Actor} from '../src/lib/access';
let db:PGlite,crm:ReturnType<typeof createCrm>,finance:ReturnType<typeof createFinance>,ops:ReturnType<typeof createTripOperations>,fleet:ReturnType<typeof createFleet>;
let source:string,target:string,bookingId:string,driverId:string,vehicleId:string;
const key=()=>randomUUID();
const trip=(capacity=4,currency='KGS',destination='Каракол')=>crm.createTrip({origin:'Бишкек',destination,departureAt:new Date(Date.now()+86400000).toISOString(),capacity,currency});
const booking=(tripId:string,seats=1,bookingType='seats')=>crm.createBooking({tripId,seats,bookingType,name:'Заказчик',phone:'+996555111222',total:'1000',passengers:Array.from({length:seats},(_,i)=>({name:`Пассажир ${i+1}`,phone:''}))});
const move=(id=bookingId,to=target)=>({bookingId:id,targetTripId:to,reason:'Перенос по просьбе клиента',requestId:key()});
const attendance=(status='boarded',id=bookingId,position=0)=>({bookingId:id,position,status,requestId:key()});
const cancel=(id=source)=>({tripId:id,reason:'Отмена отправления',method:'transfer',confirmed:'yes',requestId:key()});
async function assign(id=source){await fleet.assign({tripId:id,driverId,vehicleId,endsAt:new Date(Date.now()+90000000).toISOString()});}
async function departed(id=source){await db.query("UPDATE trips SET departure_at=now()-interval '30 minutes',ends_at=now()+interval '2 hours' WHERE id=$1",[id]);}
beforeEach(async()=>{
 db=new PGlite();await db.exec(schema);await seedOwner(db);crm=createCrm(db,owner);finance=createFinance(db,owner);fleet=createFleet(db,owner);ops=createTripOperations(db,owner);
 source=await trip();target=await trip();bookingId=await booking(source);
 driverId=await fleet.saveDriver({name:'Водитель',phone:'+996555333444',kind:'staff',status:'available',licenseNumber:'AB',licenseExpires:'2099-01-01'});
 vehicleId=await fleet.saveVehicle({plate:'OPS123',model:'Автомобиль',capacity:4,ownerName:'Парк',kind:'park',status:'available'});
},30000);
afterEach(async()=>{await db.close();});
it('перенос сохраняет цену, оплаты, возвраты, детали и историю; повтор не дублируется',async()=>{
 await crm.addPayment({bookingId,amount:'600',method:'cash'});await finance.refund({bookingId,amount:'100',method:'cash',reason:'Согласованная скидка',requestId:key()});
 const input=move();await Promise.all([ops.transfer(input),ops.transfer(input)]);
 const data=await crm.dashboard(),b=data.bookings[0];expect(b).toMatchObject({trip_id:target,total_minor:90000,paid_minor:50000,refunded_minor:10000,passenger_count:1});
 expect(data.trips.find(t=>t.id===source)!.occupied).toBe(0);expect(data.trips.find(t=>t.id===target)!.occupied).toBe(1);
 expect(b.history.filter(h=>h.action==='booking.transferred')).toHaveLength(1);expect(b.history.find(h=>h.action==='booking.transferred')!.details.fromTripId).toBe(source);
 expect((await db.query('SELECT * FROM payments')).rows).toHaveLength(1);expect((await db.query('SELECT * FROM refunds')).rows).toHaveLength(1);
});
it('проверяет направление, валюту, время и статус целевого рейса',async()=>{
 await expect(ops.transfer(move(bookingId,await trip(4,'USD')))).rejects.toThrow('валюте');
 await expect(ops.transfer(move(bookingId,await trip(4,'KGS','Талас')))).rejects.toThrow('направления');
 await departed(target);await expect(ops.transfer(move())).rejects.toThrow('до отправления');
 await ops.cancelTrip(cancel(target));await expect(ops.transfer(move())).rejects.toThrow('до отправления');
 expect((await crm.dashboard()).bookings[0].trip_id).toBe(source);
});
it('конкурентные переносы не перепродают последние места',async()=>{
 const second=await booking(source),small=await trip(1);
 const results=await Promise.allSettled([ops.transfer(move(bookingId,small)),ops.transfer(move(second,small))]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
 expect((await crm.dashboard()).trips.find(t=>t.id===small)!.occupied).toBe(1);
});
it('перенос всей машины резервирует всю новую вместимость',async()=>{
 await crm.cancelBooking(bookingId);bookingId=await booking(source,2,'vehicle');const larger=await trip(6);await ops.transfer(move(bookingId,larger));
 expect((await crm.dashboard()).bookings.find(b=>b.id===bookingId)).toMatchObject({trip_id:larger,seats:6,passenger_count:2});await expect(booking(larger)).rejects.toThrow('Недостаточно');
});
it('изменяет число пассажиров и освобождает места без изменения цены',async()=>{
 const input={bookingId,count:3,passengers:[{name:'Первый',phone:''},{name:'Второй',phone:''},{name:'Третий',phone:''}],childSeats:1,reason:'Добавились пассажиры',requestId:key()};
 await ops.resize(input);await ops.resize(input);let b=(await crm.dashboard()).bookings[0];expect(b).toMatchObject({seats:3,passenger_count:3,total_minor:100000,child_seats:1});
 await booking(source);await expect(ops.resize({...input,count:4,passengers:[...input.passengers,{name:'Четвёртый',phone:''}],requestId:key()})).rejects.toThrow('Недостаточно');
 await ops.resize({...input,count:1,passengers:input.passengers.slice(0,1),requestId:key()});b=(await crm.dashboard()).bookings.find(b=>b.id===bookingId)!;expect(b.seats).toBe(1);
});
it('не освобождает часть автомобиля при уменьшении группы в эксклюзивном заказе',async()=>{
 await crm.cancelBooking(bookingId);bookingId=await booking(source,3,'vehicle');await ops.resize({bookingId,count:1,passengers:[{name:'Первый',phone:''}],childSeats:0,reason:'Поедет один пассажир',requestId:key()});expect((await crm.dashboard()).bookings.find(b=>b.id===bookingId)).toMatchObject({seats:4,passenger_count:1});
});
it('ограничивает время отметок, доступ водителя и исправления',async()=>{
 await assign();const driver:Actor={...owner,role:'driver',driver_id:driverId};const driverOps=createTripOperations(db,driver);
 await expect(driverOps.attendance(attendance())).rejects.toThrow('2 часа');
 await db.query("UPDATE trips SET departure_at=now()+interval '30 minutes' WHERE id=$1",[source]);
 await expect(driverOps.attendance(attendance('no_show'))).rejects.toThrow('после');
 await expect(createTripOperations(db,{...driver,driver_id:randomUUID()}).attendance(attendance())).rejects.toThrow('прав');
 const input=attendance();await driverOps.attendance(input);await driverOps.attendance(input);expect((await crm.dashboard()).bookings[0].attendance).toEqual([{position:0,status:'boarded'}]);
 await expect(driverOps.attendance({...attendance('pending'),reason:'Исправление'})).rejects.toThrow('прав');
 await expect(ops.attendance(attendance('pending'))).rejects.toThrow('причину');
 await ops.attendance({...attendance('pending'),reason:'Ошибочная отметка'});expect((await crm.dashboard()).bookings[0].attendance).toEqual([]);
});
it('требует отметки всех пассажиров для завершения и сохраняет долг при неявке',async()=>{
 await assign();await departed();await expect(finance.completeTrip({tripId:source,requestId:key()})).rejects.toThrow('Осталось отметить');
 await ops.attendance(attendance('no_show'));expect((await crm.dashboard()).bookings[0]).toMatchObject({total_minor:100000,paid_minor:0});
 await finance.completeTrip({tripId:source,requestId:key()});await expect(ops.attendance({...attendance('pending'),reason:'Исправление'})).rejects.toThrow('закрыт');
});
it('после посадки запрещает перенос, изменение состава и отмену без исправления',async()=>{
 await assign();await db.query("UPDATE trips SET departure_at=now()+interval '30 minutes' WHERE id=$1",[source]);await ops.attendance(attendance());
 await expect(ops.transfer(move())).rejects.toThrow('отметки');
 await expect(ops.resize({bookingId,count:1,passengers:[{name:'Другой',phone:''}],childSeats:0,reason:'Изменение',requestId:key()})).rejects.toThrow('отметки');
 await expect(crm.cancelBooking(bookingId)).rejects.toThrow('отметки');await expect(finance.cancelWithRefund({bookingId,method:'cash',reason:'Отмена',requestId:key()})).rejects.toThrow('отметки');
 await expect(ops.cancelTrip(cancel())).rejects.toThrow('отметки');
 const otherVehicle=await fleet.saveVehicle({plate:'OPS456',model:'Другой авто',capacity:4,ownerName:'Парк',kind:'park',status:'available'});await expect(fleet.assign({tripId:source,driverId,vehicleId:otherVehicle,endsAt:new Date(Date.now()+3*3600000).toISOString()})).rejects.toThrow('отметки');
});
it('отменяет рейс с возвратом остатка каждой оплаты, сохраняет расходы и идемпотентность',async()=>{
 const other=await booking(source);await crm.addPayment({bookingId,amount:'600',method:'cash'});await finance.refund({bookingId,amount:'100',method:'cash',reason:'Скидка',requestId:key()});
 await crm.addPayment({bookingId:other,amount:'300',method:'card'});await finance.addExpense({tripId:source,amount:'50',paidBy:'park',category:'fuel',description:'Заправка',requestId:key()});
 const input=cancel();await Promise.all([ops.cancelTrip(input),ops.cancelTrip(input)]);const data=await crm.dashboard();expect(data.trips.find(t=>t.id===source)).toMatchObject({status:'cancelled',occupied:0,cancel_reason:'Отмена отправления'});
 expect(data.bookings.filter(b=>b.trip_id===source).every(b=>b.status==='cancelled'&&b.paid_minor===0&&b.total_minor===0)).toBe(true);
 expect((await db.query('SELECT * FROM refunds')).rows).toHaveLength(3);expect((await db.query('SELECT * FROM trip_expenses')).rows).toHaveLength(1);
 expect((await finance.report()).trips.find(t=>t.id===source)).toMatchObject({revenue_minor:0,cash_minor:-5000,result_minor:-5000});
 await expect(booking(source)).rejects.toThrow('закрыто');await expect(finance.completeTrip({tripId:source,requestId:key()})).rejects.toThrow('Отменённый');
});
it('диспетчер отменяет только неоплаченный рейс, ошибка не меняет данные',async()=>{
 const dispatcher=createTripOperations(db,{...owner,role:'dispatcher'});await crm.addPayment({bookingId,amount:'100',method:'cash'});await expect(dispatcher.cancelTrip(cancel())).rejects.toThrow('прав');
 expect((await crm.dashboard()).trips.find(t=>t.id===source)!.status).toBe('scheduled');expect((await db.query('SELECT * FROM refunds')).rows).toHaveLength(0);
 await dispatcher.cancelTrip(cancel(target));expect((await crm.dashboard()).trips.find(t=>t.id===target)!.status).toBe('cancelled');
});
it('возмещает расходы водителя после отмены рейса и освобождает ресурсы',async()=>{
 await assign();await finance.addExpense({tripId:source,amount:'200',paidBy:'driver',category:'fuel',description:'Заправка',requestId:key()});await ops.cancelTrip(cancel());
 await assign(target);await finance.approveSettlement({tripId:source,fee:'0',note:'Возмещение после отмены',requestId:key()});await finance.payDriver({tripId:source,amount:'200',method:'transfer',requestId:key()});
 expect((await finance.report()).trips.find(t=>t.id===source)).toMatchObject({reimbursement_minor:20000,paid_driver_minor:20000,result_minor:-20000});
});
it('водитель не управляет рейсами/составом, история менеджера не выдаётся водителю',async()=>{
 await assign();const driver={...owner,role:'driver' as const,driver_id:driverId},driverOps=createTripOperations(db,driver);
 await expect(driverOps.transfer(move())).rejects.toThrow('прав');await expect(driverOps.resize({})).rejects.toThrow('прав');await expect(driverOps.cancelTrip(cancel())).rejects.toThrow('прав');
 expect((await createCrm(db,driver).dashboard()).bookings[0].history).toEqual([]);
});
it('миграция 5 сохраняет рейсы предыдущей версии и повторяется безопасно',async()=>{
 const old=new PGlite();try{await old.exec(schemaV1+migrationV2+migrationV3+migrationV4);await seedOwner(old);await old.exec(migrationV5);await old.exec(schema);expect((await old.query('SELECT * FROM users')).rows).toHaveLength(1);expect((await old.query('SELECT * FROM schema_migrations')).rows).toHaveLength(9);}finally{await old.close();}
});
