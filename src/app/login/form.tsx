'use client';
import { useActionState } from 'react';
import { login } from './actions';
export function LoginForm() {
 const [state,action,pending]=useActionState(login,{});
 return <form action={action}><label>Логин<input name="username" autoComplete="username" required maxLength={64}/></label><label>Пароль<input name="password" type="password" autoComplete="current-password" required maxLength={128}/></label>{state.error&&<p role="alert" className="error">{state.error}</p>}<button disabled={pending}>{pending?'Вход…':'Войти'}</button></form>;
}
