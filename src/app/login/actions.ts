'use server';
import {withWorkspace} from '@/lib/workspace-lock';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { sessionCookie } from '@/lib/session';
export async function login(previous:{error?:string},form:FormData):Promise<{error?:string}>{return withWorkspace(()=>performLogin(previous,form));}
async function performLogin(_: {error?:string}, form:FormData):Promise<{error?:string}> {
 let session;const requestHeaders=await headers();
 const source=process.env.CRM_DEPLOYMENT==='netlify'||process.env.NETLIFY==='true'?requestHeaders.get('x-nf-client-connection-ip')??'unattributed':'local';
 try {session=await createAuth(await getDb()).login(Object.fromEntries(form),source);}
 catch {return {error:'Не удалось войти. Проверьте логин и пароль.'};}
 if(!session)return {error:'Неверный логин или пароль, либо вход временно ограничен. После пяти неудачных попыток подождите 15 минут.'};
 const secure=process.env.CRM_COOKIE_SECURE==='true'||(process.env.CRM_COOKIE_SECURE!=='false'&&requestHeaders.get('x-forwarded-proto')==='https');
 (await cookies()).set(sessionCookie,session.token,{httpOnly:true,sameSite:'lax',secure,path:'/',expires:session.expires});
 redirect('/');
}
export async function logout() {return withWorkspace(performLogout);}
async function performLogout() {
 const jar=await cookies();
 await createAuth(await getDb()).logout(jar.get(sessionCookie)?.value);
 jar.delete(sessionCookie);
 redirect('/login');
}
