import {createTelegram} from '@/lib/telegram';
import {withWorkspace} from '@/lib/workspace-lock';
import {createBackups} from '@/lib/backups';
import {createParkSettings} from '@/lib/park-settings';
import {createCustomerWorkspace,emptyWorkspace} from '@/lib/customer-workspace';
import { createCrm } from '@/lib/crm';
import { getDb } from '@/lib/db';
import { requireActor } from '@/lib/session';
import { createFleet } from '@/lib/fleet';
import { createAuth } from '@/lib/auth';
import { createFinance } from '@/lib/finance';
import { Dashboard, type ReceiptDay } from './ui';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export default async function Home() {return withWorkspace(renderHome);}
async function renderHome() {
 const actor=await requireActor();
 const db=await getDb();
 const configuration=await createParkSettings(db,actor).list();
 const telegram=actor.role==='owner'?await createTelegram(db,actor).view():undefined;
 const backups=actor.role==='owner'?await createBackups(db,actor).list():[];
 const data=await createCrm(db,actor).dashboard();
 const workspace=actor.role==='driver'?emptyWorkspace:await createCustomerWorkspace(db,actor).list();
 const fleet=actor.role==='driver'?{drivers:[],vehicles:[]}:await createFleet(db,actor).list();
 const users=actor.role==='owner'?await createAuth(db).listUsers(actor):[];
 const finance=await createFinance(db,actor).report();
 const financeView={trips:finance.trips.map(t=>({...t,approved_at:t.approved_at?new Date(t.approved_at).toISOString():null})),expenses:finance.expenses.map(e=>({...e,created_at:new Date(e.created_at).toISOString(),voided_at:e.voided_at?new Date(e.voided_at).toISOString():null})),payouts:finance.payouts.map(p=>({...p,created_at:new Date(p.created_at).toISOString()})),refunds:finance.refunds.map(r=>({...r,created_at:new Date(r.created_at).toISOString()}))};
 const receiptDays=(await db.query<ReceiptDay>(`SELECT to_char(m.created_at AT TIME ZONE 'Asia/Bishkek','YYYY-MM-DD') AS day,t.currency,SUM(m.amount)::float8 AS amount FROM (SELECT booking_id,created_at,amount_minor::bigint AS amount FROM payments UNION ALL SELECT booking_id,created_at,-amount_minor::bigint AS amount FROM refunds) m JOIN bookings b ON b.id=m.booking_id JOIN trips t ON t.id=b.trip_id WHERE m.created_at>now()-interval '8 days' AND ($1::boolean=false OR t.driver_id=$2::uuid) GROUP BY 1,2 ORDER BY 1`,[actor.role==='driver',actor.driver_id])).rows;
 const audit=actor.role==='owner'?await createAuth(db).auditLog(actor):[];
 return <Dashboard telegram={telegram} backups={backups} configuration={configuration} workspace={workspace} now={new Date().toISOString()} receiptDays={receiptDays} finance={financeView} actor={actor} trips={data.trips.map(t=>({...t,departure_at:new Date(t.departure_at).toISOString(),ends_at:new Date(t.ends_at).toISOString(),completed_at:t.completed_at?new Date(t.completed_at).toISOString():null,cancelled_at:t.cancelled_at?new Date(t.cancelled_at).toISOString():null}))} bookings={data.bookings.map(b=>({...b,departure_at:new Date(b.departure_at).toISOString()}))} drivers={fleet.drivers} vehicles={fleet.vehicles} users={users} audit={audit.map(a=>({...a,created_at:new Date(a.created_at).toISOString()}))}/>;
}
