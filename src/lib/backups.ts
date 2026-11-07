import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,readdir,stat,open,rm,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {PGlite} from '@electric-sql/pglite';
import {z} from 'zod';
import {schema} from './schema';
import {BusinessError} from './crm';
import {requireRole,type Actor} from './access';
import {verifyPassword} from './auth';
import {recordAudit,type Tx} from './audit';
import {once} from './idempotency';
import type {BackupInfo} from './backup-types';
// Dependency order, used for a complete logical restore with FK checks enabled.
export const backupTables=['schema_migrations','drivers','vehicles','users','clients','trips','bookings','mutation_receipts','payments','refunds','trip_expenses','driver_settlements','driver_payouts','passenger_attendance','audit_events','client_notes','work_tasks','park_settings','route_templates'] as const;
const allTables=[...backupTables,'sessions','login_attempts'];
const maximumBytes=64*1024*1024;
const metadataInput=z.object({id:z.uuid(),createdBy:z.uuid(),createdAt:z.iso.datetime(),kind:z.enum(['manual','before_restore','imported']),status:z.enum(['creating','verified','failed']),verifiedAt:z.iso.datetime().nullable(),restoredAt:z.iso.datetime().optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().min(0).max(maximumBytes),counts:z.record(z.string(),z.number().int().min(0)),error:z.string().max(256).optional()});
const payloadInput=z.object({format:z.literal('karven-backup'),formatVersion:z.literal(1),schemaVersion:z.literal(8),createdAt:z.iso.datetime(),layout:z.record(z.string(),z.array(z.string())),tables:z.record(z.string(),z.string())}).strict();
type Snapshot=z.infer<typeof payloadInput>;
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export function backupDirectory(){return path.resolve(process.env.CRM_BACKUP_DIR||(process.env.DATABASE_DIR?`${process.env.DATABASE_DIR}-backups`:path.join(process.cwd(),'data','backups')))}
async function syncDirectory(directory:string){
 let handle:Awaited<ReturnType<typeof open>>|undefined;
 try{handle=await open(directory,'r');await handle.sync()}
 catch(error){if(process.platform!=='win32'||!['EPERM','EISDIR','EINVAL','ENOTSUP'].includes((error as NodeJS.ErrnoException).code??''))throw error}
 finally{await handle?.close()}
}
async function atomicFile(filename:string,data:string|Uint8Array){
 const temp=`${filename}.${randomUUID()}.tmp`;const handle=await open(temp,'wx',0o600);
 try{await handle.writeFile(data);await handle.sync()}finally{await handle.close()}
 try{await rename(temp,filename);await syncDirectory(path.dirname(filename))}finally{await rm(temp,{force:true})}
}
function location(root:string,id:string){return path.join(root,z.uuid().parse(id))}
async function columns(db:Tx|PGlite){
 const rows=(await db.query<{table_name:string;column_name:string;udt_name:string}>("SELECT table_name,column_name,udt_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
 const result:Record<string,string[]>={};for(const row of rows)(result[row.table_name]??=[]).push(`${row.column_name}:${row.udt_name}`);
 if(JSON.stringify(Object.keys(result).sort())!==JSON.stringify([...allTables].sort()))throw new BusinessError('Структура базы не поддерживается этой версией резервного копирования');
 return result;
}
async function capture(db:Tx|PGlite):Promise<Snapshot>{
 const versions=(await db.query<{version:number}>('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r=>r.version);
 if(JSON.stringify(versions)!==JSON.stringify([1,2,3,4,5,6,7,8]))throw new BusinessError('Версия базы несовместима с резервным копированием');
 const layout=await columns(db),tables:Record<string,string>={};
 // Keep PostgreSQL JSON as text, preserving bigint values without JS rounding.
 for(const table of backupTables)tables[table]=(await db.query<{data:string}>(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS data FROM "${table}" t`)).rows[0].data;
 return {format:'karven-backup',formatVersion:1,schemaVersion:8,createdAt:new Date().toISOString(),layout,tables};
}
async function replace(db:Tx,snapshot:Snapshot){
 if(JSON.stringify(await columns(db))!==JSON.stringify(snapshot.layout))throw new BusinessError('Структура копии несовместима с приложением');
 if(JSON.stringify(Object.keys(snapshot.tables).sort())!==JSON.stringify([...backupTables].sort()))throw new BusinessError('В копии отсутствуют необходимые таблицы');
 await db.exec(`TRUNCATE ${allTables.map(t=>`"${t}"`).join(',')}`);
 for(const table of backupTables)await db.query(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_recordset(NULL::"${table}",$1::jsonb)`,[snapshot.tables[table]]);
}
async function checks(db:Tx|PGlite){
 const layout=await columns(db),extra:string[]=[];
 for(const [table,fields] of Object.entries(layout))for(const field of fields){const [name,type]=field.split(':');
  if(['date','timestamp','timestamptz'].includes(type))extra.push(`EXISTS(SELECT 1 FROM "${table}" WHERE "${name}" IS NOT NULL AND (NOT isfinite("${name}") OR "${name}" < TIMESTAMP '0001-01-01' OR "${name}" >= TIMESTAMP '10000-01-01'))`);
  if(type==='int8')extra.push(`EXISTS(SELECT 1 FROM "${table}" WHERE "${name}" NOT BETWEEN -9007199254740991 AND 9007199254740991)`);
 }
 if((await db.query<{invalid:boolean}>(`SELECT ${extra.join(' OR ')} AS invalid`)).rows[0].invalid)throw new BusinessError('Копия содержит неподдерживаемые даты или числовые значения');
 const invalid=(await db.query<{invalid:boolean}>(`SELECT
 NOT EXISTS(SELECT 1 FROM users WHERE role='owner' AND active) OR
 (SELECT count(*) FROM park_settings)<>1 OR
 EXISTS(SELECT 1 FROM audit_events WHERE jsonb_typeof(details)<>'object') OR
 EXISTS(SELECT 1 FROM bookings b CROSS JOIN LATERAL jsonb_array_elements(b.passengers) p WHERE jsonb_typeof(p)<>'object' OR jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'phone') IS DISTINCT FROM 'string') OR
 EXISTS(SELECT t.id FROM trips t JOIN bookings b ON b.trip_id=t.id AND b.status='confirmed' GROUP BY t.id,t.capacity HAVING SUM(b.seats)>t.capacity) OR
 EXISTS(SELECT b.id FROM bookings b WHERE (SELECT COALESCE(SUM(amount_minor),0) FROM refunds WHERE booking_id=b.id)>(SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE booking_id=b.id)) OR
 EXISTS(SELECT b.id FROM bookings b WHERE (SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE booking_id=b.id)>b.total_minor) OR
 EXISTS(SELECT b.id FROM bookings b JOIN trips t ON t.id=b.trip_id WHERE b.status='confirmed' AND (b.passenger_count>t.capacity OR b.child_seats>b.passenger_count OR t.status='cancelled')) OR
 EXISTS(SELECT a.booking_id FROM passenger_attendance a JOIN bookings b ON b.id=a.booking_id WHERE a.position>=b.passenger_count) OR
 EXISTS(SELECT s.trip_id FROM driver_settlements s WHERE (SELECT COALESCE(SUM(amount_minor),0) FROM driver_payouts WHERE trip_id=s.trip_id)>s.fee_minor+s.reimbursement_minor)
 AS invalid`)).rows[0].invalid;
 if(invalid)throw new BusinessError('Копия не прошла проверку связности данных и расчётов');
}
async function verifySnapshot(snapshot:Snapshot){
 const directory=await mkdtemp(path.join(tmpdir(),'karven-restore-check-'));let db:PGlite|undefined;
 try{
  db=new PGlite(path.join(directory,'postgres'));await db.exec(schema);
  await db.transaction(tx=>replace(tx,snapshot));await db.close();db=undefined;
  db=new PGlite(path.join(directory,'postgres'));await checks(db);
  const actual=await capture(db);
  if(JSON.stringify(actual.tables)!==JSON.stringify(snapshot.tables))throw new BusinessError('Данные после пробного восстановления не совпадают с копией');
  const counts:Record<string,number>={};for(const table of backupTables)counts[table]=(await db.query<{n:number}>(`SELECT count(*)::integer AS n FROM "${table}"`)).rows[0].n;
  return counts;
 }finally{try{if(db)await db.close()}finally{await rm(directory,{recursive:true,force:true})}}
}
export function createBackups(db:PGlite,actor:Actor,root=backupDirectory()){
 const access=()=>requireRole(actor,'owner');
 async function metadata(id:string):Promise<BackupInfo>{
  const dir=location(root,id);
  try{const value=metadataInput.parse(JSON.parse(await readFile(path.join(dir,'metadata.json'),'utf8')));if(value.id!==id)throw new Error();return value}catch{throw new BusinessError('Резервная копия не найдена или её описание повреждено')}
 }
 async function saveMeta(info:BackupInfo){await atomicFile(path.join(location(root,info.id),'metadata.json'),JSON.stringify(info))}
 async function load(id:string){
  const info=await metadata(id),filename=path.join(location(root,id),'snapshot.json');
  const file=await stat(filename);if(file.size>maximumBytes||file.size!==info.bytes)throw new BusinessError('Размер резервной копии не совпадает с описанием');
  const bytes=await readFile(filename);if(hash(bytes)!==info.sha256)throw new BusinessError('Контрольная сумма не совпала. Копия повреждена');
  return {info,bytes,snapshot:payloadInput.parse(JSON.parse(bytes.toString('utf8')))};
 }
 async function persist(snapshot:Snapshot,id:string,kind:BackupInfo['kind']):Promise<BackupInfo>{
  const bytes=Buffer.from(JSON.stringify(snapshot));if(bytes.length>maximumBytes)throw new BusinessError('Размер копии превышает поддерживаемые 64 МБ');
  await mkdir(root,{recursive:true,mode:0o700});await syncDirectory(path.dirname(root));await mkdir(location(root,id),{mode:0o700});await syncDirectory(root);
  const info:BackupInfo={id,createdBy:actor.id,createdAt:snapshot.createdAt,kind,status:'creating',verifiedAt:null,sha256:hash(bytes),bytes:bytes.length,counts:{}};
  await saveMeta(info);
  try{await atomicFile(path.join(location(root,id),'snapshot.json'),bytes);info.counts=await verifySnapshot(snapshot);info.status='verified';info.verifiedAt=new Date().toISOString();await saveMeta(info);return info}
  catch{info.status='failed';info.error='Не удалось проверить восстановление этой копии';await saveMeta(info);throw new BusinessError(info.error)}
 }
 return {
  async list():Promise<BackupInfo[]>{
   access();let entries;try{entries=await readdir(root,{withFileTypes:true})}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error}
   const rows:BackupInfo[]=[];for(const entry of entries){if(!entry.isDirectory()||!z.uuid().safeParse(entry.name).success)continue;try{rows.push(await metadata(entry.name))}catch{rows.push({id:entry.name,createdBy:'',createdAt:'',kind:'manual',status:'failed',verifiedAt:null,sha256:'',bytes:0,counts:{},error:'Описание копии повреждено'})}}
   return rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
  },
  async create(requestId:string){
   access();const id=z.uuid().parse(requestId);try{const existing=await metadata(id);if(existing.createdBy!==actor.id||existing.kind!=='manual')throw new BusinessError('Этот идентификатор копии уже используется');if(existing.status==='verified'){await load(id);return existing}throw new BusinessError('Копия с этим идентификатором уже существует. Обновите страницу.')}catch(error){if(error instanceof BusinessError&&!error.message.startsWith('Резервная копия не найдена'))throw error;}
   const snapshot=await db.transaction(tx=>capture(tx));const info=await persist(snapshot,id,'manual');await db.transaction(tx=>recordAudit(tx,actor,id,'backup.created',{sha256:info.sha256,counts:info.counts}));return info;
  },
  async importFile(bytes:Uint8Array,requestId:string){
   access();const id=z.uuid().parse(requestId);if(bytes.length>maximumBytes)throw new BusinessError('Размер копии превышает поддерживаемые 64 МБ');
   const snapshot=payloadInput.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
   try{const existing=await metadata(id);if(existing.createdBy!==actor.id||existing.kind!=='imported'||existing.sha256!==hash(Buffer.from(JSON.stringify(snapshot))))throw new BusinessError('Идентификатор копии уже используется');if(existing.status!=='verified')throw new BusinessError('Загрузка не завершена. Обновите страницу.');await load(id);return existing}catch(error){if(error instanceof BusinessError&&!error.message.startsWith('Резервная копия не найдена'))throw error;}
   const info=await persist(snapshot,id,'imported');await db.transaction(tx=>recordAudit(tx,actor,id,'backup.imported',{sha256:info.sha256}));return info;
  },
  async verify(id:string){
   access();z.uuid().parse(id);let info=await metadata(id);
   try{const loaded=await load(id);info={...loaded.info,counts:await verifySnapshot(loaded.snapshot),status:'verified',verifiedAt:new Date().toISOString(),error:undefined};await saveMeta(info);await db.transaction(tx=>recordAudit(tx,actor,id,'backup.verified'));return info}
   catch{info.status='failed';info.error='Копия повреждена или пробное восстановление не прошло';await saveMeta(info);throw new BusinessError(info.error)}
  },
  async download(id:string){access();const loaded=await load(id);if(loaded.info.status!=='verified')throw new BusinessError('Сначала успешно проверьте копию');return loaded.bytes;},
  async restore(raw:unknown){
   access();const input=z.object({backupId:z.uuid(),password:z.string().min(1).max(128),confirmation:z.literal('ВОССТАНОВИТЬ'),confirmed:z.literal('yes'),requestId:z.uuid()}).parse(raw);
   const current=(await db.query<{password_hash:string;active:boolean;role:string}>('SELECT password_hash,active,role FROM users WHERE id=$1',[actor.id])).rows[0];
   if(!current||!current.active||current.role!=='owner'||!await verifyPassword(input.password,current.password_hash))throw new BusinessError('Не удалось подтвердить пароль владельца');
   const loaded=await load(input.backupId);if(loaded.info.status!=='verified')throw new BusinessError('Сначала успешно проверьте копию');
   await verifySnapshot(loaded.snapshot);
   // Match the owner by login, allowing a fresh installation to have a different UUID.
   const users=JSON.parse(loaded.snapshot.tables.users) as {id:string;username:string;role:string;active:boolean}[];
   const targetOwner=users.find(u=>u.username===actor.username&&u.role==='owner'&&u.active);
   if(!targetOwner)throw new BusinessError('В копии нет действующего владельца с вашим логином');
   const restoredActor={...actor,id:targetOwner.id};
   await db.transaction(tx=>once(tx,restoredActor,input.requestId,'backup.restore',{backupId:input.backupId},async()=>{
    // The safety copy is durable and verified before any current rows are replaced.
    const safety=await persist(await capture(tx),randomUUID(),'before_restore');
    await replace(tx,loaded.snapshot);
    await tx.query('UPDATE users SET password_hash=$2 WHERE id=$1',[restoredActor.id,current.password_hash]);
    await checks(tx);
    await recordAudit(tx,restoredActor,input.backupId,'backup.restored',{safetyId:safety.id,requestId:input.requestId});
   }));
   try{await saveMeta({...loaded.info,restoredAt:new Date().toISOString()})}catch{console.error('Backup restore metadata update failed')}
  },
 };
}
