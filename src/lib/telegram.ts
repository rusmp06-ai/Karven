import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdir,readFile,open} from 'node:fs/promises';
import path from 'node:path';
import * as http from 'node:http';
import {isServerless} from './deployment';
import type {Database} from './database-types';
import {z} from 'zod';
import {BusinessError} from './crm';
import {requireRole,type Actor} from './access';
import {once} from './idempotency';
import {recordAudit} from './audit';
import {withWorkspace} from './workspace-lock';
import type {TelegramView,TelegramDelivery} from './telegram-types';
export type TelegramResult={status:'sent'|'retry'|'failed'|'unknown';error?:string;retryAfter?:number};
export type TelegramTransport=(token:string,chatId:string,text:string)=>Promise<TelegramResult>;
const tokenPattern=/^\d{5,16}:[A-Za-z0-9_-]{30,100}$/;
const chatPattern=/^-?[1-9]\d{0,19}$/;
const singleton='00000000-0000-4000-8000-000000000009';
type Settings={enabled:boolean;encrypted_token:string|null;chat_id:string;version:number;last_test_at:Date|null;last_test_error:string|null};
function keyPath(){return process.env.CRM_TELEGRAM_KEY_FILE||path.join(process.env.DATABASE_DIR?`${process.env.DATABASE_DIR}-secrets`:path.join(process.cwd(),'data','secrets'),'telegram.key')}
async function key(create:boolean){
 const configured=process.env.CRM_TELEGRAM_KEY;
 if(configured){if(!/^[a-fA-F0-9]{64}$/.test(configured))throw new BusinessError('CRM_TELEGRAM_KEY должен содержать 64 шестнадцатеричных символа');return Buffer.from(configured,'hex')}
 if(isServerless())throw new BusinessError('Для Telegram задайте CRM_TELEGRAM_KEY в защищённых переменных сервера');
 const filename=keyPath();
 if(create){await mkdir(path.dirname(filename),{recursive:true,mode:0o700});try{const f=await open(filename,'wx',0o600);try{await f.writeFile(randomBytes(32));await f.sync()}finally{await f.close()}}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}}
 const result=await readFile(filename);if(result.length!==32)throw new Error('Invalid key');return result;
}
async function encrypt(token:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',await key(true),iv);const data=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),data.toString('base64')].join('.')}
async function decrypt(value:string){try{const [version,iv,tag,data]=value.split('.');if(version!=='v1')throw new Error();const cipher=createDecipheriv('aes-256-gcm',await key(false),Buffer.from(iv,'base64'));cipher.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8')}catch{throw new BusinessError('Не удалось прочитать токен. Введите его заново и сохраните настройки')}}
const proxyState=globalThis as typeof globalThis&{karvenTelegramProxyReady?:boolean};
export const sendTelegram:TelegramTransport=async(token,chatId,text)=>{
 if(!proxyState.karvenTelegramProxyReady){if((process.env.HTTPS_PROXY||process.env.HTTP_PROXY)&&typeof http.setGlobalProxyFromEnv==='function')http.setGlobalProxyFromEnv();proxyState.karvenTelegramProxyReady=true;}
 try{
  const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text,link_preview_options:{is_disabled:true}}),signal:AbortSignal.timeout(8000),redirect:'error',cache:'no-store'});
  const data=await response.json() as {ok?:boolean;error_code?:number;parameters?:{retry_after?:number}};
  if(response.ok&&data.ok===true)return {status:'sent'};
  const code=data.error_code??response.status;
  if(code===429)return {status:'retry',error:'Telegram ограничил частоту отправки',retryAfter:Math.min(86400,Math.max(5,Number(data.parameters?.retry_after)||30))};
  if(code===401)return {status:'failed',error:'Telegram отклонил токен бота'};
  if(code===403)return {status:'failed',error:'Бот заблокирован или у него нет прав отправлять в этот чат'};
  if(code>=500)return {status:'unknown',error:'Telegram не подтвердил доставку. Проверьте чат перед повтором'};
  return {status:'failed',error:'Telegram отклонил сообщение. Проверьте ID чата и доступ бота'};
 }catch{return {status:'unknown',error:'Нет подтверждения доставки. Проверьте соединение и чат перед повтором'}}
};
async function settings(db:Database){return (await db.query<Settings>('SELECT enabled,encrypted_token,chat_id,version,last_test_at,last_test_error FROM telegram_settings WHERE id=1')).rows[0]}
export function createTelegram(db:Database,actor:Actor,transport:TelegramTransport=sendTelegram){
 const access=()=>requireRole(actor,'owner');
 return {
  async view():Promise<TelegramView>{
   access();const [s,result]=await Promise.all([settings(db),db.query<TelegramDelivery>('SELECT booking_id,status,attempts,last_error,created_at,sent_at FROM telegram_outbox ORDER BY created_at DESC,booking_id LIMIT 30')]);
   const deliveries=result.rows.map(d=>({...d,created_at:new Date(d.created_at).toISOString(),sent_at:d.sent_at?new Date(d.sent_at).toISOString():null}));return {enabled:s.enabled,tokenConfigured:!!s.encrypted_token,chatId:s.chat_id,version:s.version,lastTestAt:s.last_test_at?new Date(s.last_test_at).toISOString():null,lastTestError:s.last_test_error,deliveries};},
  async save(raw:unknown){
   access();const input=z.object({token:z.string().trim().max(150).default('').refine(v=>!v||tokenPattern.test(v),'Проверьте формат токена BotFather'),chatId:z.string().trim().max(21).default('').refine(v=>!v||chatPattern.test(v),'Укажите числовой ID чата, для группы — со знаком минус'),enabled:z.enum(['true','false']),version:z.coerce.number().int().min(1),requestId:z.uuid()}).parse(raw);
   await db.transaction(tx=>once(tx,actor,input.requestId,'telegram.save',input,async()=>{
    const current=(await tx.query<Settings>('SELECT * FROM telegram_settings WHERE id=1 FOR UPDATE')).rows[0];if(current.version!==input.version)throw new BusinessError('Настройки Telegram уже изменены. Обновите страницу');
    const encrypted=input.token?await encrypt(input.token):current.encrypted_token;
    if(input.enabled==='true'&&(!encrypted||!input.chatId))throw new BusinessError('Для уведомлений укажите токен бота и ID чата');
    await tx.query('UPDATE telegram_settings SET encrypted_token=$1,chat_id=$2,enabled=$3,version=version+1,last_test_at=NULL,last_test_error=NULL WHERE id=1',[encrypted,input.chatId,input.enabled==='true']);
    await tx.exec("UPDATE telegram_outbox SET status='cancelled',last_error='Настройки подключения изменены' WHERE status IN ('pending','failed','unknown','sending')");
    await recordAudit(tx,actor,singleton,'telegram.configured',{enabled:input.enabled==='true',tokenChanged:!!input.token});
   }));
  },
  async disconnect(raw:unknown){access();const input=z.object({version:z.coerce.number().int(),requestId:z.uuid()}).parse(raw);await db.transaction(tx=>once(tx,actor,input.requestId,'telegram.disconnect',input,async()=>{const s=(await tx.query<{version:number}>('SELECT version FROM telegram_settings WHERE id=1 FOR UPDATE')).rows[0];if(s.version!==input.version)throw new BusinessError('Настройки уже изменены. Обновите страницу');await tx.exec("UPDATE telegram_settings SET enabled=false,encrypted_token=NULL,chat_id='',version=version+1,last_test_at=NULL,last_test_error=NULL WHERE id=1; UPDATE telegram_outbox SET status='cancelled',last_error='Подключение удалено' WHERE status IN ('pending','failed','unknown','sending')");await recordAudit(tx,actor,singleton,'telegram.disconnected');}));},
  async test(){access();const s=await settings(db);if(!s.encrypted_token||!s.chat_id)throw new BusinessError('Сначала сохраните токен и ID чата');const token=await decrypt(s.encrypted_token);let result:TelegramResult;try{result=await transport(token,s.chat_id,'Karven CRM: тестовое уведомление. Подключение Telegram работает.')}catch{result={status:'unknown',error:'Нет подтверждения доставки тестового сообщения'}}await db.query('UPDATE telegram_settings SET last_test_at=now(),last_test_error=$1 WHERE id=1',[result.status==='sent'?null:result.error??'Тестовое сообщение не доставлено']);await db.transaction(tx=>recordAudit(tx,actor,singleton,'telegram.tested',{success:result.status==='sent'}));if(result.status!=='sent')throw new BusinessError(result.error??'Тестовое сообщение не доставлено');},
  async retry(raw:unknown){access();const input=z.object({bookingId:z.uuid(),confirmed:z.literal('yes'),requestId:z.uuid()}).parse(raw);await db.transaction(tx=>once(tx,actor,input.requestId,'telegram.retry',input,async()=>{const s=(await tx.query<Settings>('SELECT * FROM telegram_settings WHERE id=1')).rows[0];if(!s.enabled||!s.encrypted_token)throw new BusinessError('Сначала включите подключение Telegram');const row=(await tx.query<{status:string;settings_version:number}>('SELECT status,settings_version FROM telegram_outbox WHERE booking_id=$1 FOR UPDATE',[input.bookingId])).rows[0];if(!row||!['failed','unknown','cancelled'].includes(row.status))throw new BusinessError('Это уведомление недоступно для повтора');await tx.query("UPDATE telegram_outbox SET status='pending',attempts=0,last_error=NULL,next_attempt_at=now(),settings_version=$2 WHERE booking_id=$1",[input.bookingId,s.version]);await recordAudit(tx,actor,input.bookingId,'telegram.retried');}));},
 };
}
export async function deliverNextTelegram(db:Database,transport:TelegramTransport=sendTelegram){return withWorkspace(()=>performDelivery(db,transport))}
async function performDelivery(db:Database,transport:TelegramTransport){
 const job=await withWorkspace(()=>db.transaction(async tx=>{
  await tx.exec("UPDATE telegram_outbox SET status='unknown',last_error='Обработка прервана без подтверждения. Проверьте чат перед повтором' WHERE status='sending' AND next_attempt_at<now()");
  const s=(await tx.query<Settings>('SELECT * FROM telegram_settings WHERE id=1')).rows[0];if(!s.enabled||!s.encrypted_token)return null;
  await tx.query("UPDATE telegram_outbox SET status='cancelled',last_error='Настройки подключения изменены' WHERE status='pending' AND settings_version<>$1",[s.version]);
  const row=(await tx.query<{booking_id:string;attempts:number}>("SELECT booking_id,attempts FROM telegram_outbox WHERE status='pending' AND next_attempt_at<=now() AND settings_version=$1 ORDER BY created_at,booking_id LIMIT 1 FOR UPDATE",[s.version])).rows[0];if(!row)return null;
  const stored=(await tx.query<{payload:{name:string;phone:string;origin:string;destination:string;departure_at:string;passenger_count:number;booking_type:string;total:number;paid:number;currency:string};status:string}>('SELECT o.payload,b.status FROM telegram_outbox o JOIN bookings b ON b.id=o.booking_id WHERE o.booking_id=$1',[row.booking_id])).rows[0];
  const booking=stored.payload;
  await tx.query("UPDATE telegram_outbox SET status='sending',attempts=attempts+1,last_error=NULL,next_attempt_at=now()+interval '5 minutes' WHERE booking_id=$1",[row.booking_id]);
  const money=(n:number)=>`${(n/100).toFixed(2)} ${booking.currency}`;
  const text=`Новая бронь клиента\nКлиент: ${booking.name}\nТелефон: +${booking.phone}\nРейс: ${booking.origin} → ${booking.destination}\nОтправление: ${new Date(booking.departure_at).toLocaleString('ru',{timeZone:'Asia/Bishkek'})} (Бишкек)\nПассажиров: ${booking.passenger_count}${booking.booking_type==='vehicle'?' · вся машина':''}\nСтоимость: ${money(booking.total)}\nОплачено: ${money(booking.paid)}\nОстаток: ${money(Math.max(0,booking.total-booking.paid))}\nЗаказ: ${row.booking_id}\nДанные на момент регистрации брони.${stored.status==='cancelled'?'\nНа момент отправки бронь уже отменена.':''}`;
  return {...row,settings:s,text};
 }));
 if(!job)return false;
 let result:TelegramResult;
 try{result=await transport(await decrypt(job.settings.encrypted_token!),job.settings.chat_id,job.text)}catch(error){result={status:'failed',error:error instanceof BusinessError?'Не удалось прочитать токен. Введите его заново':'Не удалось отправить уведомление'};}
 await withWorkspace(()=>db.transaction(async tx=>{
  const status=result.status==='retry'?(job.attempts+1<3?'pending':'failed'):result.status;
  await tx.query("UPDATE telegram_outbox SET status=$2,last_error=$3,sent_at=CASE WHEN $2='sent' THEN now() ELSE NULL END,next_attempt_at=now()+($4::integer*interval '1 second') WHERE booking_id=$1 AND status='sending' AND settings_version=$5",[job.booking_id,status,result.error??null,Math.ceil(result.retryAfter??30),job.settings.version]);
 }));
 return true;
}
const worker=globalThis as typeof globalThis&{karvenTelegramWorker?:{db:Database;timer:ReturnType<typeof setInterval>;running:Promise<void>|null}};
export async function waitForTelegramDelivery(){await worker.karvenTelegramWorker?.running;}
export function startTelegramWorker(db:Database){
 if(isServerless())return;
 if(worker.karvenTelegramWorker)return;
 const state={db,timer:undefined as unknown as ReturnType<typeof setInterval>,running:null as Promise<void>|null};worker.karvenTelegramWorker=state;
 state.timer=setInterval(()=>{if(state.running)return;state.running=(async()=>{try{await deliverNextTelegram(db)}catch{/* no secrets or request URLs in logs */}})().finally(()=>{state.running=null})},3000);state.timer.unref();
}

// Await delivery before the function returns; pending rate-limited jobs remain durable.
export async function dispatchTelegram(db:Database,maximum=1){
 for(let i=0;i<maximum;i++){try{if(!await deliverNextTelegram(db))break}catch{break}}
}
