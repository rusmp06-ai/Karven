import { redirect } from 'next/navigation';
import { currentActor } from '@/lib/session';
import { LoginForm } from './form';
export const dynamic='force-dynamic';
export default async function LoginPage() {
 if(await currentActor())redirect('/');
 return <main className="login-page"><section className="panel editor"><p className="eyebrow">KARVEN CRM</p><h1>Вход в приложение</h1><p className="muted">Используйте свою учётную запись сотрудника.</p><LoginForm/></section></main>;
}
