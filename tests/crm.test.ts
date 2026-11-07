import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { schema } from '../src/lib/schema';
import { owner, seedOwner } from './helpers';
import { createCrm, toMinor } from '../src/lib/crm';
let db:PGlite;
let crm:ReturnType<typeof createCrm>;
let tripId:string;
const booking = () => ({tripId,name:'Руслан',phone:'+996 (555) 123-456',seats:1,total:'1500.50'});
beforeEach(async()=>{
 db=new PGlite(); await db.exec(schema); await seedOwner(db); crm=createCrm(db,owner);
 tripId=await crm.createTrip({origin:'Бишкек',destination:'Каракол',departureAt:new Date(Date.now()+86400000).toISOString(),capacity:2,currency:'KGS'});
},30000);
afterEach(async()=>{await db.close()});
describe('Бронирования и расчёты',()=>{
 it('сохраняет клиента, бронь и частичную оплату без округления',async()=>{
  const id=await crm.createBooking(booking());
  await crm.addPayment({bookingId:id,amount:'500.25',method:'cash'});
  const data=await crm.dashboard();
  expect(data.trips[0].occupied).toBe(1);
  expect(data.bookings[0]).toMatchObject({total_minor:150050,paid_minor:50025,phone:'996555123456'});
  expect(data.bookings[0].total_minor-data.bookings[0].paid_minor).toBe(100025);
 });
 it('не допускает перепродажу при одновременном бронировании',async()=>{
  const results=await Promise.allSettled([crm.createBooking({...booking(),seats:2}),crm.createBooking({...booking(),seats:2})]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const data=await crm.dashboard(); expect(data.trips[0].occupied).toBe(2); expect(data.bookings).toHaveLength(1);
 });
 it('отмена освобождает места и не удаляет историю',async()=>{
  const id=await crm.createBooking({...booking(),seats:2}); await crm.cancelBooking(id); await crm.cancelBooking(id);
  const data=await crm.dashboard(); expect(data.trips[0].occupied).toBe(0); expect(data.bookings[0].status).toBe('cancelled');
  const {rows}=await db.query("SELECT * FROM audit_events WHERE action='booking.cancelled'"); expect(rows).toHaveLength(1);
 });
 it('защищает от переплаты, включая конкурентные платежи',async()=>{
  const id=await crm.createBooking(booking());
  const results=await Promise.allSettled([crm.addPayment({bookingId:id,amount:'1000',method:'cash'}),crm.addPayment({bookingId:id,amount:'1000',method:'cash'})]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await crm.dashboard()).bookings[0].paid_minor).toBe(100000);
 });
 it('не отменяет оплаченную бронь и не принимает оплату отменённой',async()=>{
  const id=await crm.createBooking(booking()); await crm.addPayment({bookingId:id,amount:'1',method:'card'});
  await expect(crm.cancelBooking(id)).rejects.toThrow('возврата');
  const other=await crm.createBooking(booking()); await crm.cancelBooking(other);
  await expect(crm.addPayment({bookingId:other,amount:'1',method:'cash'})).rejects.toThrow('не найдена');
 });
 it('объединяет клиента по нормализованному телефону',async()=>{
  await crm.createBooking(booking()); await crm.createBooking({...booking(),phone:'996555123456'});
  expect((await db.query('SELECT * FROM clients')).rows).toHaveLength(1);
 });
 it('отклоняет некорректные суммы, даты и число мест',async()=>{
  expect(toMinor('0.01')).toBe(1); expect(()=>toMinor('1.001')).toThrow();
  await expect(crm.createBooking({...booking(),seats:-1})).rejects.toThrow();
  await expect(crm.createTrip({origin:'А',destination:'Б',departureAt:'2020-01-01T00:00:00Z',capacity:4,currency:'KGS'})).rejects.toThrow('будущем');
 });
});
