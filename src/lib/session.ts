import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from './db';
import { createAuth } from './auth';
export const sessionCookie='karven_session';
export async function currentActor() {
 const token=(await cookies()).get(sessionCookie)?.value;
 return createAuth(await getDb()).actor(token);
}
export async function requireActor() {
 const actor=await currentActor();
 if(!actor)redirect('/login');
 return actor;
}
