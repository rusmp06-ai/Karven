'use client';
import { useState, useId } from 'react';
import type { Booking, Trip } from '@/lib/crm';
import type { Passenger } from '@/lib/orders';
import { Field, SubmitForm } from './forms';
import {routeTariff,inputMoney,type RouteTemplate} from '@/lib/park-config';
import {amount} from './dispatch';
import {Icon} from './icons';
import type {ActionState} from './actions';
export type BookingView=Omit<Booking,'departure_at'>&{departure_at:string};
export type TripView=Omit<Trip,'departure_at'|'ends_at'|'completed_at'|'cancelled_at'>&{departure_at:string;ends_at:string;completed_at:string|null;cancelled_at:string|null};
export const sourceLabels:Record<string,string>={phone:'Телефон',whatsapp:'WhatsApp',telegram:'Telegram',website:'Сайт',aggregator:'Агрегатор',other:'Другое'};
export function OrderEditor({trips=[],selectedTripId,onSelectTrip,booking,onSaved,contact,tariffs=[]}:{trips?:TripView[];selectedTripId?:string;onSelectTrip?:(id:string)=>void;booking?:BookingView;onSaved?:(state:ActionState)=>void;contact?:{name:string;phone:string};tariffs?:RouteTemplate[]}) {
 const trip=trips.find(t=>t.id===selectedTripId)??trips[0];
 const [name,setName]=useState(booking?.name??contact?.name??'');
 const [phone,setPhone]=useState(booking?.phone?`+${booking.phone}`:contact?`+${contact.phone}`:'');
 const [kind,setKind]=useState<'seats'|'vehicle'>(booking?.booking_type??'seats');
 const [price,setPrice]=useState('');
 const [initialPayment,setInitialPayment]=useState('0');
 const [count,setCount]=useState(booking?.passenger_count??1);
 const [same,setSame]=useState(!booking);
 const [passengers,setPassengers]=useState<Passenger[]>(booking?.passengers??[]);
 const filled=Array.from({length:count},(_,i)=>i===0&&same?{name,phone}:passengers[i]??{name:'',phone:''});
 const suggested=trip?routeTariff(tariffs,trip,kind,count):null;
 const free=trip?trip.capacity-trip.occupied:0;
 const updatePassenger=(index:number,field:'name'|'phone',value:string)=>setPassengers(current=>{
  const copy=Array.from({length:count},(_,i)=>current[i]??{name:'',phone:''});copy[index]={...copy[index],[field]:value};return copy;
 });
 function reset(state:ActionState) {onSaved?.(state);if(!booking){setName('');setPhone('');setKind('seats');setCount(1);setSame(true);setPassengers([]);setPrice('');setInitialPayment('0');}}
 if(!booking&&!trip)return <p className="muted">Нет будущих рейсов для бронирования.</p>;
 return <SubmitForm action={booking?'bookingDetails':'booking'} onSuccess={reset} className="order-form" submitLabel={booking?'Сохранить изменения':'Создать бронь'} disabled={!booking&&(free===0||(kind==='vehicle'&&trip!.occupied>0))}>
 {booking?<input name="bookingId" type="hidden" value={booking.id}/>:<>
 <h3 className="form-section"><Icon name="pin"/>Рейс и места</h3>
 <div className="form-wide trip-picker"><Field label="Рейс"><select name="tripId" value={trip!.id} onChange={e=>{setPrice('');setInitialPayment('0');onSelectTrip?.(e.target.value);}}>{trips.map(t=><option value={t.id} key={t.id}>{t.origin} → {t.destination} · {new Date(t.departure_at).toLocaleString('ru',{timeZone:'Asia/Bishkek'})} · {t.currency} · {t.capacity-t.occupied} мест</option>)}</select></Field><div className="trip-picker-preview" aria-hidden="true"><strong>{trip!.origin} → {trip!.destination}</strong><small>{new Date(trip!.departure_at).toLocaleString('ru',{timeZone:'Asia/Bishkek',day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'})} · Свободно {free} мест</small><Icon name="chevron" size={17}/></div></div>
 <Field label="Тип заказа"><select name="bookingType" value={kind} onChange={e=>setKind(e.target.value as 'seats'|'vehicle')}><option value="seats">Отдельные места</option><option value="vehicle">Вся машина</option></select></Field>
 <NumberStepper label="Число пассажиров" name="seats" value={count} max={kind==='vehicle'?trip!.capacity:Math.max(1,free)} min={1} onChange={setCount}/>
 {kind==='vehicle'&&<p className="muted form-wide">Машина резервируется целиком: {trip!.capacity} мест. Другие заказы в этот рейс будут закрыты.</p>}
 {kind==='vehicle'&&trip!.occupied>0&&<p className="error form-wide" role="status">Для заказа всей машины выберите рейс без других бронирований.</p>}
 {free===0&&<p role="status" className="error form-wide">В рейсе нет свободных мест.</p>}</>}
 <h3 className="form-section"><Icon name="user"/>Заказчик</h3>
 <Field label="Имя клиента"><input name="name" value={name} onChange={e=>setName(e.target.value)} required maxLength={120}/></Field>
 <Field label="Телефон с кодом страны"><input name="phone" type="tel" value={phone} onChange={e=>setPhone(e.target.value)} required maxLength={25} placeholder="+996 …"/></Field>
 <div className="form-wide passenger-fields"><label className="check-label"><input type="checkbox" checked={same} onChange={e=>setSame(e.target.checked)}/>Заказчик — первый пассажир</label>
 {filled.map((p,i)=>same&&i===0?null:<div className="passenger-entry" key={i}><Field label={`Пассажир ${i+1}: имя`}><input value={p.name} required maxLength={120} onChange={e=>updatePassenger(i,'name',e.target.value)}/></Field><Field label={`Пассажир ${i+1}: телефон (необязательно)`}><input type="tel" value={p.phone} maxLength={25} onChange={e=>updatePassenger(i,'phone',e.target.value)}/></Field></div>)}<input name="passengers" type="hidden" value={JSON.stringify(filled)}/></div>
 <h3 className="form-section"><Icon name="pin"/>Посадка и багаж</h3>
 <Field label="Адрес посадки"><input name="pickupAddress" maxLength={500} defaultValue={booking?.pickup_address} placeholder="Улица, дом, ориентир"/></Field>
 <Field label="Адрес высадки"><input name="dropoffAddress" maxLength={500} defaultValue={booking?.dropoff_address}/></Field>
 <Field label="Багаж"><input name="luggage" maxLength={500} defaultValue={booking?.luggage} placeholder="Например, 2 чемодана"/></Field>
 <Field label="Детских кресел"><input name="childSeats" type="number" min={0} max={count} defaultValue={booking?.child_seats??0}/></Field>
 {!booking&&<><h3 className="form-section"><Icon name="wallet"/>Стоимость и оплата</h3>
 {suggested&&<div className="tariff-suggestion form-wide"><p>Тариф маршрута: {kind==='vehicle'?'вся машина':`${count} × ${amount(suggested.unit,trip!.currency)}`} · <strong>{amount(suggested.total,trip!.currency)}</strong></p><button type="button" className="button-outline compact" onClick={()=>setPrice(inputMoney(suggested.total))}>Применить тариф</button></div>}
 <Field label={`Общая стоимость (${trip!.currency})`}><input name="total" value={price} onChange={e=>setPrice(e.target.value)} inputMode="decimal" placeholder="1500.00" required pattern="[0-9]+(\.[0-9]{1,2})?"/></Field>
 <Field label={`Предоплата (${trip!.currency})`}><input name="initialPayment" value={initialPayment} onChange={e=>setInitialPayment(e.target.value)} inputMode="decimal" required pattern="[0-9]+(\.[0-9]{1,2})?"/></Field>
 <Field label="Способ предоплаты"><select name="initialPaymentMethod"><option value="cash">Наличные</option><option value="transfer">Перевод</option><option value="card">Карта</option></select></Field></>}
 <Field label="Источник заявки"><select name="source" defaultValue={booking?.source??'phone'}>{Object.entries(sourceLabels).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></Field>
 {!booking&&<div className="booking-balance form-wide"><span>К оплате при отправлении</span><strong>{price&&Number(initialPayment)<=Number(price)?amount(Math.round((Number(price)-Number(initialPayment))*100),trip!.currency):'—'}</strong></div>}
 <details className="form-wide booking-note" open={booking?.note?true:undefined}><summary>Комментарий к брони</summary><Field label="Внутренний комментарий"><textarea name="note" maxLength={1000} defaultValue={booking?.note}/></Field></details>
 <div className="form-wide booking-form-summary"><Icon name="users"/><strong>{count} пассажиров · {booking?.seats??(kind==='vehicle'?trip!.capacity:count)} мест</strong><small>{booking?'Изменение контактов не меняет цену и число мест.':'Бронь и фактически полученная предоплата сохраняются вместе.'}</small></div>
 </SubmitForm>;
}
export function OrderDetails({booking,driverOnly}:{booking:BookingView;driverOnly:boolean}) {
 return <div className="order-details"><div className="order-route"><span>Посадка</span><strong>{booking.pickup_address||'Адрес не указан'}</strong><span>Высадка</span><strong>{booking.dropoff_address||'Адрес не указан'}</strong></div><p><b>{booking.booking_type==='vehicle'?'Вся машина':'Отдельные места'}</b> · {booking.passenger_count} пассажиров · {booking.seats} мест зарезервировано</p><p>Багаж: {booking.luggage||'Не указан'} · Детских кресел: {booking.child_seats}</p><details><summary>Пассажиры и контакты</summary><ol className="passenger-list">{booking.passengers.map((p,i)=><li key={i}>{p.name}{p.phone&&<> · <a href={`tel:+${p.phone}`}>+{p.phone}</a></>}</li>)}</ol>{booking.passengers.length<booking.passenger_count&&<p className="muted">Имена остальных пассажиров не указаны в старой брони.</p>}</details>{!driverOnly&&<><p className="muted">Источник: {sourceLabels[booking.source]??booking.source} · Заказ {booking.id.slice(0,8)}</p></>}</div>;
}

function NumberStepper({label,name,value,min,max,onChange}:{label:string;name:string;value:number;min:number;max:number;onChange:(value:number)=>void}){const id=useId();return <div className="field"><label htmlFor={id}>{label}</label><div className="number-stepper"><button type="button" aria-label="Убрать одного пассажира" disabled={value<=min} onClick={()=>onChange(Math.max(min,value-1))}>−</button><input id={id} name={name} type="number" min={min} max={max} required value={value} onChange={e=>onChange(Math.max(min,Math.min(60,Number(e.target.value)||min)))}/><button type="button" aria-label="Добавить одного пассажира" disabled={value>=max} onClick={()=>onChange(Math.min(max,value+1))}>+</button></div></div>;}
