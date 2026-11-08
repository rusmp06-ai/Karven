'use client';
import Link from 'next/link';
import {useAppInstall} from '../app-platform';

export default function InstallPage(){
 const {canInstall,installed,installing,error,install}=useAppInstall();
 return <main className="login-page install-page"><section className="panel editor"><p className="eyebrow">KARVEN CRM</p><h1>Установить приложение</h1><p>Открывайте CRM с рабочего стола в отдельном окне. Данные остаются в общей базе, а обновления загружаются через интернет.</p>
  {installed?<p className="success" role="status">KARVEN установлено или уже открыто как приложение.</p>:canInstall?<button onClick={()=>void install()} disabled={installing}>{installing?'Открываем установку…':'Установить KARVEN'}</button>:<p className="muted">Если кнопка установки не появилась, используйте меню браузера:</p>}
  {error&&<p className="error" role="alert">{error}</p>}
  <h2>На компьютере</h2><ol><li>Откройте CRM в Google Chrome или Microsoft Edge.</li><li>В Chrome откройте меню ⋮ → «Трансляция, сохранение и отправка» → «Установить страницу как приложение». В Edge: меню … → «Приложения» → «Установить этот сайт как приложение». Название пункта может отличаться в вашей версии.</li><li>Подтвердите установку. При предложении включите создание ярлыка на рабочем столе или закрепление на панели задач.</li></ol>
  <h2>На телефоне</h2><p>Android: меню Chrome → «Установить приложение» или «Добавить на главный экран». iPhone: Safari → «Поделиться» → «На экран Домой».</p>
  <p className="muted">Для бронирований, оплат и уведомлений нужен интернет. Без подключения приложение не сохраняет новые операции.</p>
  <Link className="button-outline" href="/">Открыть CRM</Link>
 </section></main>;
}
