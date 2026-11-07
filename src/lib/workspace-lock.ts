import {AsyncLocalStorage} from 'node:async_hooks';
import {PostgresDatabase} from './postgres';
// Reentrant within one request, exclusive across processes through PostgreSQL.
const state=globalThis as typeof globalThis&{karvenWorkspaceQueue?:Promise<void>;karvenWorkspaceContext?:AsyncLocalStorage<{active:boolean}>;karvenWorkspaceDatabase?:PostgresDatabase};
const context=state.karvenWorkspaceContext??=new AsyncLocalStorage<{active:boolean}>();
export async function withWorkspace<T>(work:()=>Promise<T>):Promise<T>{
 if(context.getStore()?.active)return work();
 const previous=state.karvenWorkspaceQueue??Promise.resolve();
 let release!:()=>void;state.karvenWorkspaceQueue=new Promise<void>(resolve=>{release=resolve;});
 await previous;
 const scope={active:true};
 try{return await context.run(scope,async()=>{
  if(!process.env.DATABASE_URL)return work();
  const db=state.karvenWorkspaceDatabase??=new PostgresDatabase(process.env.DATABASE_URL);
  return db.withWorkspace(work);
 })}finally{scope.active=false;release()}
}
