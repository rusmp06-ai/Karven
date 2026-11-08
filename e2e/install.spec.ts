import {test,expect} from '@playwright/test';
import {login,save,closeModal} from './helpers';

test('установочный манифест, иконки и настройки обновления доступны браузеру',async({page})=>{
 await page.goto('/install');await expect(page.getByRole('heading',{name:'Установить приложение',exact:true})).toBeVisible();
 const manifest=await (await page.request.get('/manifest.webmanifest')).json();expect(manifest).toMatchObject({id:'/',short_name:'KARVEN',start_url:'/',scope:'/',display:'standalone'});
 for(const icon of manifest.icons){const response=await page.request.get(icon.src);expect(response.ok()).toBe(true);const bytes=await response.body();expect(bytes.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');const size=Number(icon.sizes.split('x')[0]);expect(bytes.readUInt32BE(16)).toBe(size);expect(bytes.readUInt32BE(20)).toBe(size)}
 const worker=await page.request.get('/sw.js');expect(worker.ok()).toBe(true);expect(worker.headers()['cache-control']).toContain('no-store');expect(worker.headers()['service-worker-allowed']).toBe('/');
 const cdp=await page.context().newCDPSession(page);const result=await cdp.send('Page.getAppManifest');expect(result.url).toContain('/manifest.webmanifest');expect(result.errors).toHaveLength(0);await cdp.detach();
});

test('установка открывается только после нажатия пользователя',async({page})=>{
 await page.goto('/install');await expect(page.getByRole('heading',{name:'Установить приложение',exact:true})).toBeVisible();
 await page.evaluate(()=>{
  const event=new Event('beforeinstallprompt',{cancelable:true});
  Object.assign(event,{prompt:async()=>{document.documentElement.dataset.installPromptCalls=String(Number(document.documentElement.dataset.installPromptCalls??'0')+1)},userChoice:Promise.resolve({outcome:'accepted',platform:'web'})});
  window.dispatchEvent(event);document.documentElement.dataset.promptDeferred=String(event.defaultPrevented);
 });
 await expect(page.getByRole('button',{name:'Установить KARVEN',exact:true})).toBeVisible();expect(await page.locator('html').getAttribute('data-install-prompt-calls')).toBeNull();expect(await page.locator('html').getAttribute('data-prompt-deferred')).toBe('true');
 await page.getByRole('button',{name:'Установить KARVEN',exact:true}).click();await expect(page.getByRole('status')).toContainText('KARVEN установлено');expect(await page.locator('html').getAttribute('data-install-prompt-calls')).toBe('1');
});

test('без сети черновик сохраняется, операции не отправляются, личные страницы не кэшируются',async({page,context})=>{
 await login(page);await page.evaluate(async()=>{await navigator.serviceWorker.ready});await expect.poll(()=>page.evaluate(()=>!!navigator.serviceWorker.controller)).toBe(true);
 await page.getByRole('button',{name:'Создать рейс',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Создать рейс',exact:true});
 await dialog.getByLabel('Откуда',{exact:true}).fill('Установка без сети');await dialog.getByLabel('Куда',{exact:true}).fill('Нарын установка');await dialog.getByLabel('Дата и время').fill(new Date(Date.now()+7*86400000).toISOString().slice(0,16));await dialog.getByLabel('Количество мест').fill('8');
 const posts:string[]=[];page.on('request',request=>{if(request.method()==='POST')posts.push(request.url())});
 await context.setOffline(true);await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('Нет подключения');await expect(dialog.getByLabel('Количество мест')).toHaveValue('8');await expect(dialog.getByLabel('Откуда',{exact:true})).toHaveValue('Установка без сети');expect(posts).toHaveLength(0);
 await context.setOffline(false);await save(dialog.locator('form'));await closeModal(page);
 const cached=await page.evaluate(async()=>{const urls:string[]=[];for(const name of await caches.keys())if(name.startsWith('karven-pwa-public-'))for(const request of await (await caches.open(name)).keys())urls.push(new URL(request.url).pathname);return urls});expect(cached).toEqual(['/offline.html']);
 await context.setOffline(true);await page.goto('/');await expect(page.getByRole('heading',{name:'Нет подключения к интернету',exact:true})).toBeVisible();expect(await page.content()).not.toContain('Финансовый пассажир');expect(await page.content()).not.toContain('Установка без сети');
 await context.setOffline(false);await page.getByRole('button',{name:'Повторить подключение',exact:true}).click();await expect(page.getByRole('button',{name:'Выйти',exact:true})).toBeVisible();
});
