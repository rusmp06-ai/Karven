import { createCrm } from '@/lib/crm';
import { getDb } from '@/lib/db';
import { requireActor } from '@/lib/session';
import { createFleet } from '@/lib/fleet';
import { createAuth } from '@/lib/auth';
import { createFinance } from '@/lib/finance';
import { Dashboard } from './ui';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export default async function Home() {
 const actor=await requireActor();
 const db=await getDb();
 const data=await createCrm(db,actor).dashboard();
 const fleet=actor.role==='driver'?{drivers:[],vehicles:[]}:await createFleet(db,actor).list();
 const users=actor.role==='owner'?await createAuth(db).listUsers(actor):[];
 const finance=await createFinance(db,actor).report();
 const financeView={trips:finance.trips.map(t=>({...t,approved_at:t.approved_at?new Date(t.approved_at).toISOString():null})),expenses:finance.expenses.map(e=>({...e,created_at:new Date(e.created_at).toISOString(),voided_at:e.voided_at?new Date(e.voided_at).toISOString():null})),payouts:finance.payouts.map(p=>({...p,created_at:new Date(p.created_at).toISOString()})),refunds:finance.refunds.map(r=>({...r,created_at:new Date(r.created_at).toISOString()}))};
 const audit=actor.role==='owner'?await createAuth(db).auditLog(actor):[];
 return <Dashboard finance={financeView} actor={actor} trips={data.trips.map(t=>({...t,departure_at:new Date(t.departure_at).toISOString(),ends_at:new Date(t.ends_at).toISOString(),completed_at:t.completed_at?new Date(t.completed_at).toISOString():null,cancelled_at:t.cancelled_at?new Date(t.cancelled_at).toISOString():null}))} bookings={data.bookings.map(b=>({...b,departure_at:new Date(b.departure_at).toISOString()}))} drivers={fleet.drivers} vehicles={fleet.vehicles} users={users} audit={audit.map(a=>({...a,created_at:new Date(a.created_at).toISOString()}))}/>;
}
