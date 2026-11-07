// Deterministic past-departure fixture, only in Playwright's isolated temporary database.
import { PGlite } from '@electric-sql/pglite';
import { schema } from '../src/lib/schema.ts';
import path from 'node:path';
import { tmpdir } from 'node:os';
const directory=process.env.DATABASE_DIR;
if(process.env.KARVEN_E2E_SEED!=='true'||!directory||path.dirname(directory)!==tmpdir()||!path.basename(directory).startsWith('karven-e2e-'))throw new Error('E2E seed requires a dedicated temporary database');
const testUrl=process.env.KARVEN_E2E_PG_URL;
let db;
if(testUrl){
 const url=new URL(testUrl);
 if(url.hostname!=='127.0.0.1'||url.port!=='55439'||!/^\/karven_e2e_[a-z0-9_]+$/.test(url.pathname))throw new Error('E2E requires a dedicated local PostgreSQL database');
 const {PostgresDatabase,migratePostgres}=await import('../src/lib/postgres.ts');db=new PostgresDatabase(testUrl);await migratePostgres(db,schema);
}else{if(process.env.DATABASE_URL)throw new Error('Refusing to seed with a non-test DATABASE_URL');db=new PGlite(directory)}
try {
 if(!testUrl)await db.exec(schema);
 await db.exec(`
 INSERT INTO drivers(id,name,phone,kind,status,license_number,license_expires) VALUES('eeeeeeee-0000-4000-8000-000000000001','Финансовый водитель','+996555000001','staff','available','FINANCE-TEST','2099-12-31');
 INSERT INTO vehicles(id,plate,model,capacity,owner_name,kind,status) VALUES('eeeeeeee-0000-4000-8000-000000000002','FINANCE-TEST','Toyota',4,'Тестовый парк','park','available');
 INSERT INTO trips(id,origin,destination,departure_at,ends_at,capacity,currency,driver_id,vehicle_id) VALUES('eeeeeeee-0000-4000-8000-000000000003','Ош','Баткен',now()-interval '2 hours',now()+interval '2 hours',4,'KGS','eeeeeeee-0000-4000-8000-000000000001','eeeeeeee-0000-4000-8000-000000000002');
 INSERT INTO clients(id,name,phone) VALUES('eeeeeeee-0000-4000-8000-000000000004','Финансовый пассажир','996555000002');
 INSERT INTO bookings(id,trip_id,client_id,seats,total_minor) VALUES('eeeeeeee-0000-4000-8000-000000000005','eeeeeeee-0000-4000-8000-000000000003','eeeeeeee-0000-4000-8000-000000000004',1,100000);
 UPDATE bookings SET contact_name='Финансовый пассажир',contact_phone='996555000002',passengers='[{"name":"Финансовый пассажир","phone":"996555000002"}]'::jsonb WHERE id='eeeeeeee-0000-4000-8000-000000000005';
 INSERT INTO drivers(id,name,phone,kind,status,license_number,license_expires) VALUES('dddddddd-0000-4000-8000-000000000001','Операционный водитель','+996555000011','staff','available','OPERATIONS-TEST','2099-12-31');
 INSERT INTO vehicles(id,plate,model,capacity,owner_name,kind,status) VALUES('dddddddd-0000-4000-8000-000000000002','OPERATIONS-TEST','Toyota',4,'Тестовый парк','park','available');
 INSERT INTO trips(id,origin,destination,departure_at,ends_at,capacity,currency,driver_id,vehicle_id) VALUES('dddddddd-0000-4000-8000-000000000003','Кант','Токмок',now()-interval '30 minutes',now()+interval '2 hours',4,'KGS','dddddddd-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000002');
 INSERT INTO clients(id,name,phone) VALUES('dddddddd-0000-4000-8000-000000000004','Пассажиры в пути','996555000012');
 INSERT INTO bookings(id,trip_id,client_id,seats,total_minor,passenger_count,contact_name,contact_phone,passengers) VALUES('dddddddd-0000-4000-8000-000000000005','dddddddd-0000-4000-8000-000000000003','dddddddd-0000-4000-8000-000000000004',2,150000,2,'Пассажиры в пути','996555000012','[{"name":"Пассажир посадки","phone":""},{"name":"Пассажир неявки","phone":""}]'::jsonb);
 INSERT INTO payments(id,booking_id,amount_minor,method) VALUES('eeeeeeee-0000-4000-8000-000000000006','eeeeeeee-0000-4000-8000-000000000005',100000,'cash');
 `);
}finally{await db.close();}
