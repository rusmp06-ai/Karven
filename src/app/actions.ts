'use server';
import {withWorkspace} from '@/lib/workspace-lock';
import {createBackups} from '@/lib/backups';
import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {createParkSettings} from '@/lib/park-settings';
import {createCustomerWorkspace} from '@/lib/customer-workspace';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { BusinessError, createCrm } from '@/lib/crm';
import { getDb } from '@/lib/db';
import { requireActor,sessionCookie } from '@/lib/session';
import { AccessError } from '@/lib/access';
import { createFleet } from '@/lib/fleet';
import { createFinance } from '@/lib/finance';
import { createTripOperations } from '@/lib/trip-operations';
import { createAuth, AuthError } from '@/lib/auth';
export type ActionState = { error?: string; success?: string; createdId?:string; entity?:'trip'|'booking' };
export async function mutate(previous:ActionState,form:FormData):Promise<ActionState> {return withWorkspace(()=>performMutation(previous,form));}
async function performMutation(_:ActionState,form:FormData):Promise<ActionState> {
 const actor=await requireActor();
 let restored=false;
 try {
  const db=await getDb();
  const crm=createCrm(db,actor),fleet=createFleet(db,actor),auth=createAuth(db);
  const finance=createFinance(db,actor),operations=createTripOperations(db,actor);
  const data=Object.fromEntries(form);
  let createdId:string|undefined;
  let entity:ActionState['entity'];
  // Optional form values must remain absent, rather than empty UUID strings.
  if(data.driverId==='')delete data.driverId;
  switch(data.action) {
   case 'backupImport':{
    const file=form.get('backupFile');if(!(file instanceof File)||file.size===0||file.size>64*1024*1024)return {error:'Выберите JSON-копию размером до 64 МБ'};
    await createBackups(db,actor).importFile(new Uint8Array(await file.arrayBuffer()),String(data.requestId));break;
   }
   case 'backupCreate':await createBackups(db,actor).create(String(data.requestId));break;
   case 'backupVerify':await createBackups(db,actor).verify(String(data.backupId));break;
   case 'backupRestore':await createBackups(db,actor).restore(data);restored=true;break;
   case 'parkSettings':await createParkSettings(db,actor).savePark(data);break;
   case 'routeTemplate':await createParkSettings(db,actor).saveRoute(data);break;
   case 'clientNote':await createCustomerWorkspace(db,actor).addNote(data);break;
   case 'task':await createCustomerWorkspace(db,actor).saveTask(data);break;
   case 'transferBooking':await operations.transfer(data);break;
   case 'resizeBooking':
    if(typeof data.passengers==='string'){try{data.passengers=JSON.parse(data.passengers);}catch{return {error:'Проверьте список пассажиров'};}}
    await operations.resize(data);break;
   case 'attendance':await operations.attendance(data);break;
   case 'cancelTrip':await operations.cancelTrip(data);break;
   case 'completeTrip':await finance.completeTrip(data);break;
   case 'refund':await finance.refund(data);break;
   case 'cancelRefund':await finance.cancelWithRefund(data);break;
   case 'expense':await finance.addExpense(data);break;
   case 'voidExpense':await finance.voidExpense(data);break;
   case 'approveSettlement':await finance.approveSettlement(data);break;
   case 'payout':await finance.payDriver(data);break;
   case 'trip':createdId=await crm.createTrip(data);entity='trip';break;
   case 'booking':
    if(typeof data.passengers==='string'){try{data.passengers=JSON.parse(data.passengers);}catch{return {error:'Проверьте список пассажиров'};}}
    createdId=await crm.createBooking(data);entity='booking';break;
   case 'bookingDetails':
    if(typeof data.passengers==='string'){try{data.passengers=JSON.parse(data.passengers);}catch{return {error:'Проверьте список пассажиров'};}}
    await crm.updateBookingDetails(data);break;
   case 'payment':await crm.addPayment(data);break;
   case 'cancel':await crm.cancelBooking(String(data.bookingId));break;
   case 'driver':await fleet.saveDriver(data);break;
   case 'vehicle':await fleet.saveVehicle(data);break;
   case 'assign':await fleet.assign(data);break;
   case 'user':await auth.createUser(actor,data);break;
   case 'userStatus':await auth.setUserActive(actor,String(data.id),data.active==='true');break;
   case 'resetPassword':await auth.resetPassword(actor,String(data.id),String(data.password));break;
   default:return {error:'Неизвестная операция'};
  }
  if(!restored){revalidatePath('/');return {success:'Сохранено',createdId,entity};}
 } catch(error) {
  if(['backupCreate','backupVerify','backupImport','backupRestore'].includes(String(form.get('action'))))revalidatePath('/');
  if(error instanceof z.ZodError)return {error:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')};
  if(error instanceof BusinessError||error instanceof AccessError||error instanceof AuthError)return {error:error.message};
  console.error('CRM operation failed',error instanceof Error?error.name:'Unknown error');
  return {error:'Не удалось сохранить данные. Попробуйте ещё раз.'};
 }
 if(restored){(await cookies()).delete(sessionCookie);redirect('/login?restored=1');}
 return {error:'Не удалось завершить операцию'};
}
