'use client';
import {createContext,useId,useRef,useState} from 'react';
import {Icon} from './icons';
export const ActionsMenuContext=createContext<(()=>void)|null>(null);
/** Native popover stays mounted, preserving drafts and the browser's light-dismiss/focus behavior. */
export function ActionsMenu({label,children}:{label:string;children:React.ReactNode}){
 const id=useId(),panel=useRef<HTMLDivElement>(null),[expanded,setExpanded]=useState(false);
 function position(event:React.MouseEvent<HTMLButtonElement>){
  const box=event.currentTarget.getBoundingClientRect(),width=Math.min(380,window.innerWidth-24);
  const top=Math.max(12,Math.min(window.innerHeight-180,box.bottom<window.innerHeight*.65?box.bottom+8:box.top-Math.min(440,window.innerHeight*.65)));
  panel.current?.style.setProperty('--actions-left',`${Math.max(12,Math.min(box.right-width,window.innerWidth-width-12))}px`);
  panel.current?.style.setProperty('--actions-top',`${top}px`);
 }
 return <span className="actions-menu"><button type="button" className="icon-button actions-trigger" aria-label={label} title={label} aria-expanded={expanded} aria-controls={id} popoverTarget={id} onClick={position}><Icon name="more"/></button><div ref={panel} id={id} popover="auto" className="actions-popover" aria-label={label} onToggle={()=>setExpanded(panel.current?.matches(':popover-open')??false)}><div className="actions-popover-heading"><strong>{label}</strong><button type="button" className="icon-button" aria-label="Закрыть меню действий" popoverTarget={id} popoverTargetAction="hide"><Icon name="close" size={17}/></button></div><div className="actions-popover-body" onClick={event=>{if((event.target as Element).closest('button.menu-action'))panel.current?.hidePopover();}}><ActionsMenuContext.Provider value={()=>{if(panel.current?.matches(':popover-open'))panel.current.hidePopover();}}>{children}</ActionsMenuContext.Provider></div></div></span>;
}
