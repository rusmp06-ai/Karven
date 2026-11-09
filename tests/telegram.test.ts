import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {schema} from '../src/lib/schema';
import {createCrm} from '../src/lib/crm';
import {createTelegram,deliverNextTelegram,sendTelegram,type TelegramTransport} from '../src/lib/telegram';
import {createBackups} from '../src/lib/backups';
import {owner,seedOwner} from './helpers';
let db:PGlite,root:string,tripId:string;
const token='123456789:'+('A'.repeat(35)),chatId='-1001234567890';
beforeEach(async()=>{root=await mkdtemp(path.join(tmpdir(),'karven-telegram-test-'));vi.stubEnv('CRM_TELEGRAM_KEY_FILE',path.join(root,'telegram.key'));db=new PGlite();await db.exec(schema);await seedOwner(db);tripId=await createCrm(db,owner).createTrip({origin:'Бишкек',destination:'Нарын',departureAt:new Date(Date.now()+86400000).toISOString(),capacity:6,currency:'KGS'});},30000);
afterEach(async()=>{await db.close();vi.unstubAllEnvs();vi.unstubAllGlobals();await rm(root,{recursive:true,force:true})},30000);
const config=(version=1)=>({token,chatId,enabled:'true',version,requestId:randomUUID()});
const booking=()=>({tripId,name:'Клиент Telegram',phone:'+996555999777',seats:2,total:'1500',initialPayment:'500',requestId:randomUUID()});
it('хранит зашифрованный токен, не отдаёт его клиенту или в журнал; пустое поле сохраняет токен',async()=>{
 const service=createTelegram(db,owner);await service.save(config());const stored=(await db.query<{encrypted_token:string}>('SELECT encrypted_token FROM telegram_settings')).rows[0].encrypted_token;expect(stored).not.toContain(token);expect(stored.startsWith('v1.')).toBe(true);expect((await readFile(path.join(root,'telegram.key'))).length).toBe(32);expect(JSON.stringify(await service.view())).not.toContain(token);expect(JSON.stringify((await db.query('SELECT * FROM audit_events')).rows)).not.toContain(token);await service.save({...config(2),token:''});expect((await db.query<{encrypted_token:string}>('SELECT encrypted_token FROM telegram_settings')).rows[0].encrypted_token).toBe(stored);
});
it('очередь создаётся в транзакции брони один раз, сообщение содержит маршрут, оплату и остаток',async()=>{
 await createTelegram(db,owner).save(config());const crm=createCrm(db,owner),raw=booking(),id=await crm.createBooking(raw);expect(await crm.createBooking(raw)).toBe(id);const send=vi.fn<TelegramTransport>().mockResolvedValue({status:'sent'});expect(await deliverNextTelegram(db,send)).toBe(true);expect(await deliverNextTelegram(db,send)).toBe(false);expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0].slice(0,2)).toEqual([token,chatId]);expect(send.mock.calls[0][2]).toContain('Бишкек → Нарын');expect(send.mock.calls[0][2]).toContain('Стоимость: 1500.00 KGS');expect(send.mock.calls[0][2]).toContain('Оплачено: 500.00 KGS');expect(send.mock.calls[0][2]).toContain('Остаток: 1000.00 KGS');expect((await createTelegram(db,owner).view()).deliveries[0].status).toBe('sent');
});
it('откат не создаёт уведомление; выключенное подключение не ставит старые брони в очередь',async()=>{
 const crm=createCrm(db,owner);await crm.createBooking(booking());expect((await db.query('SELECT * FROM telegram_outbox')).rows).toHaveLength(0);await createTelegram(db,owner).save(config());await expect(crm.createBooking({...booking(),seats:5})).rejects.toThrow();expect((await db.query('SELECT * FROM telegram_outbox')).rows).toHaveLength(0);
});
it('неподтверждённая доставка не откатывает бронь и не повторяется автоматически; ручной повтор требует подтверждения',async()=>{
 const service=createTelegram(db,owner);await service.save(config());const id=await createCrm(db,owner).createBooking(booking());await deliverNextTelegram(db,async()=>({status:'unknown',error:'Нет подтверждения'}));expect((await service.view()).deliveries[0].status).toBe('unknown');expect((await createCrm(db,owner).dashboard()).bookings).toHaveLength(1);expect(await deliverNextTelegram(db,async()=>({status:'sent'}))).toBe(false);await expect(service.retry({bookingId:id,requestId:randomUUID()})).rejects.toThrow();await service.retry({bookingId:id,confirmed:'yes',requestId:randomUUID()});await deliverNextTelegram(db,async()=>({status:'sent'}));expect((await service.view()).deliveries[0].status).toBe('sent');
});
it('учитывает задержку Telegram 429, смена подключения отменяет старую очередь, роли ограничены',async()=>{
 const service=createTelegram(db,owner);await service.save(config());await createCrm(db,owner).createBooking(booking());await deliverNextTelegram(db,async()=>({status:'retry',retryAfter:60,error:'Лимит'}));expect((await service.view()).deliveries[0]).toMatchObject({status:'pending',attempts:1});expect(await deliverNextTelegram(db,async()=>({status:'sent'}))).toBe(false);await service.save({...config(2),enabled:'false',token:''});expect((await service.view()).deliveries[0].status).toBe('cancelled');await service.save({...config(3),token:''});const cancelled=(await service.view()).deliveries[0];await service.retry({bookingId:cancelled.booking_id,confirmed:'yes',requestId:randomUUID()});await deliverNextTelegram(db,async()=>({status:'sent'}));expect((await service.view()).deliveries[0].status).toBe('sent');for(const role of ['driver','dispatcher'] as const){const denied=createTelegram(db,{...owner,role});await expect(denied.view()).rejects.toThrow('прав');await expect(denied.save(config())).rejects.toThrow('прав');await expect(denied.test()).rejects.toThrow('прав');}
});
it('тест отправляется только в сохранённый чат, отключение удаляет токен',async()=>{
 const send=vi.fn<TelegramTransport>().mockResolvedValue({status:'sent'}),service=createTelegram(db,owner,send);await service.save({...config(),enabled:'false'});await service.test();expect(send.mock.calls[0][1]).toBe(chatId);expect((await service.view()).lastTestError).toBeNull();await service.disconnect({version:2,requestId:randomUUID()});expect(await service.view()).toMatchObject({enabled:false,tokenConfigured:false,chatId:''});
});
it('копии не содержат токен, ID чата и очередь Telegram',async()=>{
 await createTelegram(db,owner).save(config());await createCrm(db,owner).createBooking(booking());const backups=createBackups(db,owner,path.join(root,'backups')),info=await backups.create(randomUUID()),bytes=(await backups.download(info.id)).toString('utf8'),payload=JSON.parse(bytes);expect(bytes).not.toContain(token);expect(bytes).not.toContain(chatId);expect(payload.tables.telegram_settings).toBeUndefined();expect(payload.tables.telegram_outbox).toBeUndefined();
},30000);
it('HTTP-ответы Telegram классифицируются без сохранения описания с секретом',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:401,json:async()=>({ok:false,error_code:401,description:token})}));expect(await sendTelegram(token,chatId,'test')).toEqual({status:'failed',error:'Telegram отклонил токен бота'});vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error(token)));expect(JSON.stringify(await sendTelegram(token,chatId,'test'))).not.toContain(token);
});
it('уведомляет о регистрации даже при быстрой отмене, сохраняя первоначальные суммы',async()=>{
 await createTelegram(db,owner).save(config());const id=await createCrm(db,owner).createBooking(booking());const {createCancellations}=await import('../src/lib/cancellations');await createCancellations(db,owner).cancel({bookingId:id,initiator:'client',reason:'Клиент отменил поездку',requestId:randomUUID()});const send=vi.fn<TelegramTransport>().mockResolvedValue({status:'sent'});await deliverNextTelegram(db,send);expect(send.mock.calls[0][2]).toContain('Стоимость: 1500.00 KGS');expect(send.mock.calls[0][2]).toContain('бронь уже отменена');
});

