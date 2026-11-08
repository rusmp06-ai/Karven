import {test,expect} from '@playwright/test';
import {openActions,login,createTrip,dispatch,selectTrip,tripRows,save,openTrip,closeModal} from './helpers';

test('рейс сохраняет 8 мест после создания и перезагрузки',async({page})=>{
 await login(page);await createTrip(page,{origin:'Аудит восьми мест',destination:'Нарын аудит',day:5,capacity:8});
 await dispatch(page);await selectTrip(page,'Аудит восьми мест');await expect(tripRows(page,'Аудит восьми мест').locator('.seat-count')).toHaveText('0 / 8');
 await expect(page.locator('.seat-grid .seat-tile')).toHaveCount(8);
 await page.reload();await dispatch(page);await selectTrip(page,'Аудит восьми мест');await expect(tripRows(page,'Аудит восьми мест').locator('.seat-count')).toHaveText('0 / 8');
 await expect(page.locator('.seat-grid .seat-tile')).toHaveCount(8);
});

test('ошибка создания не стирает дату и выбранные места',async({page})=>{
 await login(page);await page.getByRole('button',{name:'Создать рейс',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Создать рейс',exact:true});
 await dialog.getByLabel('Откуда',{exact:true}).fill('Бишкек');await dialog.getByLabel('Куда',{exact:true}).fill('Бишкек');const date=new Date(Date.now()+5*86400000).toISOString().slice(0,16);await dialog.getByLabel('Дата и время').fill(date);await dialog.getByLabel('Количество мест').fill('8');
 await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('отличаться');
 await expect(dialog.getByLabel('Дата и время')).toHaveValue(date);await expect(dialog.getByLabel('Количество мест')).toHaveValue('8');
 await dialog.getByLabel('Откуда',{exact:true}).fill('Аудит исправления');await dialog.getByLabel('Куда',{exact:true}).fill('Нарын после ошибки');await expect(dialog.getByRole('alert')).toHaveCount(0);await save(dialog.locator('form'));await closeModal(page);await expect(tripRows(page,'Аудит исправления').locator('.seat-count')).toHaveText('0 / 8');
});

test('назначение требует подтверждения смены 8 → 4 и сохраняет выбранные ресурсы',async({page})=>{
 await login(page);await createTrip(page,{origin:'Аудит назначения',destination:'Нарын назначение',day:6,capacity:8});
 await page.getByRole('button',{name:'Водители',exact:true}).click();const driver=page.locator('details').filter({has:page.locator('summary',{hasText:'+ Добавить водителя'})});await driver.locator('summary').click();
 await driver.getByLabel('ФИО',{exact:true}).fill('Водитель аудита');await driver.getByLabel('Телефон',{exact:true}).fill('+996555012345');await driver.getByLabel('Номер водительского удостоверения').fill('AUDIT');await driver.getByLabel('Удостоверение действительно до').fill('2099-12-31');await save(driver.locator('form'));
 await page.getByRole('button',{name:'Автомобили',exact:true}).click();const vehicle=page.locator('details').filter({has:page.locator('summary',{hasText:'+ Добавить автомобиль'})});await vehicle.locator('summary').click();
 for(const capacity of [4,8]){
  await vehicle.getByLabel('Госномер').fill(`AUDIT${capacity}`);await vehicle.getByLabel('Модель').fill(`Авто ${capacity}`);await vehicle.getByLabel('Пассажирских мест').fill(String(capacity));await vehicle.getByLabel('Владелец',{exact:true}).fill('Аудит');
  await expect(vehicle.getByText('Сохранено',{exact:true})).toHaveCount(0);await save(vehicle.locator('form'));
 }
 const trip=await openTrip(page,'Аудит назначения');await openActions(trip,'Действия с рейсом');await trip.getByText('Назначить или заменить',{exact:true}).click();const form=trip.locator('form').filter({has:page.locator('input[name=action][value=assign]')});
 await form.getByLabel('Водитель',{exact:true}).selectOption({label:'Водитель аудита'});await form.getByLabel('Автомобиль',{exact:true}).selectOption({label:'AUDIT4 · Авто 4 · 4 мест'});
 const confirmation=form.getByRole('checkbox',{name:'Подтверждаю изменение вместимости с 8 до 4 мест'});await expect(confirmation).not.toBeChecked();await expect(form.getByRole('button',{name:'Сохранить',exact:true})).toBeDisabled();await expect(trip.locator('.seats')).toContainText('из 8');
 await form.getByLabel('Автомобиль',{exact:true}).selectOption({label:'AUDIT8 · Авто 8 · 8 мест'});await expect(form.locator('button[type=submit]')).toBeEnabled();
 await form.getByLabel('Автомобиль',{exact:true}).selectOption({label:'AUDIT4 · Авто 4 · 4 мест'});await confirmation.check();await save(form);await expect(trip.locator('.seats')).toContainText('из 4');
 await expect(form.getByLabel('Автомобиль',{exact:true}).locator('option:checked')).toHaveText('AUDIT4 · Авто 4 · 4 мест');await expect(form.getByLabel('Водитель',{exact:true}).locator('option:checked')).toHaveText('Водитель аудита');
 await openActions(trip,'Действия с рейсом');const end=form.getByLabel('Плановое окончание');await end.fill('');await expect(end).toHaveValue('');await end.fill(new Date(Date.now()+7*86400000).toISOString().slice(0,16));await save(form);
 await closeModal(page);await page.goto('/');await dispatch(page);await selectTrip(page,'Аудит назначения');await expect(tripRows(page,'Аудит назначения').locator('.seat-count')).toHaveText('0 / 4');
});

test('ошибка автомобиля сохраняет введённые 8 мест вместо сброса к 4',async({page})=>{
 await login(page);await page.getByRole('button',{name:'Автомобили',exact:true}).click();const vehicle=page.locator('details').filter({has:page.locator('summary',{hasText:'+ Добавить автомобиль'})});await vehicle.locator('summary').click();
 await vehicle.getByLabel('Госномер').fill('DRAFT4');await vehicle.getByLabel('Модель').fill('Тест черновика');await vehicle.getByLabel('Владелец',{exact:true}).fill('Парк');await save(vehicle.locator('form'));
 await vehicle.getByLabel('Госномер').fill('DRAFT4');await vehicle.getByLabel('Модель').fill('Исправляемая машина');await vehicle.getByLabel('Пассажирских мест').fill('8');await vehicle.getByLabel('Владелец',{exact:true}).fill('Владелец черновика');
 await vehicle.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(vehicle.getByRole('alert')).toContainText('уже');await expect(vehicle.getByLabel('Пассажирских мест')).toHaveValue('8');await expect(vehicle.getByLabel('Модель')).toHaveValue('Исправляемая машина');
 await vehicle.getByLabel('Госномер').fill('DRAFT8');await save(vehicle.locator('form'));await expect(page.locator('summary').filter({hasText:'DRAFT8 · Исправляемая машина · 8 мест'})).toBeVisible();
});

test('вкладки и выбор рейса меняют URL без запроса страницы; обновление выполняется явно',async({page})=>{
 await login(page);await createTrip(page,{origin:'Аудит навигации',destination:'Нарын навигация',day:7,capacity:8});
 await expect(page).toHaveURL(/trip=/);const requests:string[]=[];
 page.on('request',request=>{const url=new URL(request.url());if(request.method()==='GET'&&url.pathname==='/'&&(url.searchParams.has('_rsc')||request.headers().rsc))requests.push(request.url())});
 await page.getByRole('button',{name:'Автомобили',exact:true}).click();await expect(page.getByRole('heading',{name:/Автомобили ·/})).toBeVisible();
 await page.getByRole('button',{name:'Водители',exact:true}).click();await expect(page.getByRole('heading',{name:/Водители ·/})).toBeVisible();
 await dispatch(page);await selectTrip(page,'Аудит навигации');await expect(page).toHaveURL(/tab=trips/);expect(requests).toHaveLength(0);
 await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await expect.poll(()=>requests.length).toBeGreaterThan(0);await expect(tripRows(page,'Аудит навигации').locator('.seat-count')).toHaveText('0 / 8');
});
