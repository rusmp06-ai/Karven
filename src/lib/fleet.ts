import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { type Actor, requireRole } from './access';
import { recordAudit } from './audit';
import { BusinessError } from './crm';
const name=z.string().trim().min(1).max(120);
const uuid=z.string().uuid();
export type Driver={id:string;name:string;phone:string;kind:'staff'|'partner';status:'available'|'unavailable';license_number:string;license_expires:string};
export type Vehicle={id:string;plate:string;model:string;capacity:number;owner_name:string;kind:'park'|'partner';status:'available'|'maintenance'|'unavailable'};
export function createFleet(db:PGlite,actor:Actor) {
 return {
  async list() {
   requireRole(actor,'owner','dispatcher');
   const drivers=(await db.query<Driver>("SELECT id,name,phone,kind,status,license_number,to_char(license_expires,'YYYY-MM-DD') AS license_expires FROM drivers ORDER BY name")).rows;
   const vehicles=(await db.query<Vehicle>('SELECT * FROM vehicles ORDER BY plate')).rows;
   return {drivers,vehicles};
  },
  async saveDriver(raw:unknown) {
   requireRole(actor,'owner','dispatcher');
   const input=z.object({id:uuid.optional(),name,phone:z.string().trim().regex(/^\+?[\d ()-]{7,25}$/),kind:z.enum(['staff','partner']),status:z.enum(['available','unavailable']),licenseNumber:name,licenseExpires:z.iso.date()}).parse(raw);
   const id=input.id??randomUUID();
   await db.transaction(async tx=>{
    if(input.id) {
     if(!(await tx.query('SELECT id FROM drivers WHERE id=$1 FOR UPDATE',[id])).rows.length)throw new BusinessError('Водитель не найден');
     const {rows}=await tx.query<{id:string}>("SELECT id FROM trips WHERE driver_id=$1 AND status='scheduled' AND ends_at>now() AND ($2='unavailable' OR (ends_at AT TIME ZONE 'Asia/Bishkek')::date>$3::date)",[id,input.status,input.licenseExpires]);
     if(rows.length)throw new BusinessError('Сначала замените водителя в предстоящих рейсах: статус или срок удостоверения конфликтуют с назначением');
     await tx.query('UPDATE drivers SET name=$2,phone=$3,kind=$4,status=$5,license_number=$6,license_expires=$7 WHERE id=$1',[id,input.name,input.phone,input.kind,input.status,input.licenseNumber,input.licenseExpires]);
    } else await tx.query('INSERT INTO drivers(id,name,phone,kind,status,license_number,license_expires) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,input.name,input.phone,input.kind,input.status,input.licenseNumber,input.licenseExpires]);
    await recordAudit(tx,actor,id,input.id?'driver.updated':'driver.created');
   });return id;
  },
  async saveVehicle(raw:unknown) {
   requireRole(actor,'owner','dispatcher');
   const input=z.object({id:uuid.optional(),plate:z.string().trim().min(2).max(24).transform(s=>s.toUpperCase().replace(/\s+/g,'')),model:name,capacity:z.coerce.number().int().min(1).max(60),ownerName:name,kind:z.enum(['park','partner']),status:z.enum(['available','maintenance','unavailable'])}).parse(raw);
   const id=input.id??randomUUID();
   await db.transaction(async tx=>{
    if((await tx.query('SELECT id FROM vehicles WHERE plate=$1 AND id<>$2',[input.plate,id])).rows.length)throw new BusinessError('Автомобиль с таким номером уже существует');
    if(input.id) {
     if(!(await tx.query('SELECT id FROM vehicles WHERE id=$1 FOR UPDATE',[id])).rows.length)throw new BusinessError('Автомобиль не найден');
     if((await tx.query("SELECT id FROM trips WHERE vehicle_id=$1 AND status='scheduled' AND ends_at>now() AND ($2<>'available' OR capacity>$3)",[id,input.status,input.capacity])).rows.length)throw new BusinessError('Сначала измените назначения: статус или вместимость конфликтуют с предстоящими рейсами');
     await tx.query('UPDATE vehicles SET plate=$2,model=$3,capacity=$4,owner_name=$5,kind=$6,status=$7 WHERE id=$1',[id,input.plate,input.model,input.capacity,input.ownerName,input.kind,input.status]);
    } else await tx.query('INSERT INTO vehicles(id,plate,model,capacity,owner_name,kind,status) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,input.plate,input.model,input.capacity,input.ownerName,input.kind,input.status]);
    await recordAudit(tx,actor,id,input.id?'vehicle.updated':'vehicle.created');
   });return id;
  },
  async assign(raw:unknown) {
   requireRole(actor,'owner','dispatcher');
   const input=z.object({tripId:uuid,driverId:uuid,vehicleId:uuid,endsAt:z.iso.datetime({offset:true})}).parse(raw);
   await db.transaction(async tx=>{
    // PGlite serializes transactions. Row locks preserve the intent for a server PostgreSQL adapter.
    const trip=(await tx.query<{departure_at:Date;status:string;driver_id:string|null;vehicle_id:string|null}>('SELECT * FROM trips WHERE id=$1 FOR UPDATE',[input.tripId])).rows[0];
    if(!trip)throw new BusinessError('Рейс не найден');
    if((trip.driver_id!==input.driverId||trip.vehicle_id!==input.vehicleId)&&(await tx.query("SELECT a.booking_id FROM passenger_attendance a JOIN bookings b ON b.id=a.booking_id WHERE b.trip_id=$1 AND b.status='confirmed' LIMIT 1",[input.tripId])).rows.length)throw new BusinessError('Сначала исправьте отметки пассажиров перед заменой водителя или автомобиля');
    if(trip.driver_id && trip.driver_id!==input.driverId && (await tx.query("SELECT id FROM trip_expenses WHERE trip_id=$1 AND paid_by='driver' AND voided_at IS NULL",[input.tripId])).rows.length)throw new BusinessError('Сначала аннулируйте расходы прежнего водителя перед заменой');
    if(trip.status!=='scheduled'||new Date(trip.departure_at).getTime()<=Date.now())throw new BusinessError('Изменять назначение можно только до отправления');
    if(new Date(input.endsAt)<=new Date(trip.departure_at))throw new BusinessError('Окончание должно быть позже отправления');
    const driver=(await tx.query<Driver>("SELECT id,name,phone,kind,status,license_number,to_char(license_expires,'YYYY-MM-DD') AS license_expires FROM drivers WHERE id=$1 FOR UPDATE",[input.driverId])).rows[0];
    const vehicle=(await tx.query<Vehicle>('SELECT * FROM vehicles WHERE id=$1 FOR UPDATE',[input.vehicleId])).rows[0];
    if(!driver||driver.status!=='available')throw new BusinessError('Водитель недоступен');
    if(!vehicle||vehicle.status!=='available')throw new BusinessError('Автомобиль недоступен');
    const endDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bishkek',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(input.endsAt));
    if(driver.license_expires<endDate)throw new BusinessError('Удостоверение водителя истекает до окончания рейса');
    const occupied=(await tx.query<{count:number}>("SELECT COALESCE(SUM(seats),0)::integer AS count FROM bookings WHERE trip_id=$1 AND status='confirmed'",[input.tripId])).rows[0].count;
    const exclusive=(await tx.query<{id:string;passenger_count:number}>("SELECT id,passenger_count FROM bookings WHERE trip_id=$1 AND status='confirmed' AND booking_type='vehicle'",[input.tripId])).rows[0];
    if(exclusive && vehicle.capacity<exclusive.passenger_count)throw new BusinessError('В машине меньше мест, чем пассажиров');
    if(!exclusive && vehicle.capacity<occupied)throw new BusinessError('В машине меньше мест, чем уже забронировано');
    const conflicts=(await tx.query<{driver_id:string;vehicle_id:string}>("SELECT driver_id,vehicle_id FROM trips WHERE id<>$1 AND status='scheduled' AND departure_at<$3 AND ends_at>$2 AND (driver_id=$4 OR vehicle_id=$5)",[input.tripId,trip.departure_at,input.endsAt,input.driverId,input.vehicleId])).rows;
    if(conflicts.length)throw new BusinessError('Водитель или автомобиль уже назначен на пересекающийся рейс');
    // The vehicle becomes the source of passenger capacity; future bookings use this value.
    if(exclusive)await tx.query('UPDATE bookings SET seats=$2 WHERE id=$1',[exclusive.id,vehicle.capacity]);
    await tx.query('UPDATE trips SET driver_id=$2,vehicle_id=$3,ends_at=$4,capacity=$5 WHERE id=$1',[input.tripId,input.driverId,input.vehicleId,input.endsAt,vehicle.capacity]);
    await recordAudit(tx,actor,input.tripId,'trip.assigned',{driverId:input.driverId,vehicleId:input.vehicleId,endsAt:input.endsAt,capacity:vehicle.capacity});
   });
  },
 };
}
