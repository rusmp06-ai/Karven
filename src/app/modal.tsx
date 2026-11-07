'use client';
import {useEffect,useRef} from 'react';
import {Icon} from './icons';
export function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}) {
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const dialog=ref.current;const previous=document.activeElement as HTMLElement|null;dialog?.showModal();const bodyOverflow=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.body.style.overflow=bodyOverflow;dialog?.close();previous?.focus();};},[]);
 return <dialog ref={ref} className="app-dialog" aria-label={title} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><div className="dialog-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Закрыть окно"><Icon name="close"/></button></div><div className="dialog-body">{children}</div></dialog>;
}
