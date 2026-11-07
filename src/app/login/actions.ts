'use server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { sessionCookie } from '@/lib/session';
export async function login(_: {error?:string}, form:FormData):Promise<{error?:string}> {
 let session;
 try {session=await createAuth(await getDb()).login(Object.fromEntries(form));}
 catch {return {error:'Не удалось войти. Проверьте логин и пароль.'};}
 if(!session)return {error:'Неверный логин или пароль, либо вход временно ограничен. После пяти неудачных попыток подождите 15 минут.'};
 const requestHeaders=await headers();
 const secure=process.env.CRM_COOKIE_SECURE==='true'||(process.env.CRM_COOKIE_SECURE!=='false'&&requestHeaders.get('x-forwarded-proto')==='https');
 (await cookies()).set(sessionCookie,session.token,{httpOnly:true,sameSite:'lax',secure,path:'/',expires:session.expires});
 redirect('/');
}
export async function logout() {
 const jar=await cookies();
 await createAuth(await getDb()).logout(jar.get(sessionCookie)?.value);
 jar.delete(sessionCookie);
 redirect('/login');
}
