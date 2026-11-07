// One PGlite process owns the workspace. Queue entry points so restoration cannot
// interleave with authentication, reads or mutations that used an old session.
const state=globalThis as typeof globalThis&{karvenWorkspaceQueue?:Promise<void>};
export async function withWorkspace<T>(work:()=>Promise<T>):Promise<T>{
 const previous=state.karvenWorkspaceQueue??Promise.resolve();
 let release!:()=>void;state.karvenWorkspaceQueue=new Promise<void>(resolve=>{release=resolve;});
 await previous;
 try{return await work()}finally{release()}
}
