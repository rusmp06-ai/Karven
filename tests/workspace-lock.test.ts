import {it,expect} from 'vitest';
import {withWorkspace} from '../src/lib/workspace-lock';

it('вложенный вызов использует текущую блокировку без взаимного ожидания',async()=>{
 expect(await withWorkspace(()=>withWorkspace(async()=>42))).toBe(42);
});
it('отложенная работа не наследует уже завершённое разрешение на доступ',async()=>{
 const order:string[]=[];let delayed!:Promise<void>;
 await withWorkspace(async()=>{delayed=new Promise<void>((resolve,reject)=>{setTimeout(()=>{withWorkspace(async()=>{order.push('delayed')}).then(resolve,reject)},0)})});
 await withWorkspace(async()=>{order.push('start');await new Promise(r=>setTimeout(r,20));order.push('end')});
 await delayed;expect(order).toEqual(['start','end','delayed']);
});
