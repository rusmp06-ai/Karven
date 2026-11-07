import {writeFileSync} from 'node:fs';
import {schema} from '../src/lib/schema.ts';
import {migrationSql} from '../src/lib/postgres.ts';
writeFileSync(new URL('../docs/supabase-netlify.sql',import.meta.url),migrationSql(schema));
console.log('docs/supabase-netlify.sql — SQL для Supabase SQL Editor, без паролей.');
