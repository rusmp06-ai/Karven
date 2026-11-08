import type { Metadata,Viewport } from 'next';
import {AppPlatform} from './app-platform';
import './globals.css';
export const metadata: Metadata = {title:'Karven — управление рейсами',description:'CRM междугороднего таксопарка',applicationName:'KARVEN CRM',manifest:'/manifest.webmanifest',appleWebApp:{capable:true,title:'KARVEN',statusBarStyle:'default'},icons:{apple:'/icons/apple-touch-icon.png'}};
export const viewport:Viewport={themeColor:'#102345'};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="ru"><body><AppPlatform>{children}</AppPlatform></body></html>}
