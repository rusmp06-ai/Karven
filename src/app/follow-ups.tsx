import {Icon,type IconName} from './icons';
export type FollowUp={id:string;title:string;detail:string;label:string;icon:IconName;onClick:()=>void};
export function FollowUps({items}:{items:FollowUp[]}){
 return <section className="panel follow-ups"><div className="panel-heading"><h2>Требуют внимания</h2><span className="muted">Ближайшие дела</span></div><div className="follow-up-grid">{items.slice(0,3).map(item=><article key={item.id}><span className="follow-up-icon"><Icon name={item.icon}/></span><div><strong>{item.title}</strong><p>{item.detail}</p><button className="button-outline compact" onClick={item.onClick}>{item.label}</button></div></article>)}{!items.length&&<div className="all-clear"><Icon name="check"/><strong>Всё под контролем</strong><span>Сейчас нет дел, требующих внимания.</span></div>}</div></section>;
}
