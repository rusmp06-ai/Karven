import {it,expect} from 'vitest';
import {ledgerCsv,ledgerTotals,type LedgerExportRow} from '../src/lib/ledger-export';
const row=(patch:Partial<LedgerExportRow>={}):LedgerExportRow=>({date:'2026-11-09T00:00:00Z',title:'Оплата',name:'Клиент',route:'Бишкек → Каракол',method:'Наличные',currency:'KGS',value:100000,cash:100000,...patch});
it('не списывает расходы водителя повторно при возмещении и не смешивает валюты',()=>{
 const totals=ledgerTotals([row(),row({title:'Расход водителя',value:-10000,cash:0}),row({title:'Возмещение',value:-10000,cash:-10000}),row({title:'Расход парка',value:-5000,cash:-5000}),row({currency:'USD',value:700,cash:700})]);
 expect(totals).toEqual([{currency:'KGS',incoming:100000,outgoing:15000,net:85000},{currency:'USD',incoming:700,outgoing:0,net:700}]);
});
it('защищает формулы после пробелов и BOM, сохраняя отрицательные суммы числами',()=>{
 const csv=ledgerCsv([row({name:' \t=HYPERLINK("bad")',route:'\uFEFF+SUM(1)',value:-150025,cash:0})]);
 expect(csv).toContain('"\' \t=HYPERLINK');expect(csv).toContain('"\'\uFEFF+SUM(1)"');expect(csv).toContain('"-1500,25"');expect(csv).toContain('Изменение денег парка');expect(csv).toContain('"0";"KGS"');
});