it('serverless использует постоянный ключ среды без локального файла и сохраняет расшифровку в следующем вызове',async()=>{
 vi.stubEnv('CRM_DEPLOYMENT','netlify');vi.stubEnv('CRM_TELEGRAM_KEY','ab'.repeat(32));
 await createTelegram(db,owner).save(config());await expect(readFile(path.join(root,'telegram.key'))).rejects.toMatchObject({code:'ENOENT'});
 const send=vi.fn<TelegramTransport>().mockResolvedValue({status:'sent'});await createTelegram(db,owner,send).test();expect(send.mock.calls[0][0]).toBe(token);
});
it('serverless без постоянного ключа не сохраняет токен и не создаёт локальный секрет',async()=>{
 vi.stubEnv('CRM_DEPLOYMENT','netlify');vi.stubEnv('CRM_TELEGRAM_KEY','');
 await expect(createTelegram(db,owner).save(config())).rejects.toThrow('CRM_TELEGRAM_KEY');expect((await createTelegram(db,owner).view()).tokenConfigured).toBe(false);await expect(readFile(path.join(root,'telegram.key'))).rejects.toMatchObject({code:'ENOENT'});
});
it('прерванная отправка требует ручного повтора, действующая отправка не сбрасывается',async()=>{
 await createTelegram(db,owner).save(config());const id=await createCrm(db,owner).createBooking(booking());
 await db.query("UPDATE telegram_outbox SET status='sending',next_attempt_at=now()+interval '5 minutes' WHERE booking_id=$1",[id]);
 const send=vi.fn<TelegramTransport>().mockResolvedValue({status:'sent'});expect(await deliverNextTelegram(db,send)).toBe(false);expect((await createTelegram(db,owner).view()).deliveries[0].status).toBe('sending');
 await db.query("UPDATE telegram_outbox SET next_attempt_at=now()-interval '1 second' WHERE booking_id=$1",[id]);expect(await deliverNextTelegram(db,send)).toBe(false);expect((await createTelegram(db,owner).view()).deliveries[0].status).toBe('unknown');expect(send).not.toHaveBeenCalled();
});
