import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { schema } from './schema';
import { bootstrapOwner } from './auth';

const globalDb = globalThis as unknown as { karvenDb?: Promise<PGlite> };
export function getDb(): Promise<PGlite> {
  return globalDb.karvenDb ??= (async () => {
    const directory = process.env.DATABASE_DIR || path.join(process.cwd(), 'data', 'postgres');
    await mkdir(directory, { recursive: true });
    const db = new PGlite(directory);
    await db.exec(schema);
    await bootstrapOwner(db);
    return db;
  })();
}
