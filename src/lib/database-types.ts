export interface DbTransaction {
 query<T=Record<string,unknown>>(sql:string,params?:unknown[]):Promise<{rows:T[]}>;
 exec(sql:string):Promise<unknown>;
}
export interface Database extends DbTransaction {
 readonly kind?:'postgres';
 independentQuery?<T=Record<string,unknown>>(sql:string,params?:unknown[]):Promise<{rows:T[]}>;
 transaction<T>(work:(tx:DbTransaction)=>Promise<T>):Promise<T>;
 close():Promise<void>;
}
