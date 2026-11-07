import {beforeEach,afterEach,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {schema} from '../src/lib/schema';
import {createCustomerWorkspace} from '../src/lib/customer-workspace';
import {createCrm} from '../src/lib/crm';
import {createFinance} from '../src/lib/finance';
import {owner,seedOwner} from './helpers';
let db:PGlite,workspace:ReturnType<typeof createCustomerWorkspace>,tripId:string,clientId:string,bookingId:string;
beforeEach(async()=>{db=new PGlite();await db.exec(schema);await seedOwner(db);workspace=createCustomerWorkspace(db,owner);const crm=createCrm(db,owner);tripId=await crm.createTrip({origin:'Бишкек',destination:'Нарын',departureAt:new Date(Date.now()+86400000).toISOString(),capacity:4,currency:'KGS'});bookingId=await crm.createBooking({tripId,name:'Клиент',phone:'+996555123456',seats:1,total:'1000',initialPayment:'400'});clientId=(await workspace.list()).clients[0].id;},30000);
afterEach(async()=>{await db.close()});
const task=()=>({title:'Перезвонить клиенту',description:'Уточнить адрес',assigneeId:owner.id,clientId,tripId,dueAt:new Date(Date.now()-3600000).toISOString(),requestId:randomUUID()});
it('показывает клиента, оплаты и возвраты, сохраняя валюту и связь с заказом',async()=>{
 await createFinance(db,owner).refund({bookingId,amount:'100',reason:'Согласованная скидка',method:'cash',requestId:randomUUID()});
 const data=await workspace.list();expect(data.clients).toHaveLength(1);expect(data.movements).toHaveLength(2);expect(data.movements.map(m=>m.kind).sort()).toEqual(['payment','refund']);expect(data.movements.every(m=>m.client_id===clientId&&m.booking_id===bookingId&&m.currency==='KGS')).toBe(true);expect((await createCrm(db,owner).dashboard()).bookings[0].client_id).toBe(clientId);
});
it('заметка сохраняет автора; повтор запроса не создаёт дубликат',async()=>{
 const raw={clientId,body:'Просит звонить заранее',requestId:randomUUID()};await workspace.addNote(raw);await workspace.addNote(raw);expect((await workspace.list()).notes).toMatchObject([{body:raw.body,author_name:owner.name}]);await expect(workspace.addNote({...raw,body:'Другой текст'})).rejects.toThrow('идентификатор');
});
it('задача сохраняет связи, ответственного, срок и повторяется без дубликатов',async()=>{
 const raw=task();await workspace.saveTask(raw);await workspace.saveTask(raw);const tasks=(await workspace.list()).tasks;expect(tasks).toHaveLength(1);expect(tasks[0]).toMatchObject({title:raw.title,client_id:clientId,trip_id:tripId,assignee_id:owner.id,status:'open',version:1});expect(new Date(tasks[0].due_at).getTime()).toBeLessThan(Date.now());
});
it('переходит в работу и завершение; устаревшее изменение не затирает новую версию',async()=>{
 await workspace.saveTask(task());const current=(await workspace.list()).tasks[0];const raw={...task(),id:current.id,version:1,status:'in_progress'};await workspace.saveTask(raw);await workspace.saveTask(raw);await expect(workspace.saveTask({...raw,title:'Устаревшее изменение',requestId:randomUUID()})).rejects.toThrow('уже изменена');await workspace.saveTask({...raw,version:2,status:'done',requestId:randomUUID()});expect((await workspace.list()).tasks[0]).toMatchObject({status:'done',version:3});
});
it('не создаёт задачу с отсутствующими связями или заблокированным исполнителем',async()=>{
 await expect(workspace.saveTask({...task(),clientId:randomUUID()})).rejects.toThrow('Клиент');await expect(workspace.saveTask({...task(),tripId:randomUUID()})).rejects.toThrow('Рейс');await db.query('UPDATE users SET active=false WHERE id=$1',[owner.id]);await expect(workspace.saveTask(task())).rejects.toThrow('действующего');expect((await db.query('SELECT * FROM work_tasks')).rows).toHaveLength(0);expect((await db.query("SELECT * FROM mutation_receipts WHERE operation='task.save'")).rows).toHaveLength(0);
});
it('диспетчер работает с задачами, водитель не получает клиентов, заметки и задачи',async()=>{
 const dispatcher={...owner,id:randomUUID(),role:'dispatcher' as const};await db.query("INSERT INTO users(id,name,username,password_hash,role) VALUES($1,'Диспетчер','dispatcher','unused','dispatcher')",[dispatcher.id]);const service=createCustomerWorkspace(db,dispatcher);await service.addNote({clientId,body:'Внутренняя заметка',requestId:randomUUID()});await service.saveTask({...task(),assigneeId:dispatcher.id});expect((await service.list()).assignees).toHaveLength(2);const driver=createCustomerWorkspace(db,{...owner,role:'driver'});await expect(driver.list()).rejects.toThrow('прав');await expect(driver.addNote({})).rejects.toThrow('прав');await expect(driver.saveTask(task())).rejects.toThrow('прав');
});
