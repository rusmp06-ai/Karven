import pg from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {PoolClient,PoolConfig} from 'pg';
import {readFileSync} from 'node:fs';
import {rootCertificates} from 'node:tls';
import {supabaseRootCa} from './supabase-ca.mjs';
import {X509Certificate} from 'node:crypto';
import type {Database,DbTransaction} from './database-types';
const writeLock='746376001',applicationLock='746376002';
export class DatabaseSetupError extends Error {}
type RequestConnection={active:boolean;lost:boolean;client:PoolClient;connectionKey:string;inTransaction:boolean};
const lockState=globalThis as typeof globalThis&{karvenPgLockContext?:AsyncLocalStorage<RequestConnection>};
const lockContext=lockState.karvenPgLockContext??=new AsyncLocalStorage<RequestConnection>();
function checkRequestLock(){const scope=lockContext.getStore();if(scope?.active&&scope.lost)throw new DatabaseSetupError('Соединение блокировки запроса прервано. Повторите операцию')}
export function postgresConfig(connectionString:string):PoolConfig{
 let url:URL;try{url=new URL(connectionString)}catch{throw new DatabaseSetupError('Проверьте DATABASE_URL: требуется строка PostgreSQL из Connect')}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||!url.pathname.slice(1))throw new DatabaseSetupError('DATABASE_URL должен содержать PostgreSQL host, user и database');
 if(url.hostname.endsWith('.pooler.supabase.com')&&url.port==='6543')throw new DatabaseSetupError('Выберите Supabase Session pooler, порт 5432, вместо Transaction pooler');
 const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 // URL sslmode=require must not silently disable certificate verification.
 url.search='';
 let ca:string|undefined;
 try{
  if(process.env.PGSSLROOTCERT_PEM)ca=process.env.PGSSLROOTCERT_PEM.replace(/\\n/g,'\n').trim();
  else if(process.env.PGSSLROOTCERT)ca=readFileSync(process.env.PGSSLROOTCERT,'utf8');
  if(ca)new X509Certificate(ca);
 }catch{throw new DatabaseSetupError('Не удалось прочитать сертификат PostgreSQL. Проверьте PGSSLROOTCERT_PEM или файл PGSSLROOTCERT')}
 const supabase=url.hostname.endsWith('.pooler.supabase.com')||url.hostname.endsWith('.supabase.co');
 const trustedCa=ca??(supabase?[...rootCertificates,supabaseRootCa]:undefined);
 return {connectionString:url.toString(),ssl:local?false:{rejectUnauthorized:true,...(trustedCa?{ca:trustedCa}:{})},max:2,allowExitOnIdle:true,connectionTimeoutMillis:10000,idleTimeoutMillis:10000,application_name:'karven-crm'};
}
function transactionClient(client:PoolClient):DbTransaction{return {
 async query<T>(sql:string,params?:unknown[]){checkRequestLock();const result=await client.query(sql,params);checkRequestLock();return {rows:result.rows as T[]}},
 async exec(sql:string){checkRequestLock();await client.query(sql);checkRequestLock()},
};}
export class PostgresDatabase implements Database {
 readonly kind='postgres' as const;
 private pool:pg.Pool;
 private lease:PoolClient|null=null;
 private leaseLost=false;
 private initialized=new WeakSet<PoolClient>();
 private ephemeral=process.env.CRM_DEPLOYMENT==='netlify'||process.env.NETLIFY==='true';
 private connectionKey:string;
 constructor(connectionKey:string){this.connectionKey=connectionKey;this.pool=new pg.Pool(postgresConfig(connectionKey));this.pool.on('error',()=>{console.error('PostgreSQL idle connection error')});this.pool.on('connect',client=>{client.on('error',()=>{if(client===this.lease)this.leaseLost=true})});}
 private async release(client:PoolClient,destroy:boolean){
  if(!destroy){client.release();return}
  try{await client.end()}finally{client.release(true)}
 }
 private requestScope(){const scope=lockContext.getStore();return scope?.active&&scope.connectionKey===this.connectionKey?scope:undefined}
 private async connect(){
  if(this.leaseLost)throw new DatabaseSetupError('Связь с базой прервана. Перезапустите сервер CRM');
  checkRequestLock();const client=await this.pool.connect();
  try{
   if(!this.initialized.has(client)){
    await client.query("SET search_path TO karven,pg_catalog;SET TIME ZONE 'UTC';SET statement_timeout='30s'"+(this.ephemeral?";SET idle_session_timeout='30s';SET idle_in_transaction_session_timeout='30s'":""));
    this.initialized.add(client);
   }
   return client;
  }catch(error){await this.release(client,true);throw error}
 }
 async query<T=Record<string,unknown>>(sql:string,params?:unknown[]){
  const scope=this.requestScope();if(scope)return transactionClient(scope.client).query<T>(sql,params);
  const client=await this.connect();try{return await transactionClient(client).query<T>(sql,params)}finally{await this.release(client,this.ephemeral)}
 }
 async exec(sql:string){
  const scope=this.requestScope();if(scope)return transactionClient(scope.client).exec(sql);
  const client=await this.connect();try{await transactionClient(client).exec(sql)}finally{await this.release(client,this.ephemeral)}
 }
 // A restore safety copy must survive rollback of the business transaction.
 async independentQuery<T=Record<string,unknown>>(sql:string,params?:unknown[]){
  if(!this.requestScope()?.inTransaction)return this.query<T>(sql,params);
  const client=await this.connect();try{return await transactionClient(client).query<T>(sql,params)}finally{await this.release(client,true)}
 }
 async transaction<T>(work:(tx:DbTransaction)=>Promise<T>):Promise<T>{
  const scope=this.requestScope();if(scope?.inTransaction)throw new DatabaseSetupError('Вложенная транзакция PostgreSQL не поддерживается');
  const client=scope?.client??await this.connect();let broken=false;
  if(scope)scope.inTransaction=true;
  try{
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[writeLock]);
   const result=await work(transactionClient(client));checkRequestLock();await client.query('COMMIT');return result;
  }catch(error){try{await client.query('ROLLBACK')}catch{broken=true;if(scope)scope.lost=true}throw error}
  finally{if(scope)scope.inTransaction=false;else await this.release(client,broken||this.ephemeral)}
 }
 async withWorkspace<T>(work:()=>Promise<T>):Promise<T>{
  if(this.requestScope())return work();
  const deadline=Date.now()+8000;
  let acquired:PoolClient|undefined;
  // Waiting sessions must not occupy the whole Session pooler while the owner
  // needs a connection. Unsuccessful contenders disconnect before backing off.
  for(;;){
   let candidate:PoolClient|undefined;
   try{
    candidate=await this.connect();
    const result=await candidate.query<{locked:boolean}>('SELECT pg_try_advisory_lock($1::bigint) AS locked',[applicationLock]);
    if(result.rows[0].locked){acquired=candidate;break}
   }catch(error){
    const message=error instanceof Error?error.message:'';
    if(!/EMAXCONNSESSION|max clients reached|too many (?:clients|connections)/i.test(message))throw error;
   }finally{if(candidate&&candidate!==acquired)await this.release(candidate,true)}
   if(Date.now()>=deadline)throw new DatabaseSetupError('Сервис занят. Повторите запрос через несколько секунд');
   await new Promise(resolve=>setTimeout(resolve,100+Math.floor(Math.random()*150)));
  }
  const client=acquired!;const scope:RequestConnection={active:true,lost:false,client,connectionKey:this.connectionKey,inTransaction:false};const lost=()=>{scope.lost=true};client.on('error',lost);
  try{return await lockContext.run(scope,async()=>{checkRequestLock();const result=await work();checkRequestLock();return result})}
  finally{
   scope.active=false;
   try{await client.query('SELECT pg_advisory_unlock($1::bigint)',[applicationLock])}catch{/* the socket is discarded below */}
   client.removeListener('error',lost);
   // Destroy the socket now: Lambda can freeze before an idle JS timer fires.
   await this.release(client,true);
  }
 }
 async acquireApplicationLease(){
  if(this.lease)return;const client=await this.connect();
  try{const result=await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock($1::bigint) AS locked',[applicationLock]);if(!result.rows[0].locked)throw new DatabaseSetupError('Эта база уже открыта другим сервером CRM. Остановите его перед переключением');this.lease=client}
  catch(error){await this.release(client,true);throw error}
 }
 async releaseApplicationLease(){if(this.lease){const client=this.lease;this.lease=null;try{await client.query('SELECT pg_advisory_unlock($1::bigint)',[applicationLock]);await this.release(client,this.ephemeral)}catch{await this.release(client,true)}}}
 async close(){await this.releaseApplicationLease();await this.pool.end()}
}

