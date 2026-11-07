import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type {Database} from './database-types';
import { z } from 'zod';
import { type Actor, requireRole } from './access';
import { recordAudit } from './audit';
export class AuthError extends Error {}
const scrypt = promisify(scryptCallback);
const loginName = z.string().trim().toLowerCase().regex(/^[a-z0-9_.-]{3,64}$/);
const passwordInput = z.string().min(12,'Пароль должен содержать минимум 12 символов').max(128);
const hashToken = (token:string) => createHash('sha256').update(token).digest('hex');
export async function hashPassword(password:string) {
 const salt=randomBytes(16).toString('hex');
 const key=await scrypt(password,salt,64) as Buffer;
 return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password:string,encoded:string) {
 const [algorithm,salt,key]=encoded.split(':');
 if(algorithm!=='scrypt'||!salt||!key)return false;
 const expected=Buffer.from(key,'hex');
 const actual=await scrypt(password,salt,64) as Buffer;
 return expected.length===actual.length && timingSafeEqual(actual,expected);
}
export async function bootstrapOwner(db:Database) {
 if((await db.query('SELECT id FROM users LIMIT 1')).rows.length)return;
 await db.transaction(async tx=>{
 const {rows}=await tx.query('SELECT id FROM users LIMIT 1');
 if(rows.length)return;
 const username=process.env.CRM_ADMIN_USER;
 const password=process.env.CRM_ADMIN_PASSWORD;
 if(!username||!password)return;
 const normalized=loginName.parse(username);
 passwordInput.parse(password);
 const hash=await hashPassword(password);
  const id=randomUUID();
  await tx.query("INSERT INTO users(id,username,name,password_hash,role) VALUES($1,$2,$3,$4,'owner')",[id,normalized,'Владелец',hash]);
  await recordAudit(tx,{id,name:'Владелец',username:normalized,role:'owner',driver_id:null},id,'user.bootstrapped');
 });
}
export function createAuth(db:Database) {
 return {
  async login(raw:unknown) {
   const input=z.object({username:loginName,password:z.string().min(1).max(128)}).parse(raw);
   // Serializing the check and increment prevents parallel requests bypassing the limit.
   return db.transaction(async tx=>{
    const [attemptResult,userResult]=await Promise.all([
     tx.query<{failures:number;window_start:Date}>("INSERT INTO login_attempts(username) VALUES($1) ON CONFLICT(username) DO UPDATE SET username=EXCLUDED.username RETURNING failures,window_start",[input.username]),
     tx.query<Actor & {password_hash:string;active:boolean}>('SELECT * FROM users WHERE username=$1',[input.username]),
    ]);
    const attempts=attemptResult.rows,rows=userResult.rows;
    const expired=Date.now()-new Date(attempts[0].window_start).getTime()>=15*60*1000;
    if(!expired && attempts[0].failures>=5)return null;
    if(expired)await tx.query('UPDATE login_attempts SET failures=0,window_start=now() WHERE username=$1',[input.username]);
    // Equal-cost derivation for unknown users avoids a fast username oracle.
    const fallback='scrypt:00000000000000000000000000000000:'+ '00'.repeat(64);
    const valid=await verifyPassword(input.password,rows[0]?.password_hash || fallback);
    if(!valid || !rows[0]?.active) {
     await tx.query('UPDATE login_attempts SET failures=failures+1 WHERE username=$1',[input.username]);
     return null;
    }
    const token=randomBytes(32).toString('hex');
    const expires=new Date(Date.now()+8*60*60*1000);
    await Promise.all([
     tx.query('DELETE FROM login_attempts WHERE username=$1',[input.username]),
     tx.query('DELETE FROM sessions WHERE expires_at<=now()'),
     tx.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(token),rows[0].id,expires]),
     recordAudit(tx,rows[0],rows[0].id,'session.created'),
    ]);
    return {token,expires};
   });
  },
  async actor(token:string|undefined):Promise<Actor|null> {
   if(!token || !/^[a-f0-9]{64}$/.test(token))return null;
   const {rows}=await db.query<Actor>(`SELECT u.id,u.username,u.name,u.role,u.driver_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true`,[hashToken(token)]);
   return rows[0]??null;
  },
  async logout(token:string|undefined) {
   if(token)await db.query('DELETE FROM sessions WHERE token_hash=$1',[hashToken(token)]);
  },
  async createUser(actor:Actor,raw:unknown) {
   requireRole(actor,'owner');
   const input=z.object({username:loginName,name:z.string().trim().min(1).max(120),password:passwordInput,role:z.enum(['owner','dispatcher','driver']),driverId:z.string().uuid().optional()}).parse(raw);
   if((input.role==='driver')!==Boolean(input.driverId))throw new AuthError('Для водителя выберите карточку водителя');
   const hash=await hashPassword(input.password);
   const id=randomUUID();
   await db.transaction(async tx=>{
    if((await tx.query('SELECT id FROM users WHERE username=$1',[input.username])).rows.length)throw new AuthError('Этот логин уже занят');
    if(input.driverId) {
     if(!(await tx.query('SELECT id FROM drivers WHERE id=$1',[input.driverId])).rows.length)throw new AuthError('Водитель не найден');
     if((await tx.query('SELECT id FROM users WHERE driver_id=$1',[input.driverId])).rows.length)throw new AuthError('У водителя уже есть учётная запись');
    }
    await tx.query('INSERT INTO users(id,username,name,password_hash,role,driver_id) VALUES($1,$2,$3,$4,$5,$6)',[id,input.username,input.name,hash,input.role,input.driverId??null]);
    await recordAudit(tx,actor,id,'user.created',{username:input.username,role:input.role,driverId:input.driverId});
   });
   return id;
  },
  async setUserActive(actor:Actor,id:string,active:boolean) {
   requireRole(actor,'owner');z.string().uuid().parse(id);
   if(actor.id===id)throw new AuthError('Нельзя заблокировать собственную учётную запись');
   await db.transaction(async tx=>{
    if(!(await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[id])).rows.length)throw new AuthError('Сотрудник не найден');
    await tx.query('UPDATE users SET active=$2 WHERE id=$1',[id,active]);
    if(!active)await tx.query('DELETE FROM sessions WHERE user_id=$1',[id]);
    await recordAudit(tx,actor,id,active?'user.enabled':'user.disabled');
   });
  },
  async resetPassword(actor:Actor,id:string,password:string) {
   requireRole(actor,'owner');z.string().uuid().parse(id);passwordInput.parse(password);
   const hash=await hashPassword(password);
   await db.transaction(async tx=>{
    if(!(await tx.query('SELECT id FROM users WHERE id=$1',[id])).rows.length)throw new AuthError('Сотрудник не найден');
    await tx.query('UPDATE users SET password_hash=$2 WHERE id=$1',[id,hash]);
    await tx.query('DELETE FROM sessions WHERE user_id=$1',[id]);
    await tx.query('DELETE FROM login_attempts WHERE username=(SELECT username FROM users WHERE id=$1)',[id]);
    await recordAudit(tx,actor,id,'user.password_reset');
   });
  },
  async listUsers(actor:Actor) {
   requireRole(actor,'owner');
   return (await db.query<Actor & {active:boolean}>('SELECT id,username,name,role,driver_id,active FROM users ORDER BY created_at')).rows;
  },
  async auditLog(actor:Actor) {
   requireRole(actor,'owner');
   return (await db.query<{id:string;action:string;entity_id:string;actor_name:string|null;created_at:Date}>(`SELECT a.id,a.action,a.entity_id,a.created_at,u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 100`)).rows;
  },
 };
}
