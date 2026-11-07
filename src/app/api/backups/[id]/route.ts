import {currentActor} from '@/lib/session';
import {getDb} from '@/lib/db';
import {createBackups} from '@/lib/backups';
import {withWorkspace} from '@/lib/workspace-lock';
import {z} from 'zod';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(_:Request,{params}:{params:Promise<{id:string}>}){
 return withWorkspace(async()=>{
  const actor=await currentActor();if(!actor)return Response.json({error:'Требуется вход'},{status:401});
  if(actor.role!=='owner')return Response.json({error:'Недостаточно прав'},{status:403});
  try{const id=z.uuid().parse((await params).id),bytes=await createBackups(await getDb(),actor).download(id);return new Response(Uint8Array.from(bytes).buffer,{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="karven-backup-${id}.json"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}})}
  catch{return Response.json({error:'Копия не найдена или не прошла проверку'},{status:400})}
 });
}
