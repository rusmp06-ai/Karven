import { test, expect, type Page } from '@playwright/test';
const password='employee-password-1234';
async function login(page:Page,username:string,pass:string) {
 await page.goto('/login');await page.getByLabel('Логин',{exact:true}).fill(username);await page.getByLabel('Пароль',{exact:true}).fill(pass);await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('button',{name:'Выйти'})).toBeVisible();
}
async function save(form:ReturnType<Page['locator']>) {await form.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(form.getByRole('button',{name:'Сохранить',exact:true})).toBeEnabled();await expect(form.getByText('Сохранено',{exact:true})).toBeVisible();}
test('владелец назначает рейс и создаёт сотрудников; роли ограничивают доступ',async({page,browser})=>{
 await page.goto('/');await expect(page).toHaveURL(/\/login$/);
 await login(page,'e2e-owner','e2e-owner-password-1234');
 const cookies=await page.context().cookies();expect(cookies.find(c=>c.name==='karven_session')?.httpOnly).toBe(true);
 await page.getByRole('button',{name:'Водители и машины'}).click();
 const addDriver=page.locator('details').filter({has:page.locator('summary',{hasText:'+ Добавить водителя'})});await addDriver.locator('summary').click();
 await addDriver.getByLabel('ФИО',{exact:true}).fill('Тестовый водитель');await addDriver.getByLabel('Телефон',{exact:true}).fill('+996555123456');await addDriver.getByLabel('Номер водительского удостоверения').fill('TEST-123');await addDriver.getByLabel('Удостоверение действительно до').fill('2099-12-31');await save(addDriver.locator('form'));
 const addVehicle=page.locator('details').filter({has:page.locator('summary',{hasText:'+ Добавить автомобиль'})});await addVehicle.locator('summary').click();
 await addVehicle.getByLabel('Госномер').fill('01 TEST 123');await addVehicle.getByLabel('Модель').fill('Toyota Test');await addVehicle.getByLabel('Владелец',{exact:true}).fill('Тестовый парк');await save(addVehicle.locator('form'));
 await page.getByRole('button',{name:'↗ Рейсы',exact:true}).click();
 const trip=page.locator('.editor form');await trip.getByLabel('Откуда').fill('Бишкек');await trip.getByLabel('Куда',{exact:true}).fill('Каракол');
 const departure=new Date(Date.now()+3*86400000);const toLocal=(d:Date)=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
 await trip.getByLabel('Дата и время').fill(toLocal(departure));await save(trip);
 await page.locator('article.trip').filter({has:page.locator('.route',{hasText:'Бишкек'})}).getByText('Назначить или заменить',{exact:true}).click();const assignment=page.locator('article.trip').filter({has:page.locator('.route',{hasText:'Бишкек'})}).locator('.assignment form').filter({has:page.locator('input[name=action][value=assign]')});await assignment.getByLabel('Водитель',{exact:true}).selectOption({label:'Тестовый водитель'});await assignment.getByLabel('Автомобиль',{exact:true}).selectOption({label:'01TEST123 · Toyota Test · 4 мест'});await save(assignment);
 await expect(page.locator('.assignment').getByText('Тестовый водитель · Toyota Test · 01TEST123')).toBeVisible();
 await page.getByRole('button',{name:'Бронирования'}).click();const booking=page.locator('.editor form');const tripOption=await booking.getByRole('option',{name:/Бишкек → Каракол/}).getAttribute('value');await booking.getByLabel('Рейс',{exact:true}).selectOption(tripOption!);await booking.getByLabel('Имя клиента').fill('Тестовый пассажир');await booking.getByLabel('Телефон с кодом страны').fill('+996555111222');await booking.getByLabel('Общая стоимость').fill('1500');await save(booking);
 await page.getByRole('button',{name:'Сотрудники'}).click();const employee=page.locator('.editor form');
 for(const role of ['driver','dispatcher']) {
  await employee.getByLabel('Имя',{exact:true}).fill(role==='driver'?'Водитель сотрудник':'Диспетчер сотрудник');await employee.getByLabel('Логин').fill(`test-${role}`);await employee.getByLabel('Пароль (от 12 символов)').fill(password);await employee.getByLabel('Роль',{exact:true}).selectOption(role);
  if(role==='driver')await employee.getByLabel('Карточка водителя').selectOption({label:'Тестовый водитель'});
  await save(employee);
 }
 await page.getByRole('button',{name:'Журнал действий'}).click();await expect(page.getByText('Назначены водитель и автомобиль',{exact:true})).toBeVisible();
 const driverContext=await browser.newContext();const driver=await driverContext.newPage();
 await login(driver,'test-driver',password);await expect(driver.getByRole('heading',{name:'Мои рейсы',exact:true})).toBeVisible();await expect(driver.getByRole('button',{name:'Сотрудники'})).toHaveCount(0);await expect(driver.getByRole('button',{name:'Водители и машины'})).toHaveCount(0);await expect(driver.locator('.editor')).toHaveCount(0);
 await driver.getByRole('button',{name:'Бронирования'}).click();await expect(driver.getByRole('heading',{name:'Тестовый пассажир'})).toBeVisible();await expect(driver.getByText('Оплата и управление')).toHaveCount(0);await driver.getByRole('button',{name:'Выйти'}).click();await expect(driver).toHaveURL(/\/login$/);await driverContext.close();
 const dispatcherContext=await browser.newContext();const dispatcher=await dispatcherContext.newPage();await login(dispatcher,'test-dispatcher',password);await expect(dispatcher.getByRole('button',{name:'Сотрудники'})).toHaveCount(0);await expect(dispatcher.getByRole('button',{name:'Журнал действий'})).toHaveCount(0);await expect(dispatcher.getByRole('button',{name:'Водители и машины'})).toBeVisible();await dispatcherContext.close();
});
