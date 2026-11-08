import type {MetadataRoute} from 'next';

export default function manifest():MetadataRoute.Manifest{return {
 id:'/',name:'KARVEN CRM — управление таксопарком',short_name:'KARVEN',lang:'ru',
 description:'Рейсы, бронирования и расчёты таксопарка',start_url:'/',scope:'/',display:'standalone',
 background_color:'#f4f7fb',theme_color:'#102345',
 icons:[
  {src:'/icons/app-192.png',sizes:'192x192',type:'image/png',purpose:'any'},
  {src:'/icons/app-512.png',sizes:'512x512',type:'image/png',purpose:'any'},
  {src:'/icons/app-maskable-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'},
 ],
};}
