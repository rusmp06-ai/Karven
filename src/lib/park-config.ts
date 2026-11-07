export const parkCurrencies=['KGS','KZT','RUB','USD'] as const;
export type ParkSettings={name:string;default_currency:string;version:number};
export type RouteTemplate={id:string;origin:string;destination:string;currency:string;capacity:number;duration_minutes:number;seat_minor:number|null;vehicle_minor:number|null;active:boolean;version:number};
export type ParkConfig={park:ParkSettings;routes:RouteTemplate[]};
export const defaultParkConfig:ParkConfig={park:{name:'KARVEN',default_currency:'KGS',version:1},routes:[]};
const normalized=(s:string)=>s.trim().replace(/\s+/g,' ').toLowerCase();
export function routeTariff(routes:RouteTemplate[],trip:{origin:string;destination:string;currency:string},kind:'seats'|'vehicle',count:number){
 const route=routes.find(r=>r.active&&r.currency===trip.currency&&normalized(r.origin)===normalized(trip.origin)&&normalized(r.destination)===normalized(trip.destination));
 if(!route)return null;
 const unit=kind==='vehicle'?route.vehicle_minor:route.seat_minor;
 if(unit===null)return null;
 const total=kind==='vehicle'?unit:unit*count;
 if(!Number.isSafeInteger(total)||total<0||total>999999999)return null;
 return {route,total,unit};
}
export const inputMoney=(minor:number)=>(minor/100).toFixed(2);
