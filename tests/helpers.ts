import type {Database} from '../src/lib/database-types';
import type { Actor } from '../src/lib/access';
export const owner:Actor={id:'00000000-0000-4000-8000-000000000001',name:'Владелец',username:'owner',role:'owner',driver_id:null};
export async function seedOwner(db:Database) {
 await db.query("INSERT INTO users(id,name,username,password_hash,role) VALUES($1,$2,$3,'unused','owner')",[owner.id,owner.name,owner.username]);
}