export async function migratePostgres(db:PostgresDatabase,schema:string){
 await db.acquireApplicationLease();
 try{await db.transaction(async tx=>{
  await tx.exec('CREATE SCHEMA IF NOT EXISTS karven; REVOKE ALL ON SCHEMA karven FROM PUBLIC');
  await tx.exec(schema);
  await tx.exec(archiveSchema);
  await tx.exec(privateAccessSql);
 })}finally{await db.releaseApplicationLease()}
}
export async function checkPostgres(db:PostgresDatabase){
 const result=await db.query<{schema:string;version:number}>("SELECT current_schema() AS schema,(SELECT max(version)::integer FROM schema_migrations) AS version");
 if(result.rows[0]?.schema!=='karven'||result.rows[0]?.version!==9)throw new DatabaseSetupError('База CRM не подготовлена. Выполните npm run db:migrate');
 await db.query('SELECT id FROM karven_archive.backups LIMIT 0');
 return {schema:'karven',version:9};
}

export const archiveSchema=`CREATE SCHEMA IF NOT EXISTS karven_archive;
 CREATE TABLE IF NOT EXISTS karven_archive.backups(id uuid PRIMARY KEY,metadata jsonb NOT NULL,payload bytea NOT NULL CHECK(octet_length(payload)<=67108864));
 ALTER TABLE karven_archive.backups ENABLE ROW LEVEL SECURITY;`;
