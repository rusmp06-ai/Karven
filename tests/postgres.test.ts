import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {randomUUID,X509Certificate} from 'node:crypto';
import {supabaseRootCa} from '../src/lib/supabase-ca.mjs';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {createServer,createConnection,type Socket,type AddressInfo} from 'node:net';
import {rootCertificates} from 'node:tls';
import {PostgresDatabase,postgresConfig,migratePostgres,checkPostgres,migrationSql} from '../src/lib/postgres';
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
beforeEach(async()=>{if(!enabled)return;const tables=(await db.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='karven' AND tablename<>'schema_migrations'")).rows.map(t=>`"${t.tablename}"`);await db.exec(`TRUNCATE ${tables.join(',')};INSERT INTO park_settings(id,name,default_currency) VALUES('00000000-0000-4000-8000-000000000008','KARVEN','KGS');INSERT INTO telegram_settings(id) VALUES(1);INSERT INTO organization_settings(id) VALUES(1)`);await db.exec('TRUNCATE karven_archive.backups');await seedOwner(db);},15000);
afterAll(async()=>{if(!enabled)return;try{await second?.close();await db?.close();await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)}finally{await admin?.end();if(root)await rm(root,{recursive:true,force:true})}},30000);
it.skipIf(!enabled)('миграции изолированы в karven, public не меняется, anon доступа не имеет',async()=>{
 expect(await checkPostgres(db)).toEqual({schema:'karven',version:10});expect((await db.query('SELECT * FROM public.sentinel')).rows).toEqual([{id:7}]);const count=(await db.query<{n:number}>("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname='karven' AND rowsecurity")).rows[0].n;expect(count).toBe(32);await db.acquireApplicationLease();await expect(second.acquireApplicationLease()).rejects.toThrow('другим сервером');await db.releaseApplicationLease();await expect(second.transaction(async tx=>{await tx.exec('SET LOCAL ROLE anon');await tx.query('SELECT * FROM karven.clients')})).rejects.toMatchObject({code:'42501'})
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

it.skipIf(!enabled)('копии доступны другому экземпляру и сохраняются после восстановления, anon доступа не имеет',async()=>{
 await db.query('UPDATE users SET password_hash=$2 WHERE id=$1',[owner.id,await hashPassword('cloud-owner-password')]);
 const crm=createCrm(db,owner),tripId=await crm.createTrip({origin:'Нарын',destination:'Ош',capacity:2,currency:'KGS',departureAt:new Date(Date.now()+86400000).toISOString()});
 const bookingId=await crm.createBooking({tripId,name:'Облачный клиент',phone:'+996555123456',seats:1,total:'300',initialPayment:'100'});
 const first=createBackups(db,owner),copy=await first.create(randomUUID());
 const other=createBackups(second,owner);expect((await other.list())[0].id).toBe(copy.id);expect(await other.download(copy.id)).toEqual(await first.download(copy.id));
 await crm.addPayment({bookingId,amount:'50',method:'cash',requestId:randomUUID()});
 await second.withWorkspace(()=>other.restore({backupId:copy.id,password:'cloud-owner-password',confirmation:'ВОССТАНОВИТЬ',confirmed:'yes',requestId:randomUUID()}));
 expect((await crm.dashboard()).bookings[0].paid_minor).toBe(10000);expect(await first.list()).toHaveLength(2);
 await expect(second.transaction(async tx=>{await tx.exec('SET LOCAL ROLE anon');await tx.query('SELECT * FROM karven_archive.backups')})).rejects.toMatchObject({code:'42501'});
},40000);
it.skipIf(!enabled)('блокировка запроса координирует разные экземпляры и освобождается после ошибки',async()=>{
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r}),gate=new Promise<void>(r=>{release=r});const order:string[]=[];
 const first=db.withWorkspace(async()=>{order.push('first');enter();await gate;throw new Error('request failed')});const handled=expect(first).rejects.toThrow('request failed');await entered;
 let blocked=false;const secondWork=second.withWorkspace(async()=>{blocked=true;order.push('second')});
 await new Promise(r=>setTimeout(r,50));expect(blocked).toBe(false);release();await handled;await secondWork;expect(order).toEqual(['first','second']);
});

it.skipIf(!enabled)('потеря соединения блокировки останавливает последующие изменения запроса',async()=>{
 await expect(db.withWorkspace(async()=>{
  const result=await admin.query<{pid:number}>("SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=$1 AND l.locktype='advisory' AND l.objid=746376002 AND l.granted",[database]);
  expect(result.rows).toHaveLength(1);await admin.query('SELECT pg_terminate_backend($1)',[result.rows[0].pid]);await new Promise(r=>setTimeout(r,50));
  await db.query('INSERT INTO clients(id,name,phone) VALUES($1,$2,$3)',[randomUUID(),'Не сохранять','996555000099']);
 })).rejects.toThrow('блокировки');
 expect((await db.query('SELECT * FROM clients')).rows).toHaveLength(0);
});
it.skipIf(!enabled)('SQL для редактора Supabase повторно подготавливает обе схемы без изменения public',async()=>{
 await db.exec(migrationSql(schema));await db.exec(migrationSql(schema));expect(await checkPostgres(db)).toEqual({schema:'karven',version:10});expect((await db.query('SELECT * FROM public.sentinel')).rows).toEqual([{id:7}]);
});

it.skipIf(!enabled)('опубликованный установочный файл работает на пустой базе с пустым search_path',async()=>{
 const fresh=`${database}_install`;await admin.query(`CREATE DATABASE "${fresh}"`);
 const url=new URL(process.env.KARVEN_PG_TEST_URL!);url.pathname=`/${fresh}`;const client=new pg.Client({connectionString:url.toString(),ssl:false});
 try{
  await client.connect();await client.query("CREATE TABLE public.sentinel(id integer);INSERT INTO public.sentinel VALUES(7);SET search_path TO ''");
  const sql=await readFile(new URL('../docs/supabase-netlify.sql',import.meta.url),'utf8');expect(sql).toBe(migrationSql(schema));
  await client.query(sql);await client.query(sql);
  expect((await client.query('SELECT version FROM karven.schema_migrations ORDER BY version')).rows.map(r=>r.version)).toEqual([1,2,3,4,5,6,7,8,9,10]);
  expect((await client.query('SELECT * FROM public.sentinel')).rows).toEqual([{id:7}]);
  expect((await client.query("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname IN ('karven','karven_archive') AND rowsecurity")).rows[0].n).toBe(35);
  await client.query('SET ROLE anon');await expect(client.query('SELECT * FROM karven.clients')).rejects.toMatchObject({code:'42501'});
 }finally{await client.end();await admin.query(`DROP DATABASE IF EXISTS "${fresh}" WITH (FORCE)`)}
},30000);

it('принимает CA из переменной Netlify, сохраняет проверку TLS и отклоняет испорченный сертификат',()=>{
 const url='postgresql://user:password@aws-0-example.pooler.supabase.com:5432/postgres?sslmode=disable';
 try{
  const certificate=rootCertificates[0];vi.stubEnv('PGSSLROOTCERT_PEM',certificate);expect(postgresConfig(url).ssl).toMatchObject({rejectUnauthorized:true,ca:certificate.trim()});
  vi.stubEnv('PGSSLROOTCERT_PEM',certificate.replaceAll('\n','\\n'));expect(postgresConfig(url).ssl).toMatchObject({rejectUnauthorized:true,ca:certificate.trim()});
  vi.stubEnv('PGSSLROOTCERT_PEM','invalid-secret-content');expect(()=>postgresConfig(url)).toThrow('PGSSLROOTCERT_PEM');expect(()=>postgresConfig(url)).not.toThrow('invalid-secret-content');
 }finally{vi.unstubAllEnvs()}
});

it('использует проверенный корневой сертификат только для Supabase при отсутствии переопределений',()=>{
 try{
  vi.stubEnv('PGSSLROOTCERT_PEM','');vi.stubEnv('PGSSLROOTCERT','');
  const cert=new X509Certificate(supabaseRootCa);expect(cert.ca).toBe(true);expect(cert.verify(cert.publicKey)).toBe(true);
  expect(cert.fingerprint256).toBe('80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA');
  const config=postgresConfig('postgresql://user:password@aws-0-example.pooler.supabase.com:5432/postgres');expect(config.ssl).toMatchObject({rejectUnauthorized:true,ca:expect.arrayContaining([supabaseRootCa])});
  const unrelated=postgresConfig('postgresql://user:password@other.example:5432/postgres');expect(unrelated.ssl).toEqual({rejectUnauthorized:true});
 }finally{vi.unstubAllEnvs()}
});

it.skipIf(!enabled)('запрос и транзакции через разные адаптеры используют одно соединение',async()=>{
 await db.withWorkspace(async()=>{
  const first=(await db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  expect((await second.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(first);
  expect(await second.transaction(async tx=>(await tx.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid)).toBe(first);
  expect((await db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(first);
 });
});
it.skipIf(!enabled)('независимая страховочная запись переживает откат закреплённой транзакции',async()=>{
 const id=randomUUID();
 await db.withWorkspace(async()=>{
  await expect(second.transaction(async tx=>{
   await tx.query('INSERT INTO clients(id,name,phone) VALUES($1,$2,$3)',[randomUUID(),'Откат','996555000033']);
   await db.independentQuery('INSERT INTO karven_archive.backups(id,metadata,payload) VALUES($1,$2::jsonb,$3)',[id,JSON.stringify({proof:true}),Buffer.from('durable')]);throw new Error('rollback');
  })).rejects.toThrow('rollback');
 });
 expect((await db.query('SELECT * FROM clients')).rows).toHaveLength(0);expect((await db.query('SELECT id FROM karven_archive.backups WHERE id=$1',[id])).rows).toHaveLength(1);
});
it.skipIf(!enabled)('20 экземпляров работают при лимите 15 сессий и не оставляют соединений после ответа',async()=>{
 const role=`karven_limit_${randomUUID().replaceAll('-','')}`;const workers:PostgresDatabase[]=[];let business:PostgresDatabase|undefined;
 await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'karven-test-only' CONNECTION LIMIT 15 BYPASSRLS`);
 try{
  await db.exec(`GRANT USAGE ON SCHEMA karven,karven_archive TO "${role}";GRANT ALL ON ALL TABLES IN SCHEMA karven,karven_archive TO "${role}"`);
  vi.stubEnv('CRM_DEPLOYMENT','netlify');const url=new URL(process.env.KARVEN_PG_TEST_URL!);url.pathname=`/${database}`;url.username=role;url.password='karven-test-only';
  business=new PostgresDatabase(url.toString());for(let i=0;i<20;i++)workers.push(new PostgresDatabase(url.toString()));
  await Promise.all(workers.map((worker,i)=>worker.withWorkspace(async()=>{
   const a=(await worker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   await business!.transaction(async tx=>{expect((await tx.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(a);await tx.query('INSERT INTO clients(id,name,phone) VALUES($1,$2,$3)',[randomUUID(),`Клиент ${i}`,`99655577${String(i).padStart(3,'0')}`])});
   await new Promise(r=>setTimeout(r,10));
  })));
  await expect(workers[0].withWorkspace(async()=>{await business!.query('SELECT 1');throw new Error('failed request')})).rejects.toThrow('failed request');
  expect((await db.query('SELECT * FROM clients')).rows).toHaveLength(20);
  await expect.poll(async()=>(await admin.query<{n:number}>('SELECT count(*)::integer AS n FROM pg_stat_activity WHERE usename=$1',[role])).rows[0].n,{timeout:2000}).toBe(0);
 }finally{
  await Promise.all(workers.map(worker=>worker.close()));await business?.close();vi.unstubAllEnvs();await db.exec(`DROP OWNED BY "${role}"`);await admin.query(`DROP ROLE "${role}"`);
 }
},30000);

it.skipIf(!enabled)('отложенный обработчик не переиспользует закрытое соединение завершённого запроса',async()=>{
 let delayed!:Promise<number>,first=0;
 await db.withWorkspace(async()=>{
  first=(await db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  delayed=new Promise<number>((resolve,reject)=>{setTimeout(()=>{db.withWorkspace(async()=>(await second.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid).then(resolve,reject)},20)});
 });
 expect(await delayed).not.toBe(first);
});

it.skipIf(!enabled)('конвейер сокращает ожидание сети, сохраняет типы и восстанавливается после ошибки чтения',async()=>{
 const target=new URL(process.env.KARVEN_PG_TEST_URL!);target.pathname=`/${database}`;
 const sockets=new Set<Socket>(),timers=new Set<ReturnType<typeof setTimeout>>();
 const later=(work:()=>void)=>{const timer=setTimeout(()=>{timers.delete(timer);work()},40);timers.add(timer)};
 const proxy=createServer(client=>{
  const upstream=createConnection({host:'127.0.0.1',port:55439});sockets.add(client);sockets.add(upstream);
  client.on('data',data=>later(()=>{if(!upstream.destroyed)upstream.write(data)}));upstream.on('data',data=>later(()=>{if(!client.destroyed)client.write(data)}));
  client.on('end',()=>later(()=>upstream.end()));upstream.on('end',()=>later(()=>client.end()));
  client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
  client.on('close',()=>sockets.delete(client));upstream.on('close',()=>sockets.delete(upstream));
 });
 await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));target.port=String((proxy.address() as AddressInfo).port);const delayed=new PostgresDatabase(target.toString());
 try{
  await delayed.withWorkspace(async()=>{
   const query=(i:number)=>delayed.query<{value:number;exact:string;at:Date}>("SELECT $1::integer AS value,9007199254740993::bigint AS exact,TIMESTAMPTZ '2026-01-01 00:00:00+00' AS at",[i]);
   let start=performance.now();const sequential=[];for(let i=0;i<8;i++)sequential.push((await query(i)).rows[0]);const serialMs=performance.now()-start;
   start=performance.now();const parallel=(await Promise.all(Array.from({length:8},(_,i)=>query(i)))).map(r=>r.rows[0]);const pipelineMs=performance.now()-start;
   expect(parallel).toEqual(sequential);expect(parallel[0].at).toBeInstanceOf(Date);expect(parallel[0].exact).toBe('9007199254740993');expect(pipelineMs).toBeLessThan(serialMs*0.75);
   console.info(`Latency simulation (40 ms each direction): sequential ${Math.round(serialMs)} ms, pipeline ${Math.round(pipelineMs)} ms`);
   const results=await Promise.allSettled([delayed.query('SELECT 1/0'),delayed.query('SELECT 42 AS n')]);expect(results[0].status).toBe('rejected');expect(results[1]).toMatchObject({status:'fulfilled',value:{rows:[{n:42}]}});
   expect((await delayed.query('SELECT 1 AS n')).rows).toEqual([{n:1}]);
  });
 }finally{
  await delayed.close();for(const timer of timers)clearTimeout(timer);for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>proxy.close(()=>resolve()));
 }
},15000);
it.skipIf(!enabled)('аддитивное обновление 9→10 сохраняет брони и суммы, повтор безопасен',async()=>{
 const {migrationV10}=await import('../src/lib/schema');const {privateAccessSql}=await import('../src/lib/postgres');const fresh=`${database}_upgrade`;await admin.query(`CREATE DATABASE "${fresh}"`);const url=new URL(process.env.KARVEN_PG_TEST_URL!);url.pathname=`/${fresh}`;const legacy=new PostgresDatabase(url.toString());
 try{await migratePostgres(legacy,schema.slice(0,schema.length-migrationV10.length));await seedOwner(legacy);const crm=createCrm(legacy,owner);const trip=await crm.createTrip({origin:'Бишкек',destination:'Талас',capacity:8,currency:'KGS',departureAt:new Date(Date.now()+86400000).toISOString()});
 // Seed the old layout, without using new payment metadata.
 const clientId=randomUUID(),bookingId=randomUUID();await legacy.query('INSERT INTO clients(id,name,phone) VALUES($1,$2,$3)',[clientId,'Старый клиент','996555777888']);await legacy.query('INSERT INTO bookings(id,trip_id,client_id,seats,total_minor) VALUES($1,$2,$3,2,100000)',[bookingId,trip,clientId]);await legacy.query("INSERT INTO payments(id,booking_id,amount_minor,method) VALUES($1,$2,40000,'cash')",[randomUUID(),bookingId]);
 await legacy.withWorkspace(()=>legacy.transaction(async tx=>{await tx.exec(migrationV10);await tx.exec(privateAccessSql)}));await legacy.transaction(tx=>tx.exec(migrationV10));expect(await checkPostgres(legacy)).toMatchObject({version:10});expect((await legacy.query('SELECT seats,total_minor,version FROM bookings WHERE id=$1',[bookingId])).rows[0]).toMatchObject({seats:2,total_minor:100000,version:1});expect((await legacy.query('SELECT amount_minor,created_by,shift_id FROM payments')).rows[0]).toMatchObject({amount_minor:40000,created_by:null,shift_id:null});
 }finally{await legacy.close();await admin.query(`DROP DATABASE IF EXISTS "${fresh}" WITH(FORCE)`)}
},30000);
it.skipIf(!enabled)('панель владельца и снимок PDF читают новую финансовую схему PostgreSQL',async()=>{
 const {createOwnerReports}=await import('../src/lib/owner-reports');const {loadOwnerView}=await import('../src/lib/owner-view');const {createCancellations}=await import('../src/lib/cancellations');const {reportDay}=await import('../src/lib/reporting');const crm=createCrm(db,owner),tripId=await crm.createTrip({origin:'Контроль PostgreSQL',destination:'Проверка владельца',capacity:8,currency:'KGS',departureAt:new Date(Date.now()+86400000).toISOString()}),id=await crm.createBooking({tripId,name:'Клиент владельца',phone:'+996555060606',seats:2,total:'800',initialPayment:'300'});await createCancellations(db,owner).cancel({bookingId:id,initiator:'park',reason:'Отмена отправления парком',requestId:randomUUID()});const day=reportDay(new Date().toISOString()),reports=createOwnerReports(db,owner),reportId=await reports.create({from:day,to:day,requestId:randomUUID()});const view=await db.withWorkspace(()=>loadOwnerView(db,owner,{booking:id}));expect(view.cancellations[0]).toMatchObject({outstanding_minor:30000});expect(view.selectedBooking?.id).toBe(id);expect(view.trips.find(t=>t.id===tripId)?.capacity).toBe(8);expect((await reports.read(reportId)).document.summary).toMatchObject([{received:30000,pendingReturns:30000}]);await db.exec('TRUNCATE report_documents,audit_events');expect((await reports.read(reportId)).document.id).toBe(reportId);
});
