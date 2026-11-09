import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database,DbTransaction} from './database-types';
import {requireRole,type Actor} from './access';
import {BusinessError,toMinor} from './crm';
import {recordAudit} from './audit';
import {once} from './idempotency';
const currency=z.string().regex(/^[A-Z]{3}$/),requestId=z.uuid();
export type Shift={id:string;user_id:string;user_name?:string;user_active?:boolean;opened_at:string;closed_at:string|null;close_note:string};
export type ShiftBalance={currency:string;opening_minor:number;expected_minor:number;declared_minor:number|null};
const safe=(value:unknown)=>{const n=Number(value);if(!Number.isSafeInteger(n))throw new BusinessError('Сумма выходит за поддерживаемый диапазон');return n;};
export async function activeShift(tx:DbTransaction,actor:Actor,required=false){
 const shift=(await tx.query<{id:string;user_id:string}>('SELECT id,user_id FROM work_shifts WHERE user_id=$1 AND closed_at IS NULL FOR UPDATE',[actor.id])).rows[0];
 if(required&&!shift&&actor.role==='dispatcher')throw new BusinessError('Сначала откройте рабочую смену для учёта наличных');
 return shift?.id??null;
}
export async function shiftBalances(tx:DbTransaction,id:string):Promise<ShiftBalance[]>{
 const shift=(await tx.query<{closed_at:string|null}>('SELECT closed_at FROM work_shifts WHERE id=$1',[id])).rows[0];if(!shift)throw new BusinessError('Смена не найдена');
 if(shift.closed_at)return (await tx.query<ShiftBalance>('SELECT currency,opening_minor,expected_minor,declared_minor FROM shift_balances WHERE shift_id=$1 ORDER BY currency',[id])).rows.map(r=>({...r,opening_minor:safe(r.opening_minor),expected_minor:safe(r.expected_minor),declared_minor:safe(r.declared_minor)}));
 const result=await tx.query<{currency:string;opening:string;net:string}>(`WITH movements AS(
 SELECT currency,opening_minor AS value,opening_minor AS opening FROM shift_balances WHERE shift_id=$1
 UNION ALL SELECT t.currency,p.amount_minor,0 FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN trips t ON t.id=b.trip_id WHERE p.shift_id=$1 AND p.method='cash'
 UNION ALL SELECT t.currency,-r.amount_minor,0 FROM refunds r JOIN bookings b ON b.id=r.booking_id JOIN trips t ON t.id=b.trip_id WHERE r.shift_id=$1 AND r.method='cash'
 UNION ALL SELECT t.currency,-e.amount_minor,0 FROM trip_expenses e JOIN trips t ON t.id=e.trip_id WHERE e.shift_id=$1 AND e.method='cash' AND e.paid_by='park' AND e.voided_at IS NULL
 UNION ALL SELECT t.currency,-p.amount_minor,0 FROM driver_payouts p JOIN trips t ON t.id=p.trip_id WHERE p.shift_id=$1 AND p.method='cash'
 UNION ALL SELECT currency,-amount_minor,0 FROM cash_transfers WHERE from_shift_id=$1 AND status='accepted'
 UNION ALL SELECT currency,amount_minor,0 FROM cash_transfers WHERE to_shift_id=$1 AND status='accepted'
 UNION ALL SELECT currency,amount_minor,0 FROM cash_adjustments WHERE shift_id=$1
 ) SELECT currency,SUM(opening)::text AS opening,SUM(value)::text AS net FROM movements GROUP BY currency ORDER BY currency`,[id]);
 return result.rows.map(r=>({currency:r.currency,opening_minor:safe(r.opening),expected_minor:safe(r.net),declared_minor:null}));
}
export function createCashShifts(db:Database,actor:Actor){const access=()=>requireRole(actor,'dispatcher');return {
 async open(raw:unknown){access();const input=z.object({requestId}).parse(raw);let id='';await db.transaction(tx=>once(tx,actor,input.requestId,'shift.open',input,async()=>{
  if(await activeShift(tx,actor))throw new BusinessError('Смена уже открыта');id=randomUUID();await tx.query('INSERT INTO work_shifts(id,user_id) VALUES($1,$2)',[id,actor.id]);
  const previous=(await tx.query<{id:string}>('SELECT id FROM work_shifts WHERE user_id=$1 AND closed_at IS NOT NULL ORDER BY closed_at DESC,id DESC LIMIT 1',[actor.id])).rows[0];
  if(previous)await tx.query('INSERT INTO shift_balances(shift_id,currency,opening_minor) SELECT $1,currency,declared_minor FROM shift_balances WHERE shift_id=$2',[id,previous.id]);
  await recordAudit(tx,actor,id,'shift.opened',{previousShiftId:previous?.id??null});
 }));return id||(await activeShift(db,actor))!;},
 async close(raw:unknown){access();const input=z.object({shiftId:z.uuid(),counts:z.array(z.object({currency,amount:z.string().regex(/^\d{1,10}(\.\d{1,2})?$/)})).max(20),note:z.string().trim().max(1000).default(''),requestId}).parse(raw);
  await db.transaction(tx=>once(tx,actor,input.requestId,'shift.close',input,async()=>{
   if(await activeShift(tx,actor)!==input.shiftId)throw new BusinessError('Выберите свою открытую смену');
   if((await tx.query("SELECT id FROM cash_transfers WHERE status='pending' AND (from_shift_id=$1 OR to_shift_id=$1) LIMIT 1",[input.shiftId])).rows.length)throw new BusinessError('Сначала примите или отклоните незавершённые передачи наличных');
   if(new Set(input.counts.map(c=>c.currency)).size!==input.counts.length)throw new BusinessError('Валюта повторяется');const balances=await shiftBalances(tx,input.shiftId);
   if(balances.some(b=>!input.counts.some(c=>c.currency===b.currency)))throw new BusinessError('Укажите пересчитанную сумму по каждой валюте');
   const results=[];for(const c of input.counts){const declared=safe(Math.round(Number(c.amount)*100)),b=balances.find(b=>b.currency===c.currency),expected=b?.expected_minor??0;if(declared!==expected&&input.note.length<3)throw new BusinessError('Объясните расхождение по кассе');
    await tx.query('INSERT INTO shift_balances(shift_id,currency,opening_minor,expected_minor,declared_minor) VALUES($1,$2,$3,$4,$5) ON CONFLICT(shift_id,currency) DO UPDATE SET expected_minor=EXCLUDED.expected_minor,declared_minor=EXCLUDED.declared_minor',[input.shiftId,c.currency,b?.opening_minor??0,expected,declared]);results.push({currency:c.currency,expected,declared,difference:declared-expected});}
   await tx.query('UPDATE work_shifts SET closed_at=now(),close_note=$2 WHERE id=$1',[input.shiftId,input.note]);await recordAudit(tx,actor,input.shiftId,'shift.closed',{balances:results,note:input.note});
  }));
 },
 async transfer(raw:unknown){access();const input=z.object({toShiftId:z.uuid(),currency,amount:z.string().regex(/^\d{1,7}(\.\d{1,2})?$/),reason:z.string().trim().min(3).max(500),requestId}).parse(raw);const amount=toMinor(input.amount);if(amount<=0)throw new BusinessError('Сумма должна быть больше нуля');
  await db.transaction(tx=>once(tx,actor,input.requestId,'cash.transfer',input,async()=>{const from=await activeShift(tx,actor,true);const to=(await tx.query<{user_id:string}>("SELECT s.user_id FROM work_shifts s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.closed_at IS NULL AND u.active=true AND u.role='dispatcher' FOR UPDATE OF s",[input.toShiftId])).rows[0];if(!to||to.user_id===actor.id)throw new BusinessError('Выберите открытую смену другого менеджера');
   const available=(await shiftBalances(tx,from!)).find(b=>b.currency===input.currency)?.expected_minor??0,pending=safe((await tx.query<{n:string}>("SELECT COALESCE(SUM(amount_minor),0)::text AS n FROM cash_transfers WHERE from_shift_id=$1 AND currency=$2 AND status='pending'",[from,input.currency])).rows[0].n);if(amount>available-pending)throw new BusinessError('Недостаточно учтённых наличных для передачи');
   const id=randomUUID();await tx.query('INSERT INTO cash_transfers(id,from_shift_id,to_shift_id,currency,amount_minor,reason) VALUES($1,$2,$3,$4,$5,$6)',[id,from,input.toShiftId,input.currency,amount,input.reason]);await recordAudit(tx,actor,id,'cash.transfer_requested',{fromShiftId:from,toShiftId:input.toShiftId,currency:input.currency,amountMinor:amount,reason:input.reason});
  }));
 },
 async decideTransfer(raw:unknown){access();const input=z.object({transferId:z.uuid(),decision:z.enum(['accepted','rejected']),requestId}).parse(raw);await db.transaction(tx=>once(tx,actor,input.requestId,'cash.transfer_decide',input,async()=>{
  const transfer=(await tx.query<{from_shift_id:string;to_shift_id:string;currency:string;amount_minor:number;status:string}>('SELECT * FROM cash_transfers WHERE id=$1 FOR UPDATE',[input.transferId])).rows[0];if(!transfer||transfer.status!=='pending')throw new BusinessError('Передача уже обработана или не найдена');
  const own=await activeShift(tx,actor,true);if(own!==transfer.to_shift_id&&!(input.decision==='rejected'&&own===transfer.from_shift_id))throw new BusinessError('Подтвердить передачу может только получатель');
  if(input.decision==='accepted'&&((await shiftBalances(tx,transfer.from_shift_id)).find(b=>b.currency===transfer.currency)?.expected_minor??0)<transfer.amount_minor)throw new BusinessError('У отправителя изменился остаток наличных. Уточните передачу');
  await tx.query('UPDATE cash_transfers SET status=$2,decided_at=now(),decided_by=$3 WHERE id=$1',[input.transferId,input.decision,actor.id]);await recordAudit(tx,actor,input.transferId,`cash.transfer_${input.decision}`,{amountMinor:transfer.amount_minor,currency:transfer.currency,reason:own===transfer.from_shift_id?'Отправитель отозвал ожидающую передачу':input.decision==='accepted'?'Получатель подтвердил наличные':'Получатель отклонил передачу'});
 }));},
 async adjust(raw:unknown){access();const input=z.object({currency,amount:z.string().regex(/^-?\d{1,7}(\.\d{1,2})?$/),reason:z.string().trim().min(10).max(1000),reference:z.string().trim().min(3).max(200),requestId}).parse(raw),value=Math.round(Number(input.amount)*100);if(!value)throw new BusinessError('Укажите ненулевую корректировку');await db.transaction(tx=>once(tx,actor,input.requestId,'cash.adjust',input,async()=>{const shift=await activeShift(tx,actor,true),id=randomUUID();await tx.query('INSERT INTO cash_adjustments(id,shift_id,currency,amount_minor,reason,document_reference,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,shift,input.currency,value,input.reason,input.reference,actor.id]);await recordAudit(tx,actor,id,'cash.adjusted',{shiftId:shift,currency:input.currency,amountMinor:value,reason:input.reason,reference:input.reference});}));},
 async view(){requireRole(actor,'dispatcher','owner');const shifts=(await db.query<Shift>('SELECT s.*,u.name AS user_name,u.active AS user_active FROM work_shifts s JOIN users u ON u.id=s.user_id WHERE ($1::boolean OR s.user_id=$2 OR s.closed_at IS NULL) ORDER BY s.opened_at DESC LIMIT 200',[actor.role==='owner',actor.id])).rows;const current=shifts.find(s=>s.user_id===actor.id&&!s.closed_at);const balances=current?await shiftBalances(db,current.id):[];const transfers=(await db.query<Record<string,unknown>>(`SELECT c.*,f.user_id AS from_user_id,t.user_id AS to_user_id,u.name AS from_name,v.name AS to_name FROM cash_transfers c JOIN work_shifts f ON f.id=c.from_shift_id JOIN work_shifts t ON t.id=c.to_shift_id JOIN users u ON u.id=f.user_id JOIN users v ON v.id=t.user_id WHERE ($1::boolean OR f.user_id=$2 OR t.user_id=$2) ORDER BY c.created_at DESC LIMIT 100`,[actor.role==='owner',actor.id])).rows;return {shifts:shifts.map(s=>({...s,opened_at:new Date(s.opened_at).toISOString(),closed_at:s.closed_at?new Date(s.closed_at).toISOString():null})),currentId:current?.id??null,balances,transfers};}
 };}
