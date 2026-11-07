export type Role = 'owner' | 'dispatcher' | 'driver';
export type Actor = {id:string;name:string;username:string;role:Role;driver_id:string|null};
export class AccessError extends Error {
  constructor() {super('Недостаточно прав для этой операции');}
}
export function requireRole(actor:Actor, ...roles:Role[]) {
  if (!actor || !roles.includes(actor.role)) throw new AccessError();
}
