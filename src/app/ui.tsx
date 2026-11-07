'use client';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {OrderEditor,OrderDetails,type BookingView,type TripView} from './order-ui';
import type {ActionState} from './actions';
import {Field,SubmitForm} from './forms';
import {FleetPanel,UsersPanel,AssignmentForm} from './management';
import {FinancePanel,RefundForms,CompletionForm,type FinanceView} from './finance-ui';
import {OrderOperations,CancelTripForm} from './trip-operations-ui';
import {logout} from './login/actions';
import type {Actor} from '@/lib/access';
import type {Driver,Vehicle} from '@/lib/fleet';
import {Icon,Logo,type IconName} from './icons';
import {Schedule,TripInspector,StatusPill,tripStatus,dayKey,amount,initials,tripTime} from './dispatch';
import {Modal} from './modal';
import {DemoContext} from './demo-context';
import {ReportsPanel} from './directories';
import {ClientsPanel,TasksPanel} from './customer-ui';
import type {CustomerWorkspace,Customer} from '@/lib/customer-workspace';
const emptyWorkspace:CustomerWorkspace={clients:[],notes:[],movements:[],tasks:[],assignees:[]};
import {auditLabels} from './labels';

type Audit={id:string;action:string;entity_id:string;actor_name:string|null;created_at:string};
export type ReceiptDay={day:string;currency:string;amount:number};
export type DashboardProps={trips:TripView[];bookings:BookingView[];actor:Actor;drivers:Driver[];vehicles:Vehicle[];users:(Actor&{active:boolean})[];audit:Audit[];finance:FinanceView;workspace?:CustomerWorkspace;receiptDays?:ReceiptDay[];now?:string;demo?:boolean;demoStatuses?:Record<string,string>};
type Tab='overview'|'trips'|'bookings'|'clients'|'drivers'|'vehicles'|'finance'|'tasks'|'reports'|'settings';
type AlertItem={title:string;detail:string;icon:IconName;tone:string;target:Tab;tripId?:string};
const navItems:{key:Tab;label:string;icon:IconName}[]=[{key:'overview',label:'Обзор',icon:'home'},{key:'trips',label:'Диспетчерская',icon:'calendar'},{key:'bookings',label:'Бронирования',icon:'booking'},{key:'clients',label:'Клиенты',icon:'users'},{key:'drivers',label:'Водители',icon:'wheel'},{key:'vehicles',label:'Автомобили',icon:'car'},{key:'finance',label:'Финансы',icon:'coins'},{key:'tasks',label:'Задачи',icon:'task'},{key:'reports',label:'Отчёты',icon:'chart'}];
export function Dashboard({trips,bookings,actor,drivers,vehicles,users,audit,finance,receiptDays=[],workspace=emptyWorkspace,now:newNow,demo=false,demoStatuses={}}:DashboardProps) {
 const router=useRouter();
 const [clock,setClock]=useState(()=>new Date(newNow??Date.now()).getTime());
 useEffect(()=>{if(demo)return;const id=setInterval(()=>setClock(Date.now()),10000);return()=>clearInterval(id);},[demo]);
 useEffect(()=>{if(!demo&&newNow)setClock(new Date(newNow).getTime());},[newNow,demo]);
 const today=dayKey(new Date(clock).toISOString());
 const [tab,setTab]=useState<Tab>('trips');
 const [search,setSearch]=useState('');
 const [date,setDate]=useState(today);
 const [routeFilter,setRouteFilter]=useState('');
 const [statusFilter,setStatusFilter]=useState('all');
 const [selectedTripId,setSelectedTripId]=useState(demo?'demo-2':'');
 const [bookingTripFilter,setBookingTripFilter]=useState('');
 const [bookingIdFilter,setBookingIdFilter]=useState('');
 const [clientId,setClientId]=useState('');
 const [taskClientId,setTaskClientId]=useState('');
 const [bookingContact,setBookingContact]=useState<Customer|null>(null);
 const [mobileNav,setMobileNav]=useState(false);
 const [listView,setListView]=useState(false);
 const [page,setPage]=useState(0);
 const [modal,setModal]=useState<'create'|'trip'|null>(null);
 const [managedId,setManagedId]=useState('');
 const [settingsTab,setSettingsTab]=useState<'users'|'audit'>('users');
 const driverOnly=actor.role==='driver';
 const [contextReady,setContextReady]=useState(false);
 useEffect(()=>{
  if(demo)return;
  const q=new URLSearchParams(window.location.search),next=q.get('tab') as Tab;
  const allowed=driverOnly?['trips','bookings','finance']:[...navItems.map(n=>n.key),...(actor.role==='owner'?['settings']:[])];
  if(allowed.includes(next))setTab(next);
  const savedDate=q.get('date');if(savedDate===''||savedDate&&/^\d{4}-\d{2}-\d{2}$/.test(savedDate))setDate(savedDate);
  const trip=q.get('trip');if(trips.some(t=>t.id===trip))setSelectedTripId(trip!);
  const order=q.get('order');if(bookings.some(b=>b.id===order))setBookingIdFilter(order!);
  const client=q.get('client');if(workspace.clients.some(c=>c.id===client))setClientId(client!);
  setContextReady(true);
 // Restore once per authenticated workspace; subsequent data refreshes preserve current choices.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[demo,actor.id]);
 useEffect(()=>{
  if(demo||!contextReady)return;
  const q=new URLSearchParams();q.set('tab',tab);q.set('date',date);
  if(selectedTripId)q.set('trip',selectedTripId);if(bookingIdFilter)q.set('order',bookingIdFilter);if(clientId)q.set('client',clientId);
  const target=`${window.location.pathname}?${q}`;
  if(`${window.location.pathname}${window.location.search}`!==target)router.replace(target,{scroll:false});
 },[demo,contextReady,tab,date,selectedTripId,bookingIdFilter,clientId,router,newNow]);
 const roleLabel={owner:'Владелец',dispatcher:'Диспетчер',driver:'Водитель'}[actor.role];
 const title=tab==='trips'&&driverOnly?'Мои рейсы':navItems.find(n=>n.key===tab)?.label??'Настройки';
 const routes=[...new Set(trips.map(t=>`${t.origin} → ${t.destination}`))];
 const active=bookings.filter(b=>b.status==='confirmed');
 const available=trips.filter(t=>t.status==='scheduled'&&new Date(t.departure_at).getTime()>clock);
 const filteredTrips=trips.filter(t=>(!date||dayKey(t.departure_at)===date)&&(!routeFilter||`${t.origin} → ${t.destination}`===routeFilter)&&(statusFilter==='all'||t.status===statusFilter)&&`${t.origin} ${t.destination} ${t.driver_name??''} ${t.vehicle_plate??''} ${t.id} ${bookings.filter(b=>b.trip_id===t.id).map(b=>`${b.name} ${b.phone}`).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
 const filteredBookings=bookings.filter(b=>(!date||dayKey(b.departure_at)===date)&&(!routeFilter||`${b.origin} → ${b.destination}`===routeFilter)&&(!bookingTripFilter||b.trip_id===bookingTripFilter)&&(!bookingIdFilter||b.id===bookingIdFilter)&&(statusFilter==='all'||b.status===statusFilter)&&`${b.name} ${b.phone} ${b.origin} ${b.destination} ${b.pickup_address} ${b.dropoff_address} ${b.passengers.map(p=>`${p.name} ${p.phone}`).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
 const selected=filteredTrips.find(t=>t.id===selectedTripId)??filteredTrips[0];
 const managed=trips.find(t=>t.id===managedId);
 const todayIds=new Set(trips.filter(t=>dayKey(t.departure_at)===today&&t.status!=='cancelled').map(t=>t.id));
 const currencies=[...new Set([...receiptDays.filter(d=>d.day===today).map(d=>d.currency),...active.map(b=>b.currency)])];
 const receivedText=currencies.map(currency=>({currency,n:receiptDays.filter(d=>d.day===today&&d.currency===currency).reduce((n,d)=>n+d.amount,0)})).filter(x=>x.n!==0);
 const debtText=currencies.map(currency=>({currency,n:active.filter(b=>b.currency===currency).reduce((n,b)=>n+b.total_minor-b.paid_minor,0)})).filter(x=>x.n>0);
 const displayAmounts=(rows:{currency:string;n:number}[])=>rows.length?rows.map(x=>amount(x.n,x.currency)).join(' / '):amount(0,currencies[0]??'KGS');
 const overdueTaskCount=workspace.tasks.filter(t=>!['done','cancelled'].includes(t.status)&&new Date(t.due_at).getTime()<clock).length;
 const alerts:AlertItem[]=[];
 const unpaid=active.filter(b=>b.paid_minor<b.total_minor);
 if(unpaid.length)alerts.push({title:`${unpaid.length} бронирований без полной оплаты`,detail:'Проверьте предоплаты и остатки к получению',icon:'booking',tone:'red',target:'bookings'});
 const expiring=drivers.filter(d=>new Date(`${d.license_expires}T23:59:59+06:00`).getTime()-clock<14*86400000);
 for(const d of expiring.slice(0,2))alerts.push({title:new Date(`${d.license_expires}T23:59:59+06:00`).getTime()<clock?'Удостоверение водителя просрочено':'Истекает срок водительского удостоверения',detail:`${d.name} · до ${new Date(`${d.license_expires}T00:00:00+06:00`).toLocaleDateString('ru',{timeZone:'Asia/Bishkek'})}`,icon:'id',tone:'amber',target:'drivers'});
 const unassigned=available.filter(t=>!t.driver_id||!t.vehicle_id);
 if(unassigned.length)alerts.push({title:`${unassigned.length} рейсов без назначения ресурсов`,detail:'Выберите водителя и автомобиль до отправления',icon:'car',tone:'blue',target:'trips',tripId:unassigned[0].id});
 const notReady=available.find(t=>t.vehicle_id&&vehicles.find(v=>v.id===t.vehicle_id)?.status!=='available');
 if(notReady)alerts.push({title:`Рейс ${tripTime(notReady.departure_at)} — проверить готовность авто`,detail:`${notReady.vehicle_model} · автомобиль недоступен для выезда`,icon:'car',tone:'blue',target:'vehicles'});
 const unmarked=active.filter(b=>new Date(b.departure_at).getTime()<=clock&&b.trip_status==='scheduled'&&b.attendance.length<b.passenger_count);
 if(unmarked.length)alerts.push({title:`${unmarked.length} заказов ожидают отметок пассажиров`,detail:'Отметьте посадку или неявку перед завершением рейса',icon:'users',tone:'blue',target:'bookings'});
 const pageCount=Math.max(1,Math.ceil(filteredTrips.length/6));
 const currentPage=Math.min(page,pageCount-1);
 const visibleTrips=filteredTrips.slice(currentPage*6,currentPage*6+6);
 const reset=()=>{setDate('');setSearch('');setRouteFilter('');setStatusFilter('all');setBookingTripFilter('');setBookingIdFilter('');setBookingContact(null);setTaskClientId('');setPage(0);};
 const navigate=(next:Tab)=>{setTab(next);setMobileNav(false);reset();};
 const openTrip=(id:string)=>{setManagedId(id);setSelectedTripId(id);setModal('trip');};
 const quickBook=(id:string)=>{setModal(null);reset();setSelectedTripId(id);setBookingTripFilter(id);setTab('bookings');};
 const openBooking=(id:string)=>{reset();setModal(null);setBookingIdFilter(id);setTab('bookings');};
 const alertAction=(a:AlertItem)=>{navigate(a.target);if(a.tripId){setSelectedTripId(a.tripId);setManagedId(a.tripId);setModal('trip');}};
 const weekly=Array.from({length:7},(_,i)=>dayKey(new Date(clock-(6-i)*86400000).toISOString()));
 return <DemoContext.Provider value={demo}><div className={`shell ${mobileNav?'nav-open':''}`}>
 <aside className="sidebar"><a className="brand" href={demo?'/demo':'/'}><Logo/><span>KARVEN<small>Управление таксопарком</small></span></a><nav aria-label="Основные разделы">{navItems.filter(n=>!driverOnly||['trips','bookings','finance'].includes(n.key)).map(item=><button key={item.key} aria-label={item.label} className={tab===item.key?'selected':''} onClick={()=>navigate(item.key)} aria-current={tab===item.key?'page':undefined}><Icon name={item.icon}/><span>{item.label}</span>{item.key==='tasks'&&alerts.length+overdueTaskCount>0&&<small className="nav-count">{alerts.length+overdueTaskCount}</small>}</button>)}</nav><div className="sidebar-bottom">{actor.role==='owner'&&<button className={`sidebar-settings ${tab==='settings'?'selected':''}`} onClick={()=>navigate('settings')}><Icon name="settings"/>Настройки</button>}<div className="sidebar-profile"><span className="avatar small"><Icon name="user" size={19}/></span><span>{actor.name}<small>{roleLabel}</small></span>{demo?<a className="icon-button" href="/" aria-label="К рабочим данным"><Icon name="external" size={17}/></a>:<form action={logout}><button className="icon-button" aria-label="Выйти" title="Выйти"><Icon name="logout" size={17}/></button></form>}</div></div></aside>
 <div className="main-shell"><div className="topbar"><button className="icon-button mobile-menu" aria-label="Открыть меню" aria-expanded={mobileNav} onClick={()=>setMobileNav(!mobileNav)}><Icon name="menu"/></button><div className="breadcrumb"><Icon name="home" size={17}/><Icon name="chevron" size={12}/><span>Рабочее пространство</span><span>/</span><strong>{title}</strong></div><div className="topbar-actions"><div className="global-search"><Icon name="search" size={18}/><input aria-label="Поиск" placeholder="Клиент, телефон или рейс" value={search} onChange={e=>{setSearch(e.target.value);setPage(0);if(!['trips','bookings','clients','drivers','vehicles'].includes(tab))setTab('bookings');}}/>{search&&<button className="icon-button" aria-label="Очистить поиск" onClick={()=>setSearch('')}><Icon name="close" size={14}/></button>}</div>{!driverOnly&&<button className="icon-button notification-button" aria-label={`Уведомления: ${alerts.length+overdueTaskCount}`} onClick={()=>navigate('tasks')}><Icon name="bell"/>{alerts.length+overdueTaskCount>0&&<i/>}</button>}<span className="avatar small top-avatar" title={actor.name}><Icon name="user" size={19}/></span></div></div>
 <main><header className="page-header"><div><h1>{title}</h1><p>{tab==='trips'?'Рейсы, пассажиры и расчёты в одном месте':tab==='bookings'?'Заказы, контакты пассажиров и история поездок':tab==='finance'?'Оплаты, расходы и расчёты с водителями':tab==='tasks'?'Вопросы, требующие вашего внимания':'Единое рабочее пространство вашего парка'}</p></div><div className="header-actions">{demo&&<span className="demo-badge">Демо-данные</span>}{!driverOnly&&<><button className="button-outline" onClick={()=>{setModal('create');setMobileNav(false);}}><Icon name="plus"/>Создать рейс</button><button onClick={()=>{navigate('bookings');setSelectedTripId(available.find(t=>t.occupied<t.capacity)?.id??'');}}><Icon name="plus"/>Новая бронь</button></>}</div></header>
 <section className="stats"><Stat icon="car" label="Рейсов сегодня" value={String(todayIds.size)} tone="blue" data={weekly.map(d=>trips.filter(t=>dayKey(t.departure_at)===d).length)}/><Stat icon="users" label="Пассажиров" value={String(active.filter(b=>todayIds.has(b.trip_id)).reduce((n,b)=>n+b.passenger_count,0))} tone="blue" data={weekly.map(d=>active.filter(b=>dayKey(b.departure_at)===d).reduce((n,b)=>n+b.passenger_count,0))}/><Stat icon="coins" label="Получено сегодня" value={displayAmounts(receivedText)} tone="green" data={weekly.map(d=>receiptDays.filter(r=>r.day===d&&r.currency===(currencies[0]??'KGS')).reduce((n,r)=>n+r.amount,0))}/><Stat icon="card" label="Ожидает оплаты" value={displayAmounts(debtText)} tone="amber" data={weekly.map(d=>active.filter(b=>dayKey(b.departure_at)===d).reduce((n,b)=>n+b.total_minor-b.paid_minor,0))}/></section>
 {(tab==='trips'||tab==='overview'||tab==='bookings')&&<div className="toolbar dispatch-toolbar"><div className="filter-controls"><label className="date-filter"><Icon name="calendar" size={17}/><span className="date-label">{date?new Date(`${date}T12:00:00Z`).toLocaleDateString('ru',{timeZone:'Asia/Bishkek',day:'numeric',month:'long',year:'numeric'}):'Все даты'}</span><input aria-label="Дата рейса (Бишкек)" type="date" value={date} onChange={e=>{setDate(e.target.value);setPage(0);}}/></label><button className="today-button" onClick={()=>{setDate(today);setPage(0);}}>Сегодня</button><label className="select-filter"><Icon name="swap" size={17}/><select aria-label="Направление" value={routeFilter} onChange={e=>{setRouteFilter(e.target.value);setPage(0);}}><option value="">Все направления</option>{routes.map(r=><option key={r}>{r}</option>)}</select></label><label className="select-filter"><Icon name="filter" size={17}/><select aria-label="Статус" value={statusFilter} onChange={e=>{setStatusFilter(e.target.value);setPage(0);}}><option value="all">Все статусы</option>{tab==='bookings'?<><option value="confirmed">Подтверждённые</option><option value="cancelled">Отменённые</option></>:<><option value="scheduled">Запланированные</option><option value="completed">Завершённые</option><option value="cancelled">Отменённые</option></>}</select></label>{(date||search||routeFilter||statusFilter!=='all'||bookingTripFilter||bookingIdFilter)&&<button className="reset-button" onClick={reset}>Сбросить</button>}</div>{tab!=='bookings'&&<div className="view-toggle" aria-label="Вид расписания"><button className={!listView?'active':''} onClick={()=>setListView(false)} aria-pressed={!listView}><Icon name="calendar" size={17}/>Расписание</button><button className={listView?'active':''} onClick={()=>setListView(true)} aria-pressed={listView}><Icon name="list" size={17}/>Список</button></div>}</div>}
 {(tab==='trips'||tab==='overview')&&<div className="dispatch-grid"><div className="dispatch-left"><section className="panel schedule-panel"><div className="panel-heading"><h2>{date===today?'Отправления сегодня':'Отправления'}<span className="count-badge">{filteredTrips.length} рейсов</span></h2><small className="muted">{date?'Бишкек · UTC+6':'Все даты'}</small></div>{filteredTrips.length?<Schedule trips={visibleTrips} bookings={bookings} selectedId={selected?.id} onSelect={setSelectedTripId} onOpen={openTrip} now={clock} demoStatuses={demo?demoStatuses:{}} listView={listView}/>:<div className="empty"><Icon name="calendar" size={34}/><h3>{trips.length?'Нет рейсов по выбранным условиям':'Рейсов пока нет'}</h3><p>{trips.length?'Измените дату, направление или сбросьте фильтры.':'Создайте рейс, чтобы начать принимать бронирования.'}</p></div>}{pageCount>1&&<div className="pagination"><span>{currentPage*6+1}–{Math.min(currentPage*6+6,filteredTrips.length)} из {filteredTrips.length}</span><button className="icon-button" aria-label="Предыдущие рейсы" disabled={currentPage===0} onClick={()=>{setPage(currentPage-1);setSelectedTripId(filteredTrips[(currentPage-1)*6]?.id??'');}}><Icon name="chevron" style={{transform:'rotate(180deg)'}} size={15}/></button><button className="icon-button" aria-label="Следующие рейсы" disabled={currentPage===pageCount-1} onClick={()=>{setPage(currentPage+1);setSelectedTripId(filteredTrips[(currentPage+1)*6]?.id??'');}}><Icon name="chevron" size={15}/></button></div>}</section><Attention items={alerts.slice(0,3)} onAction={alertAction}/></div>{selected?<TripInspector trip={selected} bookings={bookings} driverPhone={drivers.find(d=>d.id===selected.driver_id)?.phone} onBook={()=>quickBook(selected.id)} onOpen={()=>openTrip(selected.id)} onBooking={openBooking} onAssign={()=>openTrip(selected.id)} canManage={!driverOnly} now={clock} demoStatus={demo?demoStatuses[selected.id]:undefined}/>:<section className="panel inspector-placeholder"><Icon name="car" size={44}/><h3>Выберите рейс</h3><p>Здесь появятся водитель, свободные места и пассажиры.</p></section>}</div>}
 {tab==='bookings'&&<>{(bookingTripFilter||bookingIdFilter)&&<div className="filter-notice">Показаны выбранные заказы.<button className="text-button" onClick={()=>{setBookingTripFilter('');setBookingIdFilter('');}}>Показать все заказы</button></div>}<div className={`content ${driverOnly?'read-only':''}`}><section className="panel"><div className="panel-heading"><h2>Бронирования<span className="count-badge">{filteredBookings.length}</span></h2></div>{filteredBookings.map(b=><BookingCard key={b.id} booking={b} trips={trips} actor={actor}/>)}{!filteredBookings.length&&<div className="empty"><Icon name="booking" size={34}/><h3>{bookings.length?'Нет заказов по выбранным условиям':'Бронирований пока нет'}</h3><p>Создайте заказ или измените условия поиска.</p></div>}</section>{!driverOnly&&<section className="panel editor"><h2>Новая бронь</h2><OrderEditor key={bookingContact?.id??'new'} contact={bookingContact??undefined} trips={available} selectedTripId={selectedTripId} onSelectTrip={setSelectedTripId} onSaved={state=>{if(state.createdId){setBookingIdFilter(state.createdId);setBookingTripFilter('');setDate('');setSearch('');}}}/></section>}</div></>}
 {tab==='clients'&&!driverOnly&&<ClientsPanel workspace={workspace} bookings={bookings} search={search} selectedId={clientId} onSelect={setClientId} onOpenBooking={openBooking} onRepeat={c=>{navigate('bookings');setBookingContact(c);setSelectedTripId(available.find(t=>t.occupied<t.capacity)?.id??'');}} onTask={id=>{navigate('tasks');setTaskClientId(id);}}/>}
 {tab==='drivers'&&!driverOnly&&<FleetPanel section="drivers" drivers={drivers.filter(d=>`${d.name} ${d.phone}`.toLowerCase().includes(search.toLowerCase()))} vehicles={vehicles}/>}
 {tab==='vehicles'&&!driverOnly&&<FleetPanel section="vehicles" drivers={drivers} vehicles={vehicles.filter(v=>`${v.plate} ${v.model} ${v.owner_name}`.toLowerCase().includes(search.toLowerCase()))}/>}
 {tab==='finance'&&<FinancePanel data={finance} actor={actor} selectedTripId={selectedTripId} onSelectTrip={setSelectedTripId}/>}
 {tab==='tasks'&&!driverOnly&&<><TasksPanel workspace={workspace} trips={trips} actor={actor} now={clock} clientId={taskClientId} onOpenClient={id=>{navigate('clients');setClientId(id);}} onOpenTrip={openTrip}/><Attention items={alerts} onAction={alertAction} full/></>}
 {tab==='reports'&&!driverOnly&&<ReportsPanel trips={trips} bookings={bookings} finance={finance}/>}
 {tab==='settings'&&actor.role==='owner'&&<><div className="section-tabs"><button className={settingsTab==='users'?'active':''} onClick={()=>setSettingsTab('users')}>Сотрудники</button><button className={settingsTab==='audit'?'active':''} onClick={()=>setSettingsTab('audit')}>Журнал действий</button></div>{settingsTab==='users'?<UsersPanel users={users} drivers={drivers} actorId={actor.id}/>:<section className="panel"><div className="panel-heading"><h2>Последние 100 операций</h2></div>{audit.map(a=><article className="audit-row" key={a.id}><strong>{auditLabels[a.action]??a.action}</strong><span>{a.actor_name??'Ранее'}</span><time>{new Date(a.created_at).toLocaleString('ru',{timeZone:'Asia/Bishkek'})}</time></article>)}</section>}</>}
 <footer>{demo?'Демонстрация интерфейса · тестовые данные':'Karven CRM · Время рейсов: Бишкек (UTC+6)'}</footer></main></div>
 {mobileNav&&<button className="nav-scrim" onClick={()=>setMobileNav(false)} aria-label="Закрыть меню"/>}
 {modal==='create'&&<Modal title="Создать рейс" onClose={()=>setModal(null)}><CreateTrip onSaved={(iso,state)=>{if(state.createdId)setSelectedTripId(state.createdId);setDate(dayKey(iso));setRouteFilter('');setStatusFilter('all');setSearch('');setPage(0);setTab('trips');}}/></Modal>}
 {modal==='trip'&&managed&&<Modal title={`${managed.origin} → ${managed.destination}`} onClose={()=>setModal(null)}><article className="trip trip-detail"><div className="trip-detail-header"><h2 className="route">{managed.origin} → {managed.destination}</h2><StatusPill {...tripStatus(managed,bookings,demo?demoStatuses[managed.id]:undefined)}/></div><p className="muted">{new Date(managed.departure_at).toLocaleString('ru',{timeZone:'Asia/Bishkek'})} · Бишкек (UTC+6)</p><button className="button-outline" onClick={()=>{setSelectedTripId(managed.id);setModal(null);setTab('finance');}}>К расчёту рейса</button><div className="seats"><strong>{managed.capacity-managed.occupied}</strong> из {managed.capacity} свободно</div>{!driverOnly&&managed.status==='scheduled'&&new Date(managed.departure_at).getTime()>clock&&managed.occupied<managed.capacity&&<button onClick={()=>quickBook(managed.id)}><Icon name="plus"/>Забронировать</button>}<div className="assignment"><p>{managed.driver_name?`${managed.driver_name} · ${managed.vehicle_model} · ${managed.vehicle_plate}`:'Водитель и автомобиль не назначены'}</p><p className="muted">Плановое окончание: {new Date(managed.ends_at).toLocaleString('ru',{timeZone:'Asia/Bishkek'})}</p>{!driverOnly&&managed.status==='scheduled'&&new Date(managed.departure_at).getTime()>clock&&<details><summary>Назначить или заменить</summary><AssignmentForm trip={managed} drivers={drivers} vehicles={vehicles}/></details>}{!driverOnly&&managed.status==='scheduled'&&<CompletionForm tripId={managed.id}/>} {managed.cancel_reason&&<p className="muted">Причина отмены: {managed.cancel_reason}</p>}{!driverOnly&&managed.status==='scheduled'&&<CancelTripForm trip={managed} bookings={bookings} actor={actor}/>}</div><div className="panel-heading trip-orders-heading"><h2>Заказы рейса</h2></div>{bookings.filter(b=>b.trip_id===managed.id).map(b=><BookingCard key={b.id} booking={b} trips={trips} actor={actor}/>)}</article></Modal>}
 </div></DemoContext.Provider>;
}
function CreateTrip({onSaved}:{onSaved:(iso:string,state:ActionState)=>void}) {
 const [departure,setDeparture]=useState('');
 return <section className="editor"><SubmitForm action="trip" onSuccess={state=>onSaved(departure,state)}><Field label="Откуда"><input name="origin" placeholder="Бишкек" required maxLength={120}/></Field><Field label="Куда"><input name="destination" placeholder="Каракол" required maxLength={120}/></Field><Field label="Дата и время (ваш часовой пояс)"><input type="datetime-local" step="1" required onChange={e=>setDeparture(e.target.value?new Date(e.target.value).toISOString():'')}/><input type="hidden" name="departureAt" value={departure}/></Field><div className="pair"><Field label="Количество мест"><input name="capacity" type="number" min={1} max={60} defaultValue={4} required/></Field><Field label="Валюта"><select name="currency"><option>KGS</option><option>KZT</option><option>RUB</option><option>USD</option></select></Field></div></SubmitForm></section>;
}
export function BookingCard({booking:b,trips,actor}:{booking:BookingView;trips:TripView[];actor:Actor}) {
 const driverOnly=actor.role==='driver';return <article className="booking"><div className="booking-top"><div><h3>{b.name}</h3><a href={`tel:+${b.phone}`}>+{b.phone}</a><p>{b.origin} → {b.destination} · {new Date(b.departure_at).toLocaleString('ru',{timeZone:'Asia/Bishkek'})}</p>{b.note&&<p className="muted">{b.note}</p>}</div><StatusPill label={b.status==='cancelled'?'Отменена':'Подтверждена'} tone={b.status==='cancelled'?'gray':'blue'}/></div><OrderDetails booking={b} driverOnly={driverOnly}/><OrderOperations booking={b} trips={trips} actor={actor}/><div className="amounts"><span>Стоимость <b>{amount(b.total_minor,b.currency)}</b></span><span>Оплачено <b>{amount(b.paid_minor,b.currency)}</b></span><span>Возвращено <b>{amount(b.refunded_minor,b.currency)}</b></span><span>Остаток <b>{amount(b.total_minor-b.paid_minor,b.currency)}</b></span></div>{!driverOnly&&b.status==='confirmed'&&<details><summary>Оплата и управление</summary>{b.paid_minor<b.total_minor&&<SubmitForm action="payment"><input type="hidden" name="bookingId" value={b.id}/><Field label={`Сумма (${b.currency})`}><input name="amount" inputMode="decimal" required pattern="[0-9]+(\.[0-9]{1,2})?"/></Field><Field label="Способ оплаты"><select name="method"><option value="cash">Наличные</option><option value="transfer">Перевод</option><option value="card">Карта</option></select></Field></SubmitForm>}{b.paid_minor===0?<SubmitForm action="cancel"><input type="hidden" name="bookingId" value={b.id}/><p className="muted">Отмена освободит места в рейсе.</p></SubmitForm>:<p className="muted">Возвраты и отмена с возвратом доступны владельцу.</p>}</details>}{actor.role==='owner'&&<RefundForms booking={b}/>}</article>;
}
function Stat({icon,label,value,tone,data=[]}:{icon:IconName;label:string;value:string;tone:string;data?:number[]}) {
 const max=Math.max(...data,1),min=Math.min(...data,0);const points=data.map((n,i)=>`${i*72/Math.max(1,data.length-1)},${25-(n-min)/(max-min||1)*20}`).join(' ');
 return <article className={`stat-card ${tone}`}><span className="stat-icon"><Icon name={icon} size={28}/></span><div><span className="stat-label">{label}</span><strong>{value}</strong></div>{data.length>1&&data.some(n=>n!==0)&&<svg className="sparkline" viewBox="0 0 74 30" aria-hidden="true"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.3"/></svg>}</article>;
}
function Attention({items,onAction,full=false}:{items:AlertItem[];onAction:(item:AlertItem)=>void;full?:boolean}) {return <section className={`panel attention-panel ${full?'full-attention':''}`}><div className="panel-heading"><h2>Требуют внимания</h2>{full&&<span className="count-badge">{items.length}</span>}</div><div className="attention-items">{items.map((a,i)=><button key={i} className={`attention-row ${a.tone}`} onClick={()=>onAction(a)}><span className="attention-icon"><Icon name={a.icon} size={24}/></span><span><strong>{a.title}</strong><small>{a.detail}</small></span><Icon name="chevron" size={17}/></button>)}{!items.length&&<div className="all-clear"><Icon name="check"/><span>Всё под контролем</span><small>Срочных вопросов пока нет.</small></div>}</div></section>}
