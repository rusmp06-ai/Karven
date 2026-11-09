import {reportCsv} from './reporting';
export type LedgerExportRow={date:string;title:string;name:string;route:string;method:string;currency:string;value:number;cash:number};
export function ledgerCsv(rows:LedgerExportRow[]){
 return reportCsv([['Дата','Операция','Клиент / водитель','Рейс','Способ','Сумма операции','Изменение денег парка','Валюта'],...rows.map(r=>[r.date,r.title,r.name,r.route,r.method,r.value/100,r.cash/100,r.currency])]);
}
export function ledgerTotals(rows:Pick<LedgerExportRow,'currency'|'cash'>[]){
 return [...new Set(rows.map(r=>r.currency))].sort().map(currency=>{const group=rows.filter(r=>r.currency===currency);return {currency,incoming:group.reduce((n,r)=>n+Math.max(0,r.cash),0),outgoing:group.reduce((n,r)=>n+Math.max(0,-r.cash),0),net:group.reduce((n,r)=>n+r.cash,0)};});
}
