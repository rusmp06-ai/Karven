import {existsSync} from 'node:fs';
if(existsSync('.env.local'))process.loadEnvFile('.env.local');
const {PostgresDatabase,migratePostgres,checkPostgres,DatabaseSetupError}=await import('../src/lib/postgres.ts');
const {schema}=await import('../src/lib/schema.ts');
if(!process.env.DATABASE_URL){console.error('DATABASE_URL не задан. Добавьте его в защищённые серверные настройки или локальный .env.local.');process.exit(1)}
let db;
try{db=new PostgresDatabase(process.env.DATABASE_URL);if(process.argv[2]==='migrate'){await migratePostgres(db,schema);console.log('Схема karven подготовлена; публичный API доступа к таблицам не имеет.')}else if(process.argv[2]==='check'){await checkPostgres(db);console.log('PostgreSQL: соединение установлено, схема karven, версия 10.')}else throw new Error('Unknown operation')}
catch(error){const code=typeof error?.code==='string'&&/^[A-Z0-9_]{1,40}$/.test(error.code)?error.code:'SETUP_ERROR';if(error instanceof DatabaseSetupError)console.error(error.message);console.error(`Не удалось проверить или подготовить PostgreSQL (${code}). Проверьте Connect → Session pooler, пароль, TLS и сетевой доступ. Строка подключения не выводится.`);process.exitCode=1}
finally{await db?.close()}
