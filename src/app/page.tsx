import {OwnerConsole} from './owner-ui';
import {loadOwnerView} from '@/lib/owner-view';
import {createCancellations} from '@/lib/cancellations';
import {createCashShifts} from '@/lib/cash-shifts';
import {backupLimit} from '@/lib/deployment';
import {withWorkspace} from '@/lib/workspace-lock';
import {createParkSettings} from '@/lib/park-settings';
import {createCustomerWorkspace,emptyWorkspace} from '@/lib/customer-workspace';
import { createCrm } from '@/lib/crm';
import { getDb } from '@/lib/db';
import { requireActor } from '@/lib/session';
import { createFleet } from '@/lib/fleet';
import { createFinance } from '@/lib/finance';
import { Dashboard, type ReceiptDay } from './ui';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export default async function Home({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {return withWorkspace(async()=>renderHome(await searchParams));}
async function renderHome(query:Record<string,string|string[]|undefined>) {
 const actor=await requireActor();
 const db=await getDb();
 if(actor.role==='owner')return <OwnerConsole actor={actor} data={await loadOwnerView(db,actor,query)} tab={typeof query.owner==='string'?query.owner:typeof query.tab==='string'?query.tab:'overview'} section={typeof query.section==='string'?query.section:'users'}/>;
 const [configuration,telegram,backups,data,workspace,fleet,users,finance,receiptResult,audit]=await Promise.all([
  createParkSettings(db,actor).list(),
  undefined,
  [],
  createCrm(db,actor).dashboard(),
  actor.role==='driver'?emptyWorkspace:createCustomerWorkspace(db,actor).list(),
  actor.role==='driver'?{drivers:[],vehicles:[]}:createFleet(db,actor).list(),
  [],
  createFinance(db,actor).report(),
  db.query<ReceiptDay>(`SELECT to_char(m.created_at AT TIME ZONE 'Asia/Bishkek','YYYY-MM-DD') AS day,t.currency,SUM(m.amount)::float8 AS amount FROM (SELECT booking_id,created_at,amount_minor::bigint AS amount FROM payments UNION ALL SELECT booking_id,created_at,-amount_minor::bigint AS amount FROM refunds) m JOIN bookings b ON b.id=m.booking_id JOIN trips t ON t.id=b.trip_id WHERE m.created_at>now()-interval '8 days' AND ($1::boolean=false OR t.driver_id=$2::uuid) GROUP BY 1,2 ORDER BY 1`,[actor.role==='driver',actor.driver_id]),
  [],
 ]);
 const receiptDays=receiptResult.rows;
 const cancellations=actor.role==='dispatcher'?await createCancellations(db,actor).list():[];const cash=actor.role==='dispatcher'?await createCashShifts(db,actor).view():undefined;
 const financeView={trips:finance.trips.map(t=>({...t,approved_at:t.approved_at?new Date(t.approved_at).toISOString():null})),expenses:finance.expenses.map(e=>({...e,created_at:new Date(e.created_at).toISOString(),voided_at:e.voided_at?new Date(e.voided_at).toISOString():null})),payouts:finance.payouts.map(p=>({...p,created_at:new Date(p.created_at).toISOString()})),refunds:finance.refunds.map(r=>({...r,created_at:new Date(r.created_at).toISOString()}))};
 return <Dashboard cancellations={cancellations} cash={cash} backupStorage={{cloud:!!process.env.DATABASE_URL,limitMb:backupLimit()/1024/1024}} telegram={telegram} backups={backups} configuration={configuration} workspace={workspace} now={new Date().toISOString()} receiptDays={receiptDays} finance={financeView} actor={actor} trips={data.trips.map(t=>({...t,departure_at:new Date(t.departure_at).toISOString(),ends_at:new Date(t.ends_at).toISOString(),completed_at:t.completed_at?new Date(t.completed_at).toISOString():null,cancelled_at:t.cancelled_at?new Date(t.cancelled_at).toISOString():null}))} bookings={data.bookings.map(b=>({...b,departure_at:new Date(b.departure_at).toISOString()}))} drivers={fleet.drivers} vehicles={fleet.vehicles} users={users} audit={[]}/>;
}
