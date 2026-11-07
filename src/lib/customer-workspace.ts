import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from './database-types';
import {requireRole,type Actor} from './access';
import {BusinessError} from './crm';
import {recordAudit} from './audit';
import {once} from './idempotency';
export type Customer={id:string;name:string;phone:string};
export type CustomerNote={id:string;client_id:string;body:string;author_name:string;created_at:string};
export type CustomerMovement={id:string;client_id:string;booking_id:string;kind:'payment'|'refund';amount_minor:number;currency:string;method:string;created_at:string};
export type WorkTask={id:string;title:string;description:string;status:'open'|'in_progress'|'done'|'cancelled';assignee_id:string;assignee_name:string;client_id:string|null;trip_id:string|null;due_at:string;version:number};
export type CustomerWorkspace={clients:Customer[];notes:CustomerNote[];movements:CustomerMovement[];tasks:WorkTask[];assignees:{id:string;name:string}[]};
export const emptyWorkspace:CustomerWorkspace={clients:[],notes:[],movements:[],tasks:[],assignees:[]};
const optionalId=z.union([z.uuid(),z.literal('')]).default('').transform(v=>v||null);
const taskInput=z.object({id:optionalId,version:z.coerce.number().int().min(1).default(1),title:z.string().trim().min(3).max(200),description:z.string().trim().max(2000).default(''),status:z.enum(['open','in_progress','done','cancelled']).default('open'),assigneeId:z.uuid(),clientId:optionalId,tripId:optionalId,dueAt:z.iso.datetime({offset:true}),requestId:z.uuid()});
export function createCustomerWorkspace(db:Database,actor:Actor){
 const access=()=>requireRole(actor,'owner','dispatcher');
 return {
  async list():Promise<CustomerWorkspace>{
   access();
   const clients=(await db.query<Customer>('SELECT id,name,phone FROM clients ORDER BY name,id')).rows;
   const notes=(await db.query<CustomerNote>(`SELECT n.id,n.client_id,n.body,u.name AS author_name,n.created_at FROM client_notes n JOIN users u ON u.id=n.author_id ORDER BY n.created_at DESC,n.id`)).rows.map(n=>({...n,created_at:new Date(n.created_at).toISOString()}));
   const movements=(await db.query<CustomerMovement>(`SELECT m.*,b.client_id,t.currency FROM (SELECT id,booking_id,'payment' AS kind,amount_minor,method,created_at FROM payments UNION ALL SELECT id,booking_id,'refund' AS kind,amount_minor,method,created_at FROM refunds) m JOIN bookings b ON b.id=m.booking_id JOIN trips t ON t.id=b.trip_id ORDER BY m.created_at DESC,m.id`)).rows.map(m=>({...m,created_at:new Date(m.created_at).toISOString()}));
   const tasks=(await db.query<WorkTask>(`SELECT t.id,t.title,t.description,t.status,t.assignee_id,t.client_id,t.trip_id,t.due_at,t.version,u.name AS assignee_name FROM work_tasks t JOIN users u ON u.id=t.assignee_id ORDER BY t.due_at,t.id`)).rows.map(t=>({...t,due_at:new Date(t.due_at).toISOString()}));
   const assignees=(await db.query<{id:string;name:string}>("SELECT id,name FROM users WHERE active AND role IN ('owner','dispatcher') ORDER BY name,id")).rows;
   return {clients,notes,movements,tasks,assignees};
  },
  async addNote(raw:unknown){
   access();const input=z.object({clientId:z.uuid(),body:z.string().trim().min(1).max(2000),requestId:z.uuid()}).parse(raw);
   await db.transaction(tx=>once(tx,actor,input.requestId,'client.note',input,async()=>{
    if(!(await tx.query('SELECT id FROM clients WHERE id=$1',[input.clientId])).rows.length)throw new BusinessError('Клиент не найден');
    const id=randomUUID();await tx.query('INSERT INTO client_notes(id,client_id,body,author_id) VALUES($1,$2,$3,$4)',[id,input.clientId,input.body,actor.id]);await recordAudit(tx,actor,input.clientId,'client.note_added',{noteId:id});
   }));
  },
  async saveTask(raw:unknown){
   access();const input=taskInput.parse(raw);
   await db.transaction(tx=>once(tx,actor,input.requestId,'task.save',input,async()=>{
    const assignee=(await tx.query<{active:boolean;role:string}>('SELECT active,role FROM users WHERE id=$1',[input.assigneeId])).rows[0];
    if(!assignee||!assignee.active||!['owner','dispatcher'].includes(assignee.role))throw new BusinessError('Выберите действующего владельца или диспетчера');
    if(input.clientId&&!(await tx.query('SELECT id FROM clients WHERE id=$1',[input.clientId])).rows.length)throw new BusinessError('Клиент не найден');
    if(input.tripId&&!(await tx.query('SELECT id FROM trips WHERE id=$1',[input.tripId])).rows.length)throw new BusinessError('Рейс не найден');
    const id=input.id??randomUUID();
    if(input.id){
     const current=(await tx.query<{version:number}>('SELECT version FROM work_tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
     if(!current)throw new BusinessError('Задача не найдена');
     if(current.version!==input.version)throw new BusinessError('Задача уже изменена другим сотрудником. Обновите страницу и повторите изменение.');
     await tx.query('UPDATE work_tasks SET title=$2,description=$3,status=$4,assignee_id=$5,client_id=$6,trip_id=$7,due_at=$8,version=version+1,updated_at=now() WHERE id=$1',[id,input.title,input.description,input.status,input.assigneeId,input.clientId,input.tripId,input.dueAt]);
    }else{
     await tx.query('INSERT INTO work_tasks(id,title,description,status,assignee_id,client_id,trip_id,due_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,input.title,input.description,input.status,input.assigneeId,input.clientId,input.tripId,input.dueAt,actor.id]);
    }
    await recordAudit(tx,actor,id,input.id?'task.updated':'task.created',{status:input.status,assigneeId:input.assigneeId,dueAt:input.dueAt});
   }));
  },
 };
}
