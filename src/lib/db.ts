import type {Database} from './database-types';
import {PostgresDatabase,checkPostgres} from './postgres';
import {startTelegramWorker} from './telegram';
import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { schema } from './schema';
import { bootstrapOwner } from './auth';

const globalDb = globalThis as unknown as { karvenDb?: Promise<Database> };
export function getDb(): Promise<Database> {
  return globalDb.karvenDb ??= (async () => {
    let db:Database;
    if(process.env.DATABASE_URL){
      const server=new PostgresDatabase(process.env.DATABASE_URL);
      try{await server.acquireApplicationLease();await checkPostgres(server)}catch(error){await server.close();throw error}
      db=server;
    }else{
    const directory = process.env.DATABASE_DIR || path.join(process.cwd(), 'data', 'postgres');
    await mkdir(directory, { recursive: true });
    db = new PGlite(directory);
    await db.exec(schema);
    }
    await bootstrapOwner(db);
    await db.exec("UPDATE telegram_outbox SET status='unknown',last_error='Приложение перезапущено до подтверждения доставки. Проверьте чат перед повтором' WHERE status='sending'");
    startTelegramWorker(db);
    return db;
  })();
}
