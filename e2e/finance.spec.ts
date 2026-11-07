import { test, expect, type Page, type Locator } from '@playwright/test';
async function save(form:Locator) {
 await form.getByRole('button',{name:'Сохранить',exact:true}).click();
 await expect(form.getByRole('button',{name:'Сохранить',exact:true})).toBeEnabled();await expect(form.getByText('Сохранено',{exact:true})).toBeVisible();
}
async function financeTrip(page:Page) {
 await page.getByRole('button',{name:'₽ Расходы и расчёты',exact:true}).click();
 await page.getByLabel('Рейс для расчёта').selectOption({label:'Ош → Баткен · KGS · eeeeeeee'});
}
function metric(page:Page,label:string) {return page.locator('.finance-metrics article').filter({has:page.locator('span',{hasText:label})}).locator('strong');}
test('возврат, расходы, завершение и полная выплата водителю',async({page})=>{
 await page.goto('/login');await page.getByLabel('Логин',{exact:true}).fill('e2e-owner');await page.getByLabel('Пароль',{exact:true}).fill('e2e-owner-password-1234');await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('button',{name:'Бронирования'}).click();
 const booking=page.locator('article.booking').filter({has:page.getByRole('heading',{name:'Финансовый пассажир',exact:true})});
 await booking.getByText('Частичный возврат',{exact:true}).click();const refund=booking.locator('form').filter({has:page.locator('input[name=action][value=refund]')});
 await refund.getByLabel('Сумма возврата').fill('200');await refund.getByLabel('Причина возврата').fill('Согласованная скидка');await save(refund);
 await expect(booking.locator('.amounts').getByText(/800/)).toHaveCount(2);
 await booking.getByText('Посадка и неявка',{exact:false}).click();await booking.getByRole('button',{name:'Посадка',exact:true}).click();await expect(booking.locator('.attendance-status.boarded')).toBeVisible();
 await financeTrip(page);
 const addExpense=page.locator('details').filter({has:page.locator('summary',{hasText:'Добавить расход'})});await addExpense.locator('summary').click();
 for(const [amount,payer,description] of [['100','park','Топливо оплачено парком'],['50','driver','Стоянка оплачена водителем']]) {
  const form=addExpense.locator('form');await form.getByLabel('Сумма расхода').fill(amount);await form.getByLabel('Кто оплатил').selectOption(payer);await form.getByLabel('Описание расхода').fill(description);await save(form);
 }
 await expect(metric(page,'Расходы рейса')).toContainText('150');
 await page.getByRole('button',{name:'↗ Рейсы',exact:true}).click();
 const trip=page.locator('article.trip').filter({has:page.locator('.route',{hasText:'Ош'})});await trip.getByText('Завершить рейс',{exact:true}).click();
 const completion=trip.locator('form').filter({has:page.locator('input[name=action][value=completeTrip]')});
 // Completing the trip removes the form; assert the persisted status instead of old form state.
 await completion.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(trip.locator('.pill')).toContainText('Завершён');
 await financeTrip(page);
 const approve=page.locator('form').filter({has:page.locator('input[name=action][value=approveSettlement]')});await approve.getByLabel('Вознаграждение').fill('300');await approve.getByLabel('Основание суммы').fill('Согласованное вознаграждение');await approve.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(metric(page,'Осталось выплатить')).toContainText('350');
 const payout=()=>page.locator('form').filter({has:page.locator('input[name=action][value=payout]')});
 await payout().getByLabel('Сумма выплаты').fill('100');await save(payout());await expect(metric(page,'Осталось выплатить')).toContainText('250');
 await payout().getByLabel('Сумма выплаты').fill('250');await payout().getByRole('button',{name:'Сохранить',exact:true}).click();await expect(page.getByText('Расчёт выплачен полностью.',{exact:true})).toBeVisible();
 await expect(metric(page,'Результат по начислениям')).toContainText('350');await expect(metric(page,'Денежный итог парка')).toContainText('350');
 await expect(page.getByText('Добавить расход',{exact:true})).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
