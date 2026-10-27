import test,{TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { SyncProgressPanel, SyncProgressPopup } from '../src/progress-view';
import { describeProgress } from '../src/progress';
import { Notice } from './obsidian-mock';

// A small DOM double checks rendering/state transitions; it does not claim a
// visual test inside the real Obsidian notification host.
class Element {
  children:Element[]=[];textContent='';className='';hidden=false;disabled=false;max=0;isConnected=false;
  attributes=new Map<string,string>();listeners=new Map<string,((e:{stopPropagation():void})=>void)[]>();
  constructor(public tag:string,public ownerDocument:Doc){}
  classList={add:(...names:string[]):void=>{this.className=[...new Set([...this.className.split(' ').filter(Boolean),...names])].join(' ');}};
  closest():Element|null{return null;}
  appendChild(child:Element):Element{if(child.tag==='#fragment')this.children.push(...child.children);else this.children.push(child);return child;}
  setAttribute(key:string,value:string):void{this.attributes.set(key,value);}
  removeAttribute(key:string):void{this.attributes.delete(key);}
  set value(value:number){this.attributes.set('value',String(value));}get value():number{return Number(this.attributes.get('value')??0);}
  addEventListener(type:string,callback:(e:{stopPropagation():void})=>void):void{this.listeners.set(type,[...(this.listeners.get(type)??[]),callback]);}
  click():void{if(!this.disabled)for(const fn of this.listeners.get('click')??[])fn({stopPropagation:()=>{}});}
  all(tag:string):Element[]{return[...(this.tag===tag?[this]:[]),...this.children.flatMap(e=>e.all(tag))];}
}
class Doc {createElement(tag:string):Element{return new Element(tag,this);}createDocumentFragment():Element{return new Element('#fragment',this);}}
function dom(t:TestContext){
  const doc=new Doc(),prior=Object.getOwnPropertyDescriptor(globalThis,'document');Notice.instances=[];
  Object.defineProperty(globalThis,'document',{value:doc,configurable:true});
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'document',prior);else Reflect.deleteProperty(globalThis,'document');});
  return doc;
}
const element=(value:unknown):Element=>value as Element;

test('unknown Drive scan totals remain indeterminate and never invent a percentage',t=>{
  const doc=dom(t),root=doc.createElement('div'),panel=new SyncProgressPanel(root as unknown as HTMLElement);
  panel.update({phase:'scan-drive',completed:143,folders:8,path:'Notes'});
  assert.equal(root.all('progress')[0]!.attributes.has('value'),false);
  assert.equal(describeProgress({phase:'scan-drive',completed:143,folders:8}).percent,undefined);
  assert.match(root.all('div').find(e=>e.className.endsWith('-detail'))!.textContent,/143 items.*8 mappen/);
});

test('file progress is explicitly phase-specific and resets when the next phase has no total',t=>{
  const doc=dom(t),root=doc.createElement('div'),panel=new SyncProgressPanel(root as unknown as HTMLElement);
  panel.update({phase:'download',completed:1,total:4,path:'Notes/a.md'});assert.equal(root.all('progress')[0]!.value,25);
  assert.match(root.all('div').find(e=>e.className.endsWith('-detail'))!.textContent,/25% van deze fase/);
  panel.update({phase:'rescan',completed:0});assert.equal(root.all('progress')[0]!.attributes.has('value'),false);
});

test('failed/cancelled operations hide the completion bar and render error text as plain text',t=>{
  const doc=dom(t);for(const outcome of ['error','cancelled'] as const){const root=doc.createElement('div'),panel=new SyncProgressPanel(root as unknown as HTMLElement);
    panel.update({phase:'upload',completed:1,total:4});panel.finish(outcome,'<script>untrusted failure</script>');assert.equal(root.all('progress')[0]!.hidden,true);
    assert.equal(root.all('script').length,0);assert.equal(root.all('div').find(e=>e.className.endsWith('-detail'))!.textContent,'<script>untrusted failure</script>');
  }
});

test('stopping calls cancellation once; hiding does not cancel and reopening shows the latest counts',t=>{
  dom(t);let cancelled=0;const popup=new SyncProgressPopup(()=>cancelled++);t.after(()=>popup.dispose());popup.start();
  const first=Notice.instances.at(-1)!;assert.equal(first.duration,0);const buttons=element(first.messageEl).all('button');
  buttons[1]!.click();assert.equal(first.hidden,true);assert.equal(cancelled,0);assert.equal(popup.active,true);
  popup.update({phase:'upload',completed:2,total:5,path:'new.md'});popup.show();const current=Notice.instances.at(-1)!;
  assert.equal(element(current.messageEl).all('progress')[0]!.value,40);assert.match(element(current.messageEl).all('div').find(e=>e.className.endsWith('-file'))!.textContent,/new.md/);
  const stop=element(current.messageEl).all('button')[0]!;stop.click();stop.click();assert.equal(cancelled,1);assert.equal(stop.disabled,true);
});

test('completion is shown only after finish, and unload removes the persistent popup',t=>{
  dom(t);const popup=new SyncProgressPopup(()=>{});t.after(()=>popup.dispose());popup.start();popup.update({phase:'upload',completed:1,total:1});
  assert.equal(popup.active,true,'100% of upload phase is not completion of the full sync');
  popup.finish('success','2 gedownload, 1 geüpload.');assert.equal(popup.active,false);
  const notice=Notice.instances.at(-1)!,root=element(notice.messageEl);assert.equal(root.all('div').find(e=>e.className.endsWith('-title'))!.textContent,'Klaar');
  assert.equal(root.all('button')[0]!.hidden,true);popup.dispose();assert.equal(notice.hidden,true);
});

test('starting another sync clears the previous completion timer and resets its progress',t=>{
  dom(t);t.mock.timers.enable({apis:['setTimeout']});const popup=new SyncProgressPopup(()=>{});t.after(()=>popup.dispose());
  popup.start();popup.finish('success','done');t.mock.timers.tick(4000);popup.start();const notice=Notice.instances.at(-1)!;
  t.mock.timers.tick(2000);assert.equal(notice.hidden,false);assert.equal(popup.active,true);assert.equal(element(notice.messageEl).all('progress')[0]!.attributes.has('value'),false);
});
