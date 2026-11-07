import {beforeEach,afterEach,it,expect} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {PGlite} from '@electric-sql/pglite';
import {schema} from '../src/lib/schema';
import {createBackups} from '../src/lib/backups';
import {createCrm} from '../src/lib/crm';
import {hashPassword,verifyPassword} from '../src/lib/auth';
import {withWorkspace} from '../src/lib/workspace-lock';
import {owner,seedOwner} from './helpers';
let db:PGlite,root:string,backups:ReturnType<typeof createBackups>,tripId:string,bookingId:string;
const password='backup-owner-password-1234';
beforeEach(async()=>{root=await mkdtemp(path.join(tmpdir(),'karven-backup-test-'));db=new PGlite();await db.exec(schema);await seedOwner(db);await db.query('UPDATE users SET password_hash=$2 WHERE id=$1',[owner.id,await hashPassword(password)]);backups=createBackups(db,owner,root);const crm=createCrm(db,owner);tripId=await crm.createTrip({origin:'Бишкек',destination:'Ош',departureAt:new Date(Date.now()+86400000).toISOString(),capacity:4,currency:'KGS'});bookingId=await crm.createBooking({tripId,name:'Клиент копии',phone:'+996555123456',seats:1,total:'1000',initialPayment:'400'});},30000);
afterEach(async()=>{await db.close();await rm(root,{recursive:true,force:true})},30000);
const restore=(backupId:string,pwd=password)=>backups.restore({backupId,password:pwd,confirmation:'ВОССТАНОВИТЬ',confirmed:'yes',requestId:randomUUID()});
it('создаёт проверенную копию, сохраняет таблицы и точно повторяет запрос без дубликата',async()=>{
 const id=randomUUID(),info=await backups.create(id);expect(info).toMatchObject({id,status:'verified',kind:'manual',counts:{trips:1,bookings:1,payments:1,park_settings:1}});expect(info.verifiedAt).not.toBeNull();expect((await backups.download(id)).length).toBe(info.bytes);expect((await backups.create(id)).id).toBe(id);expect(await backups.list()).toHaveLength(1);expect((await backups.verify(id)).status).toBe('verified');
},30000);
it('восстанавливает данные атомарно, создаёт страховочную копию, сохраняет пароль владельца и завершает сеансы',async()=>{
 const copy=await backups.create(randomUUID());await createCrm(db,owner).addPayment({bookingId,amount:'100',method:'cash',requestId:randomUUID()});await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('test-token',$1,now()+interval '1 hour')",[owner.id]);const newPassword='changed-owner-password-1234';await db.query('UPDATE users SET password_hash=$2 WHERE id=$1',[owner.id,await hashPassword(newPassword)]);await restore(copy.id,newPassword);expect((await createCrm(db,owner).dashboard()).bookings[0].paid_minor).toBe(40000);expect((await db.query('SELECT * FROM sessions')).rows).toHaveLength(0);expect(await verifyPassword(newPassword,(await db.query<{password_hash:string}>('SELECT password_hash FROM users WHERE id=$1',[owner.id])).rows[0].password_hash)).toBe(true);const safety=(await backups.list()).find(b=>b.kind==='before_restore')!;expect(safety.status).toBe('verified');expect(safety.counts.payments).toBe(2);await restore(safety.id,newPassword);expect((await createCrm(db,owner).dashboard()).bookings[0].paid_minor).toBe(50000);
},60000);
it('повреждённая копия не скачивается и не восстанавливается, текущие деньги сохраняются',async()=>{
 const copy=await backups.create(randomUUID());await writeFile(path.join(root,copy.id,'snapshot.json'),'broken');await expect(backups.download(copy.id)).rejects.toThrow();await expect(restore(copy.id)).rejects.toThrow();await expect(backups.verify(copy.id)).rejects.toThrow('повреждена');expect((await backups.list())[0].status).toBe('failed');expect((await createCrm(db,owner).dashboard()).bookings[0].paid_minor).toBe(40000);
},30000);
it('проверка импортирует данные с FK: некорректные связи не проходят даже с новой контрольной суммой',async()=>{
 const copy=await backups.create(randomUUID()),file=path.join(root,copy.id,'snapshot.json'),meta=path.join(root,copy.id,'metadata.json');const payload=JSON.parse(await readFile(file,'utf8'));const rows=JSON.parse(payload.tables.bookings);rows[0].trip_id=randomUUID();payload.tables.bookings=JSON.stringify(rows);const bytes=JSON.stringify(payload);await writeFile(file,bytes);await writeFile(meta,JSON.stringify({...copy,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:Buffer.byteLength(bytes)}));await expect(backups.verify(copy.id)).rejects.toThrow();expect((await createCrm(db,owner).dashboard()).bookings).toHaveLength(1);
},30000);
it('ошибка вставки в действующую базу откатывает замену, страховочная копия остаётся',async()=>{
 const copy=await backups.create(randomUUID());await createCrm(db,owner).addPayment({bookingId,amount:'100',method:'cash',requestId:randomUUID()});await db.exec("CREATE FUNCTION reject_restore() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected write failure'; END $$; CREATE TRIGGER reject_restore BEFORE INSERT ON clients FOR EACH ROW EXECUTE FUNCTION reject_restore()");await expect(restore(copy.id)).rejects.toThrow();expect((await createCrm(db,owner).dashboard()).bookings[0].paid_minor).toBe(50000);expect((await backups.list()).filter(b=>b.kind==='before_restore')).toHaveLength(1);
},40000);
it('требует пароль и явное подтверждение, отклоняет пути и запрещает доступ другим ролям',async()=>{
 const copy=await backups.create(randomUUID());await expect(restore(copy.id,'wrong-password')).rejects.toThrow('пароль');await expect(backups.restore({backupId:copy.id,password,confirmation:'нет',confirmed:'yes',requestId:randomUUID()})).rejects.toThrow();await expect(backups.download('../secret')).rejects.toThrow();for(const role of ['dispatcher','driver'] as const){const denied=createBackups(db,{...owner,role},root);await expect(denied.list()).rejects.toThrow('прав');await expect(denied.create(randomUUID())).rejects.toThrow('прав');await expect(denied.download(copy.id)).rejects.toThrow('прав');await expect(denied.restore({})).rejects.toThrow('прав');}expect(await backups.list()).toHaveLength(1);
},30000);
it('очередь входных запросов сохраняет порядок и освобождается после ошибки',async()=>{
 const sequence:string[]=[];let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});const first=withWorkspace(async()=>{sequence.push('start');await gate;sequence.push('restore')});const next=withWorkspace(async()=>{sequence.push('next')});await Promise.resolve();expect(sequence).toEqual(['start']);release();await Promise.all([first,next]);expect(sequence).toEqual(['start','restore','next']);await expect(withWorkspace(async()=>{throw new Error('test')})).rejects.toThrow('test');expect(await withWorkspace(async()=>true)).toBe(true);
});
it('загружает скачанную копию в новую установку с тем же логином и другим UUID владельца',async()=>{
 const copy=await backups.create(randomUUID()),bytes=await backups.download(copy.id),newDb=new PGlite(),newOwner={...owner,id:randomUUID()};
 try{await newDb.exec(schema);await newDb.query("INSERT INTO users(id,name,username,password_hash,role) VALUES($1,$2,$3,$4,'owner')",[newOwner.id,newOwner.name,newOwner.username,await hashPassword(password)]);const imported=createBackups(newDb,newOwner,path.join(root,'new-installation')),id=randomUUID();const info=await imported.importFile(bytes,id);expect((await imported.importFile(bytes,id)).id).toBe(info.id);await imported.restore({backupId:info.id,password,confirmation:'ВОССТАНОВИТЬ',confirmed:'yes',requestId:randomUUID()});expect((await createCrm(newDb,owner).dashboard()).bookings[0].paid_minor).toBe(40000);expect((await newDb.query<{id:string}>('SELECT id FROM users WHERE username=$1',[owner.username])).rows[0].id).toBe(owner.id);expect(await verifyPassword(password,(await newDb.query<{password_hash:string}>('SELECT password_hash FROM users WHERE id=$1',[owner.id])).rows[0].password_hash)).toBe(true);
 }finally{await newDb.close()}
},40000);
