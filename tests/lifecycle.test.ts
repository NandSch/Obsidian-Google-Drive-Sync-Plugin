import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { App, PluginManifest } from 'obsidian';
import DriveVaultSync from '../src/main';
import { TextFileView, TFile, Plugin as MockPlugin } from './obsidian-mock';
import { CloseSync } from '../src/close';
import { SyncProgress } from '../src/progress';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
interface Internals {
  installCloseSync():void;
  performSync(dry:boolean,manual:boolean,signal?:AbortSignal):Promise<void>;
  showCloseProgress():void; hideCloseProgress():void; renderStatus():void;
  closeSync?:CloseSync;
  closeReceipt:{write(pending:boolean,reason?:string):void};
  updateSyncProgress(progress:SyncProgress):void;
  progressPopup?:{active:boolean;show():void;update(progress:SyncProgress):void};
}
function setup(t:TestContext){
  const events:string[]=[],native=new EventEmitter();let quit:((tasks:{addPromise(p:Promise<unknown>):void})=>void)|undefined;
  const prior=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{value:{electronWindow:native,close:()=>events.push('close')},configurable:true});
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'window',prior);else Reflect.deleteProperty(globalThis,'window');});
  const view=new TextFileView(new TFile('note.md',{size:3}));view.save=async()=>{events.push('save-editor');};
  const app={workspace:{on:(event:string,listener:typeof quit)=>{assert.equal(event,'quit');quit=listener;return{};},iterateAllLeaves:(fn:(leaf:{view:TextFileView})=>void)=>fn({view})}} as unknown as App;
  const plugin=new DriveVaultSync(app,{} as PluginManifest),inside=plugin as unknown as Internals;
  plugin.settings={...plugin.settings,rootId:'drive-folder',autoSync:true,syncOnClose:true};
  plugin.auth={connected:()=>true,cancel:()=>events.push('cancel-auth')} as unknown as typeof plugin.auth;
  inside.renderStatus=()=>{};inside.showCloseProgress=()=>events.push('progress');inside.hideCloseProgress=()=>{};
  inside.closeReceipt={write:pending=>events.push(pending?'pending':'confirmed')};
  return{events,native,plugin,inside,quit:()=>quit};
}

test('plugin closing settles an active run, saves the final editor, then runs one fresh sync',async t=>{
  const f=setup(t),first=deferred();let runs=0,closingSignal:AbortSignal|undefined;
  f.inside.performSync=async(_dry,_manual,signal)=>{f.plugin.busy=true;runs++;closingSignal=signal;f.events.push(signal?'final-sync':'initial-sync');try{if(!signal)await first.promise;}finally{f.plugin.busy=false;}};
  f.inside.installCloseSync();const running=f.plugin.sync(false,true);
  let prevented=false;f.native.emit('close',{preventDefault:()=>{prevented=true;}});await Promise.resolve();await Promise.resolve();
  assert.equal(prevented,true);assert.equal(f.events.includes('save-editor'),false,'must settle old run before flushing editors');
  first.resolve();await running;await f.inside.closeSync!.request();
  assert.equal(runs,2);assert.ok(closingSignal);assert.ok(f.events.indexOf('save-editor')<f.events.indexOf('final-sync'));assert.ok(f.events.indexOf('final-sync')<f.events.indexOf('confirmed'));assert.equal(f.events.at(-1),'close');
  (f.plugin as unknown as MockPlugin).callbacks.forEach(fn=>fn());assert.equal(f.native.listenerCount('close'),0);
});

test('the real plugin wiring gives the quit task to Obsidian instead of closing ahead of its other saves',async t=>{
  const f=setup(t);f.inside.performSync=async(_dry,_manual,signal)=>{assert.ok(signal);f.events.push('final-sync');};f.inside.installCloseSync();
  const promises:Promise<unknown>[]=[];f.quit()!({addPromise:p=>promises.push(p)});f.native.emit('close',{preventDefault:()=>{}});await Promise.all(promises);
  assert.equal(f.events.includes('save-editor'),true);assert.equal(f.events.includes('final-sync'),true);assert.equal(f.events.includes('close'),false);
});

test('automatic pause and disabled close setting both leave the real window close untouched',t=>{
  const f=setup(t);f.inside.installCloseSync();f.plugin.settings.autoSync=false;
  f.native.emit('close',{preventDefault:()=>assert.fail('pause must be respected')});
  f.plugin.settings.autoSync=true;f.plugin.settings.syncOnClose=false;
  f.native.emit('close',{preventDefault:()=>assert.fail('close preference must be respected')});assert.deepEqual(f.events,[]);
});

test('clicking sync again while it is running reopens the progress instead of starting another run',async t=>{
  const f=setup(t);let shown=0;f.plugin.busy=true;f.inside.progressPopup={active:true,show:()=>{shown++;},update:()=>{}};
  await f.plugin.sync(false,true);assert.equal(shown,1);assert.equal(f.plugin.busy,true);
});

test('an unconnected automatic poll does not create a popup or start work',async t=>{
  const f=setup(t);f.plugin.auth={connected:()=>false} as unknown as typeof f.plugin.auth;
  await f.plugin.sync(false,false);assert.equal(f.plugin.busy,false);assert.equal(f.inside.progressPopup,undefined);
});
