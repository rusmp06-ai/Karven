'use client';
import {createContext,useContext,useEffect,useRef,useState} from 'react';

type InstallPrompt=Event&{prompt:()=>Promise<void>;userChoice:Promise<{outcome:'accepted'|'dismissed';platform:string}>};
type Platform={canInstall:boolean;installed:boolean;installing:boolean;error:string;install:()=>Promise<void>};
const InstallContext=createContext<Platform>({canInstall:false,installed:false,installing:false,error:'',install:async()=>{}});
export const useAppInstall=()=>useContext(InstallContext);

export function AppPlatform({children}:{children:React.ReactNode}){
 const prompt=useRef<InstallPrompt|null>(null);
 const [canInstall,setCanInstall]=useState(false),[installed,setInstalled]=useState(false),[installing,setInstalling]=useState(false),[error,setError]=useState(''),[offline,setOffline]=useState(false);
 useEffect(()=>{
  const display=window.matchMedia('(display-mode: standalone)');
  setInstalled(display.matches);setOffline(!navigator.onLine);
  const onPrompt=(event:Event)=>{event.preventDefault();prompt.current=event as InstallPrompt;setCanInstall(true)};
  const onInstalled=()=>{prompt.current=null;setCanInstall(false);setInstalled(true)};
  const online=()=>setOffline(false),offline=()=>setOffline(true);
  window.addEventListener('beforeinstallprompt',onPrompt);window.addEventListener('appinstalled',onInstalled);
  window.addEventListener('online',online);window.addEventListener('offline',offline);
  if('serviceWorker' in navigator&&window.isSecureContext)navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}).catch(()=>{/* browser installation remains optional */});
  return()=>{window.removeEventListener('beforeinstallprompt',onPrompt);window.removeEventListener('appinstalled',onInstalled);window.removeEventListener('online',online);window.removeEventListener('offline',offline)};
 },[]);
 async function install(){
  const event=prompt.current;if(!event||installing)return;setInstalling(true);setError('');
  try{await event.prompt();if((await event.userChoice).outcome==='accepted')setInstalled(true)}
  catch{setError('Не удалось открыть установку. Используйте меню браузера, как описано ниже.')}
  finally{prompt.current=null;setCanInstall(false);setInstalling(false)}
 }
 return <InstallContext.Provider value={{canInstall,installed,installing,error,install}}>{offline&&<div className="app-offline-notice" role="status">Нет подключения к интернету. Для сохранения и получения актуальных данных восстановите соединение.</div>}{children}</InstallContext.Provider>;
}
