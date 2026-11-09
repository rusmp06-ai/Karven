import {it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {schema} from '../src/lib/schema';
import {owner,seedOwner} from './helpers';
import {loadOwnerView} from '../src/lib/owner-view';
import {createCrm} from '../src/lib/crm';
import {createOwnerReports} from '../src/lib/owner-reports';
import {createCancellations} from '../src/lib/cancellations';
import {createCashShifts} from '../src/lib/cash-shifts';
import {reportDay} from '../src/lib/reporting';
it('панель владельца читает причины, деньги менеджера, кассу и неизменяемый архив после очистки рабочих документов',async()=>{
 const db=new PGlite();try{await db.exec(schema);await seedOwner(db);const manager={...owner,id:randomUUID(),role:'dispatcher' as const,name:'Менеджер'};await db.query("INSERT INTO users(id,name,username,password_hash,role) VALUES($1,$2,'manager','unused','dispatcher')",[manager.id,manager.name]);const shift=await createCashShifts(db,manager).open({requestId:randomUUID()}),crm=createCrm(db,manager),tripId=await crm.createTrip({origin:'Бишкек',destination:'Ош',departureAt:new Date(Date.now()+86400000).toISOString(),capacity:8,currency:'KGS'}),id=await crm.createBooking({tripId,name:'Проверочный клиент',phone:'+996555009988',seats:2,total:'1000',initialPayment:'400'});await createCancellations(db,manager).cancel({bookingId:id,initiator:'client',reason:'Изменились планы клиента',retained:'100',retentionReason:'Согласовано с клиентом',requestId:randomUUID()});await createCashShifts(db,manager).close({shiftId:shift,counts:[{currency:'KGS',amount:'390'}],note:'Десять сом требуют проверки',requestId:randomUUID()});
 const data=await loadOwnerView(db,owner,{booking:id,actorId:manager.id});expect(data.cancellations[0]).toMatchObject({outstanding_minor:30000,retained_minor:10000,actor_name:'Менеджер'});expect(data.shifts[0].balances).toMatchObject([{expected:40000,declared:39000}]);expect(data.attention.some(a=>a.kind==='shift')).toBe(true);expect(data.selectedHistory.length).toBeGreaterThan(0);expect(data.selectedBooking?.id).toBe(id);
 const reports=createOwnerReports(db,owner),day=reportDay(new Date().toISOString()),reportId=await reports.create({from:day,to:day,requestId:randomUUID()});const first=await reports.read(reportId);await db.exec('TRUNCATE report_documents,audit_events');expect((await reports.read(reportId)).sha256).toBe(first.sha256);expect((await reports.list())[0].id).toBe(reportId);const next=await reports.create({from:day,to:day,previousId:reportId,requestId:randomUUID()});expect((await reports.read(next)).document.revision).toBe(2);expect((await loadOwnerView(db,owner,{})).journal.length).toBeGreaterThan(0);
 }finally{await db.close();}
},30000);
