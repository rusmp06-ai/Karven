import {beforeEach,afterEach,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {schema} from '../src/lib/schema';
import {createParkSettings} from '../src/lib/park-settings';
import {routeTariff} from '../src/lib/park-config';
import {createCrm} from '../src/lib/crm';
import {owner,seedOwner} from './helpers';
let db:PGlite,service:ReturnType<typeof createParkSettings>;
beforeEach(async()=>{db=new PGlite();await db.exec(schema);await seedOwner(db);service=createParkSettings(db,owner)},30000);
afterEach(async()=>{await db.close()});
const route=()=>({origin:'Бишкек',destination:'Нарын',currency:'KGS',capacity:6,durationMinutes:240,seatPrice:'125.50',vehiclePrice:'600',active:'true',requestId:randomUUID()});
it('сохраняет настройки один раз, устаревшая форма не перезаписывает новую',async()=>{
 const raw={name:'Наш парк',defaultCurrency:'KZT',version:1,requestId:randomUUID()};await service.savePark(raw);await service.savePark(raw);expect((await service.list()).park).toMatchObject({name:'Наш парк',default_currency:'KZT',version:2});await expect(service.savePark({...raw,name:'Устаревший парк',requestId:randomUUID()})).rejects.toThrow('уже изменены');
});
it('хранит точные тарифы и длительность, повтор не дублируется, регистр не создаёт копию',async()=>{
 const raw=route();await service.saveRoute(raw);await service.saveRoute(raw);expect((await service.list()).routes).toMatchObject([{seat_minor:12550,vehicle_minor:60000,duration_minutes:240,capacity:6,active:true}]);await expect(service.saveRoute({...raw,origin:'  БИШКЕК  ',requestId:randomUUID()})).rejects.toThrow('уже есть');
});
it('менеджер управляет архивом маршрутов, водитель не имеет доступа к настройкам',async()=>{
 await service.saveRoute({...route(),active:'false'});expect((await service.list()).routes).toHaveLength(1);const dispatcher=createParkSettings(db,{...owner,role:'dispatcher'}),driver=createParkSettings(db,{...owner,role:'driver'});expect((await dispatcher.list()).routes).toHaveLength(1);expect((await driver.list()).routes).toEqual([]);expect((await driver.list()).park.name).toBe('KARVEN');await dispatcher.saveRoute({...route(),id:(await dispatcher.list()).routes[0].id,version:1,active:'true'});await expect(driver.savePark({})).rejects.toThrow('прав');await expect(driver.saveRoute(route())).rejects.toThrow('прав');
});
it('изменение тарифа и валюты парка не меняет цену брони, оплату и валюту рейса',async()=>{
 await service.saveRoute(route());const saved=(await service.list()).routes[0];const crm=createCrm(db,owner);const tripId=await crm.createTrip({origin:'Бишкек',destination:'Нарын',departureAt:new Date(Date.now()+86400000).toISOString(),capacity:6,currency:'KGS'});await crm.createBooking({tripId,name:'Клиент',phone:'+996555111222',seats:1,total:'125.50',initialPayment:'50'});await service.saveRoute({...route(),id:saved.id,version:1,seatPrice:'200'});await service.savePark({name:'Новый парк',defaultCurrency:'USD',version:1,requestId:randomUUID()});expect((await crm.dashboard()).bookings[0]).toMatchObject({total_minor:12550,paid_minor:5000,currency:'KGS'});await expect(service.saveRoute({...route(),id:saved.id,version:1})).rejects.toThrow('уже изменён');
});
it('валидирует направление, длительность, вместимость, валюту и цены',async()=>{
 for(const invalid of [{destination:'бишкек'},{durationMinutes:0},{capacity:61},{currency:'ABC'},{seatPrice:'1.999'},{vehiclePrice:'-1'}])await expect(service.saveRoute({...route(),...invalid})).rejects.toThrow();expect((await service.list()).routes).toHaveLength(0);
});
it('тариф учитывает пассажиров, всю машину, валюту, направление, ноль и отсутствие цены',async()=>{
 await service.saveRoute(route());const routes=(await service.list()).routes,trip={origin:'  БИШКЕК ',destination:'Нарын',currency:'KGS'};expect(routeTariff(routes,trip,'seats',2)?.total).toBe(25100);expect(routeTariff(routes,trip,'vehicle',2)?.total).toBe(60000);expect(routeTariff(routes,{...trip,currency:'USD'},'seats',2)).toBeNull();expect(routeTariff(routes,{origin:'Нарын',destination:'Бишкек',currency:'KGS'},'seats',2)).toBeNull();expect(routeTariff([{...routes[0],active:false}],trip,'seats',1)).toBeNull();expect(routeTariff([{...routes[0],seat_minor:null}],trip,'seats',1)).toBeNull();expect(routeTariff([{...routes[0],seat_minor:0}],trip,'seats',1)?.total).toBe(0);expect(routeTariff([{...routes[0],seat_minor:999999999}],trip,'seats',60)).toBeNull();
});
it('повтор миграции сохраняет изменённые настройки и архивные маршруты',async()=>{
 await service.savePark({name:'Сохранённый парк',defaultCurrency:'RUB',version:1,requestId:randomUUID()});await service.saveRoute({...route(),active:'false'});await db.exec(schema);expect((await service.list()).park).toMatchObject({name:'Сохранённый парк',default_currency:'RUB'});expect((await service.list()).routes).toHaveLength(1);
});
