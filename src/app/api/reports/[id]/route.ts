import {currentActor} from '@/lib/session';
import {getDb} from '@/lib/db';
import {withWorkspace} from '@/lib/workspace-lock';
import {createOwnerReports} from '@/lib/owner-reports';
import {financialPdf} from '@/lib/report-pdf';
import {reportCsv} from '@/lib/reporting';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const result=await withWorkspace(async()=>{const actor=await currentActor();if(!actor)return {error:401};if(actor.role!=='owner')return {error:403};try{return await createOwnerReports(await getDb(),actor).read((await params).id)}catch{return {error:404}}});
 if('error' in result)return Response.json({error:'Документ недоступен'},{status:result.error});
 try{const {document,sha256}=result,csv=new URL(request.url).searchParams.get('format')==='csv';const body=csv?new TextEncoder().encode(reportCsv([['Документ',document.id,'SHA-256',sha256],['Период',document.from,document.to],['Дата','ID операции','Тип','Клиент/основание','Рейс','Исполнитель','Способ','Сумма','Изменение денег парка','Валюта','Первичный документ'],...document.operations.map(r=>[r.at,r.id,r.kind,r.name,r.route,r.actor_name??'Не установлен',r.method,r.amount_minor/100,r.cash_minor/100,r.currency,r.reference])])):await financialPdf(document,sha256);return new Response(Uint8Array.from(body).buffer,{headers:{'Content-Type':csv?'text/csv; charset=utf-8':'application/pdf','Content-Disposition':`attachment; filename="karven-report-${document.id}.${csv?'csv':'pdf'}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Karven-Report-SHA256':sha256}});}catch{return Response.json({error:'Не удалось сформировать файл. Проверьте период и размер отчёта.'},{status:400});}
}
