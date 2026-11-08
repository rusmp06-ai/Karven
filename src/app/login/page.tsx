import {withWorkspace} from '@/lib/workspace-lock';
import { redirect } from 'next/navigation';
import { currentActor } from '@/lib/session';
import { LoginForm } from './form';
export const dynamic='force-dynamic';
export default async function LoginPage({searchParams}:{searchParams:Promise<{restored?:string}>}) {
 const restored=(await searchParams).restored==='1';
 return withWorkspace(async()=>{
 if(await currentActor())redirect('/');
 return <main className="login-page"><section className="panel editor"><p className="eyebrow">KARVEN CRM</p><h1>Вход в приложение</h1><p className="muted">Используйте свою учётную запись сотрудника.</p>{restored&&<p className="success" role="status">Данные восстановлены. Войдите снова с текущим паролем владельца.</p>}<LoginForm/><p><a href="/install">Установить KARVEN на устройство</a></p></section></main>;
 });
}
