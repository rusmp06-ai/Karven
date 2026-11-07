import {it,expect} from 'vitest';
import {tripReadiness} from '../src/lib/trip-readiness';
import type {WorkTask} from '../src/lib/customer-workspace';
import type {Driver,Vehicle} from '../src/lib/fleet';
const now=Date.parse('2026-11-07T12:00:00Z');
const trip={id:'trip',status:'scheduled',departure_at:'2026-11-07T11:00:00Z',capacity:6,driver_id:'driver',vehicle_id:'car'};
const order={id:'order',trip_id:'trip',status:'confirmed',seats:6,passenger_count:2,attendance:[] as {position:number;status:'boarded'|'no_show'}[],total_minor:100000,paid_minor:40000,pickup_address:'Чуй 10',dropoff_address:'Нарын, центр'};
const driver:Driver={id:'driver',name:'Водитель',phone:'996555111222',kind:'staff',status:'available',license_number:'TEST',license_expires:'2099-12-31'};
const car:Vehicle={id:'car',plate:'TEST',model:'Toyota',capacity:6,owner_name:'Парк',kind:'park',status:'available'};
it('отличает пассажиров от резерва всей машины и не включает отменённые или чужие заказы',()=>{
 const r=tripReadiness(trip,[order,{...order,id:'cancelled',status:'cancelled'},{...order,id:'other',trip_id:'other'}],[],[driver],[car],now);expect(r).toMatchObject({passengers:2,reserved:6,free:0,pending:2,debt:60000,paid:40000});expect(r.active).toHaveLength(1);
});
it('посадка и неявка закрывают отметки, долг и задачи не мешают завершению',()=>{
 const task={id:'task',trip_id:'trip',status:'open',due_at:'2026-11-07T10:00:00Z'} as WorkTask;
 const r=tripReadiness(trip,[{...order,attendance:[{position:0,status:'boarded'},{position:1,status:'no_show'}]}],[task,{...task,id:'done',status:'done'},{...task,id:'other',trip_id:'other'}],[driver],[car],now);
 expect(r).toMatchObject({boarded:1,noShow:1,pending:0,debt:60000,closureIssues:[]});expect(r.openTasks).toHaveLength(1);expect(r.overdueTasks).toHaveLength(1);
});
it('показывает отсутствующие назначения, адреса и время до отправления',()=>{
 const r=tripReadiness({...trip,departure_at:'2026-11-08T11:00:00Z',driver_id:null,vehicle_id:null},[{...order,pickup_address:' '}],[],[],[],now);expect(r.resourceIssues).toHaveLength(2);expect(r.missingAddresses).toBe(1);expect(r.closureIssues).toHaveLength(3);
});
it('сверяет удостоверение со временем рейса, замечает ремонт машины и не предлагает закрывать отменённый рейс',()=>{
 const r=tripReadiness({...trip,status:'cancelled',departure_at:'2026-12-01T11:00:00Z'},[],[],[{...driver,license_expires:'2026-11-15'}],[{...car,status:'maintenance'}],now);expect(r.resourceIssues).toHaveLength(2);expect(r.closureIssues).toEqual([]);
});
