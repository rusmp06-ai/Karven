import type {Booking} from './crm';
import type {WorkTask} from './customer-workspace';
import type {Driver,Vehicle} from './fleet';
type Order=Pick<Booking,'id'|'trip_id'|'status'|'seats'|'passenger_count'|'attendance'|'total_minor'|'paid_minor'|'pickup_address'|'dropoff_address'>;
type Trip={id:string;status:string;departure_at:string;capacity:number;driver_id:string|null;vehicle_id:string|null};
export function tripReadiness<T extends Order>(trip:Trip,bookings:T[],tasks:WorkTask[],drivers:Driver[],vehicles:Vehicle[],now:number){
 const active=bookings.filter(b=>b.trip_id===trip.id&&b.status==='confirmed');
 const passengers=active.reduce((n,b)=>n+b.passenger_count,0),reserved=active.reduce((n,b)=>n+b.seats,0);
 const boarded=active.reduce((n,b)=>n+b.attendance.filter(a=>a.status==='boarded').length,0),noShow=active.reduce((n,b)=>n+b.attendance.filter(a=>a.status==='no_show').length,0);
 const pending=passengers-boarded-noShow,debt=active.reduce((n,b)=>n+Math.max(0,b.total_minor-b.paid_minor),0),paid=active.reduce((n,b)=>n+b.paid_minor,0);
 const missingAddresses=active.filter(b=>!b.pickup_address.trim()||!b.dropoff_address.trim()).length;
 const linkedTasks=tasks.filter(t=>t.trip_id===trip.id),openTasks=linkedTasks.filter(t=>!['done','cancelled'].includes(t.status));
 const driver=drivers.find(d=>d.id===trip.driver_id),vehicle=vehicles.find(v=>v.id===trip.vehicle_id);
 const resourceIssues:string[]=[];
 if(!trip.driver_id)resourceIssues.push('Не назначен водитель');
 else if(!driver)resourceIssues.push('Проверьте карточку водителя');
 else{if(driver.status!=='available')resourceIssues.push('Водитель недоступен');if(new Date(`${driver.license_expires}T23:59:59+06:00`).getTime()<new Date(trip.departure_at).getTime())resourceIssues.push('Удостоверение истекает до отправления');}
 if(!trip.vehicle_id)resourceIssues.push('Не назначен автомобиль');
 else if(!vehicle||vehicle.status!=='available')resourceIssues.push('Автомобиль недоступен для выезда');
 if(reserved>trip.capacity)resourceIssues.push('Превышена вместимость рейса');
 const closureIssues:string[]=[];
 if(trip.status==='scheduled'){
  if(!trip.driver_id||!trip.vehicle_id)closureIssues.push('Назначьте водителя и автомобиль');
  if(new Date(trip.departure_at).getTime()>now)closureIssues.push('Дождитесь времени отправления');
  if(pending>0)closureIssues.push(`Отметьте посадку или неявку: ${pending}`);
 }
 return {active,passengers,reserved,free:Math.max(0,trip.capacity-reserved),boarded,noShow,pending,debt,paid,missingAddresses,linkedTasks,openTasks,overdueTasks:openTasks.filter(t=>new Date(t.due_at).getTime()<now),resourceIssues,closureIssues};
}
