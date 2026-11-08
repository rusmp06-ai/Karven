import {it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {schema} from '../src/lib/schema';
import {createCrm} from '../src/lib/crm';
import {owner,seedOwner} from './helpers';

it('ошибка внутри пакетной предоплаты откатывает клиента, бронь, аудит, очередь и ключ повтора',async()=>{
 const db=new PGlite();
 try{
  await db.exec(schema);await seedOwner(db);const crm=createCrm(db,owner);
  const tripId=await crm.createTrip({origin:'Бишкек',destination:'Нарын',capacity:8,currency:'KGS',departureAt:new Date(Date.now()+86400000).toISOString()});
  await db.exec("UPDATE telegram_settings SET enabled=true,encrypted_token='test',chat_id='123' WHERE id=1;ALTER TABLE payments ADD CONSTRAINT test_payment_rejection CHECK(amount_minor<>12345)");
  const requestId=randomUUID(),input={tripId,name:'Проверка отката',phone:'+996555000123',seats:2,total:'500',initialPayment:'123.45',requestId};
  await expect(crm.createBooking(input)).rejects.toThrow();
  for(const table of ['clients','bookings','payments','telegram_outbox'])expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
  expect((await db.query('SELECT * FROM mutation_receipts WHERE request_id=$1',[requestId])).rows).toHaveLength(0);
  expect((await db.query("SELECT * FROM audit_events WHERE action IN ('booking.created','payment.recorded')")).rows).toHaveLength(0);
  await db.exec('ALTER TABLE payments DROP CONSTRAINT test_payment_rejection');
  const id=await crm.createBooking(input);expect(await crm.createBooking(input)).toBe(id);
  expect((await crm.dashboard()).bookings[0]).toMatchObject({paid_minor:12345,total_minor:50000,seats:2});
  expect((await db.query('SELECT * FROM payments')).rows).toHaveLength(1);
  expect((await db.query<{payload:{paid:number}}>('SELECT payload FROM telegram_outbox')).rows[0].payload.paid).toBe(12345);
 }finally{await db.close()}
},30000);
