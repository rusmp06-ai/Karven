import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {PostgresDatabase,postgresConfig,migratePostgres,checkPostgres} from '../src/lib/postgres';
import {schema} from '../src/lib/schema';
import {createCrm} from '../src/lib/crm';
import {createBackups} from '../src/lib/backups';
import {hashPassword} from '../src/lib/auth';
import {owner,seedOwner} from './helpers';
it('проверяет формат подключения и не позволяет URL отключить TLS или изменить схему',()=>{
 expect(()=>postgresConfig('https://project.supabase.co/rest/v1')).toThrow('PostgreSQL');expect(()=>postgresConfig('postgres://user:pass@aws-0-example.pooler.supabase.com:6543/postgres')).toThrow('Session');const config=postgresConfig('postgres://user:pass@aws-0-example.pooler.supabase.com:5432/postgres?sslmode=disable&host=localhost&options=bad');expect(config.ssl).toMatchObject({rejectUnauthorized:true});expect(config.connectionString).not.toContain('?');expect(config.options).toBeUndefined();
});
const enabled=!!process.env.KARVEN_PG_TEST_URL;
let admin:pg.Pool,db:PostgresDatabase,second:PostgresDatabase,root:string;
const database=`karven_test_${randomUUID().replaceAll('-','')}`;
beforeAll(async()=>{if(!enabled)return;const base=new URL(process.env.KARVEN_PG_TEST_URL!);if(base.hostname!=='127.0.0.1'||base.port!=='55439')throw new Error('Use the dedicated local test PostgreSQL at 127.0.0.1:55439');admin=new pg.Pool({connectionString:base.toString(),ssl:false});await admin.query(`CREATE DATABASE "${database}"`);base.pathname=`/${database}`;db=new PostgresDatabase(base.toString());second=new PostgresDatabase(base.toString());await db.exec("CREATE TABLE public.sentinel(id integer PRIMARY KEY);INSERT INTO public.sentinel VALUES(7);DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;END $$");await migratePostgres(db,schema);root=await mkdtemp(path.join(tmpdir(),'karven-pg-backup-'));},30000);
beforeEach(async()=>{if(!enabled)return;const tables=(await db.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='karven' AND tablename<>'schema_migrations'")).rows.map(t=>`"${t.tablename}"`);await db.exec(`TRUNCATE ${tables.join(',')};INSERT INTO park_settings(id,name,default_currency) VALUES('00000000-0000-4000-8000-000000000008','KARVEN','KGS');INSERT INTO telegram_settings(id) VALUES(1)`);await seedOwner(db);},15000);
afterAll(async()=>{if(!enabled)return;try{await second?.close();await db?.close();await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)}finally{await admin?.end();if(root)await rm(root,{recursive:true,force:true})}},30000);
it.skipIf(!enabled)('миграции изолированы в karven, public не меняется, anon доступа не имеет',async()=>{
 expect(await checkPostgres(db)).toEqual({schema:'karven',version:9});expect((await db.query('SELECT * FROM public.sentinel')).rows).toEqual([{id:7}]);const count=(await db.query<{n:number}>("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname='karven' AND rowsecurity")).rows[0].n;expect(count).toBe(23);await expect(second.acquireApplicationLease()).rejects.toThrow('другим сервером');await expect(second.transaction(async tx=>{await tx.exec('SET LOCAL ROLE anon');await tx.query('SELECT * FROM karven.clients')})).rejects.toMatchObject({code:'42501'})
});
it.skipIf(!enabled)('ошибка транзакции откатывает изменения и освобождает соединение',async()=>{
 await expect(db.transaction(async tx=>{await tx.query('INSERT INTO clients(id,name,phone) VALUES($1,$2,$3)',[randomUUID(),'Откат','996555000000']);throw new Error('rollback')})).rejects.toThrow('rollback');expect((await db.query('SELECT * FROM clients')).rows).toHaveLength(0);expect((await db.query('SELECT 1 AS n')).rows).toEqual([{n:1}]);
});
it.skipIf(!enabled)('две независимые PostgreSQL-сессии не перепродают последнее место',async()=>{
 const crm=createCrm(db,owner),other=createCrm(second,owner);const tripId=await crm.createTrip({origin:'Бишкек',destination:'Нарын',capacity:1,currency:'KGS',departureAt:new Date(Date.now()+86400000).toISOString()});const input={tripId,name:'Клиент',phone:'+996555123456',seats:1,total:'300'};const result=await Promise.allSettled([crm.createBooking(input),other.createBooking(input)]);expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await crm.dashboard()).trips[0].occupied).toBe(1);
});
it.skipIf(!enabled)('повтор оплаты через разные соединения не создаёт второй платёж',async()=>{
 const crm=createCrm(db,owner),other=createCrm(second,owner);const tripId=await crm.createTrip({origin:'Бишкек',destination:'Ош',capacity:4,currency:'KGS',departureAt:new Date(Date.now()+86400000).toISOString()});const bookingId=await crm.createBooking({tripId,name:'Клиент',phone:'+996555123456',seats:1,total:'300'});const input={bookingId,amount:'100',method:'cash',requestId:randomUUID()};await Promise.all([crm.addPayment(input),other.addPayment(input)]);expect((await db.query('SELECT * FROM payments')).rows).toHaveLength(1);expect((await crm.dashboard()).bookings[0].paid_minor).toBe(10000);
});
it.skipIf(!enabled)('копия серверной PostgreSQL проверяется на PGlite и восстанавливает деньги',async()=>{
 await db.query('UPDATE users SET password_hash=$2 WHERE id=$1',[owner.id,await hashPassword('postgres-owner-password')]);const crm=createCrm(db,owner),tripId=await crm.createTrip({origin:'Бишкек',destination:'Талас',capacity:4,currency:'KGS',departureAt:new Date(Date.now()+86400000).toISOString()});const bookingId=await crm.createBooking({tripId,name:'Клиент',phone:'+996555123456',seats:1,total:'300',initialPayment:'100'});const backups=createBackups(db,owner,root),copy=await backups.create(randomUUID());await crm.addPayment({bookingId,amount:'50',method:'cash',requestId:randomUUID()});await backups.restore({backupId:copy.id,password:'postgres-owner-password',confirmation:'ВОССТАНОВИТЬ',confirmed:'yes',requestId:randomUUID()});expect((await crm.dashboard()).bookings[0].paid_minor).toBe(10000);expect((await db.query('SELECT * FROM public.sentinel')).rows).toEqual([{id:7}]);
},40000);
