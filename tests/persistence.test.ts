import { expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { schema } from '../src/lib/schema';
import { owner, seedOwner } from './helpers';
import { createCrm } from '../src/lib/crm';
it('сохраняет рейс, бронь и оплату после повторного открытия базы',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'karven-test-'));
 let db=new PGlite(directory);
 try {
  await db.exec(schema);
  await seedOwner(db);
  let crm=createCrm(db,owner);
  const tripId=await crm.createTrip({origin:'А',destination:'Б',departureAt:new Date(Date.now()+86400000).toISOString(),capacity:4,currency:'KGS'});
  const bookingId=await crm.createBooking({tripId,name:'Тест',phone:'+996555111222',seats:2,total:'100'});
  await crm.addPayment({bookingId,amount:'40',method:'transfer'});
  await db.close();
  db=new PGlite(directory);
  await db.exec(schema);
  crm=createCrm(db,owner);
  const data=await crm.dashboard();
  expect(data.trips[0].occupied).toBe(2);
  expect(data.bookings[0]).toMatchObject({id:bookingId,total_minor:10000,paid_minor:4000});
 } finally {await db.close(); await rm(directory,{recursive:true,force:true});}
},30000);
