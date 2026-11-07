import type {Booking,Trip} from './crm';
import type {FinanceTrip,Expense,Payout} from './finance';
import type {CustomerMovement} from './customer-workspace';
type ReportTrip=Omit<Trip,'departure_at'|'ends_at'|'completed_at'|'cancelled_at'>&{departure_at:string;ends_at:string;completed_at:string|null;cancelled_at:string|null};
type ReportFinance=Omit<FinanceTrip,'approved_at'>&{approved_at:string|null};
type ReportBooking=Omit<Booking,'departure_at'>&{departure_at:string};
type ReportExpense=Omit<Expense,'created_at'|'voided_at'>&{created_at:string;voided_at:string|null};
type ReportPayout=Omit<Payout,'created_at'>&{created_at:string};
export type ReportData={trips:ReportTrip[];bookings:ReportBooking[];finance:{trips:ReportFinance[];expenses:ReportExpense[];payouts:ReportPayout[]};movements:CustomerMovement[]};
export type ReportFilters={from:string;to:string;currency:string;route:string;driver:string};
export const reportDay=(iso:string)=>new Date(iso).toLocaleDateString('en-CA',{timeZone:'Asia/Bishkek'});
export const routeName=(t:{origin:string;destination:string})=>`${t.origin} → ${t.destination}`;
export function validPeriod(from:string,to:string){const valid=(day:string)=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&!Number.isNaN(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day;return valid(from)&&valid(to)&&from<=to;}
export type TripReportRow={trip:ReportTrip;finance:ReportFinance;passengers:number;reserved:number;debt:number;driverDue:number|null};
export type CashRow={id:string;trip_id:string;booking_id:string|null;kind:'payment'|'refund'|'expense'|'payout';amount:number;cash:number;currency:string;at:string;description:string;method:string};
export function buildReport(data:ReportData,f:ReportFilters){
 const inPeriod=(iso:string)=>validPeriod(f.from,f.to)&&reportDay(iso)>=f.from&&reportDay(iso)<=f.to;
 const scope=data.trips.filter(t=>(!f.currency||t.currency===f.currency)&&(!f.route||routeName(t)===f.route)&&(!f.driver||(t.driver_id??'unassigned')===f.driver));
 const scopeIds=new Set(scope.map(t=>t.id));
 const rows:TripReportRow[]=scope.filter(t=>inPeriod(t.departure_at)).flatMap(trip=>{
  const finance=data.finance.trips.find(t=>t.id===trip.id);if(!finance)return [];
  const bookings=data.bookings.filter(b=>b.trip_id===trip.id&&b.status==='confirmed');
  return [{trip,finance,passengers:bookings.reduce((n,b)=>n+b.passenger_count,0),reserved:bookings.reduce((n,b)=>n+b.seats,0),debt:bookings.reduce((n,b)=>n+Math.max(0,b.total_minor-b.paid_minor),0),driverDue:finance.approved_at===null?null:Math.max(0,(finance.fee_minor??0)+(finance.reimbursement_minor??0)-finance.paid_driver_minor)}];
 });
 const ledger:CashRow[]=[];
 for(const m of data.movements) {const booking=data.bookings.find(b=>b.id===m.booking_id);if(!booking||!scopeIds.has(booking.trip_id)||!inPeriod(m.created_at))continue;ledger.push({id:m.id,trip_id:booking.trip_id,booking_id:m.booking_id,kind:m.kind,amount:m.amount_minor,cash:m.kind==='refund'?-m.amount_minor:m.amount_minor,currency:m.currency,at:m.created_at,description:booking.name,method:m.method});}
 for(const e of data.finance.expenses){const trip=scope.find(t=>t.id===e.trip_id);if(!trip||e.voided_at||!inPeriod(e.created_at))continue;ledger.push({id:e.id,trip_id:e.trip_id,booking_id:null,kind:'expense',amount:e.amount_minor,cash:e.paid_by==='park'?-e.amount_minor:0,currency:trip.currency,at:e.created_at,description:`${e.description} · ${e.paid_by==='driver'?'оплатил водитель':'оплатил парк'}`,method:e.paid_by});}
 for(const p of data.finance.payouts){const trip=scope.find(t=>t.id===p.trip_id);if(!trip||!inPeriod(p.created_at))continue;ledger.push({id:p.id,trip_id:p.trip_id,booking_id:null,kind:'payout',amount:p.amount_minor,cash:-p.amount_minor,currency:trip.currency,at:p.created_at,description:trip.driver_name??'Водитель',method:p.method});}
 ledger.sort((a,b)=>b.at.localeCompare(a.at)||a.id.localeCompare(b.id));
 return {rows,ledger};
}
export function reportTotals(rows:TripReportRow[]){
 return [...new Set(rows.map(r=>r.trip.currency))].sort().map(currency=>{
  const group=rows.filter(r=>r.trip.currency===currency),sum=(fn:(r:TripReportRow)=>number)=>group.reduce((n,r)=>n+fn(r),0);
  return {currency,trips:group.length,passengers:sum(r=>r.passengers),reserved:sum(r=>r.reserved),capacity:sum(r=>r.trip.status==='cancelled'?0:r.trip.capacity),revenue:sum(r=>r.finance.revenue_minor??0),received:sum(r=>r.finance.received_minor??0),refunds:sum(r=>r.finance.refunded_minor??0),expenses:sum(r=>r.finance.expenses_minor??0),payouts:sum(r=>r.finance.paid_driver_minor),debt:sum(r=>r.debt),driverDue:sum(r=>r.driverDue??0),unapproved:group.filter(r=>r.driverDue===null&&r.trip.driver_id).length,cash:sum(r=>r.finance.cash_minor??0),knownResult:sum(r=>r.finance.result_minor??0),unknownResult:group.filter(r=>r.finance.result_minor===null).length};
 });
}
export function reportGroups(rows:TripReportRow[],by:'route'|'driver'){
 const keys=[...new Set(rows.map(r=>by==='route'?routeName(r.trip):r.trip.driver_id??'unassigned'))];
 return keys.flatMap(key=>{const group=rows.filter(r=>(by==='route'?routeName(r.trip):r.trip.driver_id??'unassigned')===key);return reportTotals(group).map(total=>({...total,key,label:by==='route'?key:group[0].trip.driver_name??'Без водителя'}));});
}
export function reportCsv(rows:(string|number|null)[][]){
 const cell=(value:string|number|null)=>{let text=value===null?'':typeof value==='number'?String(value).replace('.',','):value;if(typeof value==='string'&&/^[\s\uFEFF]*[=+\-@]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
 return '\uFEFF'+rows.map(row=>row.map(cell).join(';')).join('\r\n')+'\r\n';
}
