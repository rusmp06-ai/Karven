'use client';
import { Children, cloneElement, isValidElement, useActionState, useEffect, useId, useState, type ReactElement } from 'react';
import { mutate, type ActionState } from './actions';
import { useDemo } from './demo-context';
export function SubmitForm({action,children,onSuccess,disabled=false,submitLabel,pendingLabel}:{action:string;children?:React.ReactNode;onSuccess?:(state:ActionState)=>void;disabled?:boolean;submitLabel?:string;pendingLabel?:string}) {
  const demo=useDemo();
  const [requestId,setRequestId]=useState('');
  useEffect(()=>setRequestId(crypto.randomUUID()),[]);
  const [state,submit,pending] = useActionState(async(previous:Parameters<typeof mutate>[0],form:FormData)=>{
    const result=await mutate(previous,form);
    if(result.success){setRequestId(crypto.randomUUID());onSuccess?.(result);}
    return result;
  },{});
  return <form action={submit}><input type="hidden" name="action" value={action}/><input type="hidden" name="requestId" value={requestId}/>{children}<div aria-live="polite">{demo&&<p className="muted">Демонстрационный режим: изменения не сохраняются.</p>}{state.error && <p className="error" role="alert">{state.error}</p>}{state.success && <p className="success">{state.success}</p>}</div><button disabled={pending||!requestId||disabled||demo} type="submit">{pending?(pendingLabel??'Сохранение…'): submitLabel??(action==='cancel'?'Отменить бронь':'Сохранить')}</button></form>;
}
export function Field({label,children}:{label:string;children:React.ReactNode}) {
  const id=useId();
  return <div className="field"><label htmlFor={id}>{label}</label>{Children.map(children,child=>{
    if(!isValidElement(child))return child;
    const element=child as ReactElement<{type?:string;id?:string}>;
    return element.props.type==='hidden'?element:cloneElement(element,{id});
  })}</div>;
}
