import {createHash} from 'node:crypto';
import {currentActor} from '@/lib/session';
import {getDb} from '@/lib/db';
import {withWorkspace} from '@/lib/workspace-lock';
import {validPeriod} from '@/lib/reporting';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request){return withWorkspace(async()=>{
 const actor=await currentActor();if(!actor)return Response.json({error:'Войдите в приложение'},{status:401});if(actor.role!=='owner')return Response.json({error:'Недостаточно прав'},{status:403});
 const q=new URL(request.url).searchParams,from=q.get('from')??'',to=q.get('to')??'';if(!validPeriod(from,to)||Date.parse(to)-Date.parse(from)>366*86400000)return Response.json({error:'Укажите период до 366 дней'},{status:400});
 const db=await getDb(),events=(await db.query(`SELECT * FROM karven_archive.event_log WHERE created_at>=($1::date::timestamp AT TIME ZONE 'Asia/Bishkek') AND created_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Bishkek') ORDER BY created_at,id LIMIT 10001`,[from,to])).rows,documents=(await db.query(`SELECT * FROM karven_archive.report_documents WHERE created_at>=($1::date::timestamp AT TIME ZONE 'Asia/Bishkek') AND created_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Bishkek') ORDER BY created_at,id LIMIT 1001`,[from,to])).rows;
 const body=JSON.stringify({format:'karven-control-archive',version:1,from,to,exportedAt:new Date().toISOString(),events,documents});
 if(events.length>10000||documents.length>1000||Buffer.byteLength(body)>4500000)return Response.json({error:'Сократите период: архив слишком большой для одного файла'},{status:400});
 return new Response(body,{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="karven-control-${from}-${to}.json"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Karven-Archive-SHA256':createHash('sha256').update(body).digest('hex')}});
});}
