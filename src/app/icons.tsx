import type { CSSProperties } from 'react';
export type IconName='home'|'calendar'|'booking'|'users'|'wheel'|'car'|'coins'|'task'|'chart'|'settings'|'search'|'bell'|'user'|'plus'|'arrow'|'chevron'|'phone'|'swap'|'filter'|'list'|'pin'|'wallet'|'card'|'check'|'more'|'close'|'logout'|'external'|'menu'|'clock'|'id'|'refresh';
const paths:Record<IconName,React.ReactNode>={
 refresh:<><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></>,
 home:<><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-6v-7h-4v7H4a1 1 0 0 1-1-1Z"/></>,
 calendar:<><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2m-8 3h2"/></>,
 booking:<><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v4H9zm0 8h6m-6 4h6m-6 3h4"/></>,
 users:<><circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-17a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3"/></>,
 wheel:<><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M3 10h6m6 0h6m-9 5v6"/></>,
 car:<><path d="m4 10 2-6h12l2 6m-16 7v3m16-3v3"/><rect x="2" y="10" width="20" height="7" rx="2"/><path d="M6 14h1m10 0h1"/></>,
 coins:<><ellipse cx="9" cy="5" rx="6" ry="3"/><path d="M3 5v4c0 4 12 4 12 0V5M3 10v4c0 3 8 4 12 1m-12-1v4c0 3 8 4 12 1"/><path d="M18 9c4 0 4 5 0 5m0 0c4 0 4 5 0 5"/></>,
 task:<><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m7 12 3 3 7-7"/></>,
 chart:<><path d="M4 21V10m5 11V5m6 16V2m5 19V8"/></>,
 settings:<><path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3h3l2 3h3l1-3 3-1 2-3-2-2 1-3-2-3h-3l-2-3Z"/><circle cx="12" cy="12" r="3"/></>,
 search:<><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/></>,
 bell:<><path d="M5 16h14l-2-4V8a5 5 0 0 0-10 0v4Zm5 4h4"/></>,
 user:<><circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/></>,
 plus:<path d="M12 4v16M4 12h16"/>,arrow:<path d="M3 12h17m-6-6 6 6-6 6"/>,chevron:<path d="m8 4 8 8-8 8"/>,
 phone:<path d="M5 3h4l2 5-3 2a16 16 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A18 18 0 0 1 3 5a2 2 0 0 1 2-2Z"/>,
 swap:<><path d="M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4"/></>,filter:<path d="M3 3h18l-7 8v8l-4 2V11Z"/>,
 list:<path d="M7 5h14M7 12h14M7 19h14M3 5h.01M3 12h.01M3 19h.01"/>,
 pin:<><path d="M19 10c0 6-7 11-7 11S5 16 5 10a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2"/></>,
 wallet:<><path d="M20 6H4V3h14v3"/><rect x="3" y="6" width="18" height="15" rx="2"/><path d="M21 11h-7v5h7m-4-2.5h.01"/></>,
 card:<><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20m-16 7h4"/></>,check:<path d="m4 12 5 5L21 5"/>,
 more:<><circle cx="12" cy="4" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="20" r="1"/></>,close:<path d="m5 5 14 14M5 19 19 5"/>,
 logout:<><path d="M9 3H3v18h6m7-14 5 5-5 5m-8-5h13"/></>,external:<><path d="M14 3h7v7m0-7L10 14m-1-9H4v16h16v-6"/></>,menu:<path d="M3 5h18M3 12h18M3 19h18"/>,
 clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></>,id:<><rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="8" cy="10" r="2"/><path d="M5 17v-1a3 3 0 0 1 6 0v1m3-8h4m-4 4h4"/></>,
};
export function Icon({name,size=20,className='',style}:{name:IconName;size?:number;className?:string;style?:CSSProperties}) {return <svg className={`icon ${className}`} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>}
export function Logo(){return <svg width="40" height="42" viewBox="0 0 42 42" fill="none" aria-hidden="true"><path d="M9 4h9L9 34 0 40Z" fill="white"/><path d="M22 4h12L16 23l-6 1Z" fill="white"/><path d="m17 23 19 14H24L12 28Z" fill="url(#logo-blue)"/><defs><linearGradient id="logo-blue" x1="12" y1="23" x2="36" y2="37"><stop stopColor="#92c8ff"/><stop offset="1" stopColor="#0664e9"/></linearGradient></defs></svg>}