export const privateAccessSql=`REVOKE ALL ON ALL TABLES IN SCHEMA karven FROM PUBLIC;REVOKE ALL ON SCHEMA karven_archive FROM PUBLIC;REVOKE ALL ON ALL TABLES IN SCHEMA karven_archive FROM PUBLIC;
   DO $$ DECLARE role_name text; table_name text; BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
     IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA karven FROM %I',role_name);EXECUTE format('REVOKE ALL ON SCHEMA karven_archive FROM %I',role_name);EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA karven_archive FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA karven FROM %I',role_name);
     END IF;
    END LOOP;
    FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname='karven' LOOP EXECUTE format('ALTER TABLE karven.%I ENABLE ROW LEVEL SECURITY',table_name); END LOOP;
   END $$;`;
export function migrationSql(schema:string){return `-- KARVEN: выполнить целиком как один запрос. RLS включается внутри блока.
DO $karven_install$
BEGIN
 PERFORM pg_advisory_xact_lock(${applicationLock}::bigint);
 EXECUTE 'CREATE SCHEMA IF NOT EXISTS karven';
 EXECUTE 'REVOKE ALL ON SCHEMA karven FROM PUBLIC';
 PERFORM set_config('search_path','karven,pg_catalog',true);
 EXECUTE $karven_schema$
${schema}
$karven_schema$;
 EXECUTE $karven_archive$
${archiveSchema}
$karven_archive$;
 EXECUTE $karven_access$
${privateAccessSql}
$karven_access$;
 RAISE NOTICE 'KARVEN: installation complete, schema version 9';
END
$karven_install$;
`}
