import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CloseResult, CloseSync, CloseOptions } from '../src/close';
import { CloseReceipt } from '../src/storage';

function fixture(overrides:Partial<CloseOptions>={},native=true){
  const events:string[]=[],results:CloseResult[]=[];let signal:AbortSignal|undefined;
  const options:CloseOptions={enabled:()=>true,timeoutMs:()=>30_000,start:()=>{events.push('start');},work:async s=>{signal=s;events.push('sync');},cancel:()=>{events.push('abort');},finish:r=>{results.push(r);events.push('finish');},close:()=>{events.push('close');},...overrides};
  return {guard:new CloseSync(options,native),events,results,get signal(){return signal;}};
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}

test('native close is prevented; final sync completes before a single normal close',async()=>{
  const f=fixture();let prevented=false;f.guard.nativeClose({preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,true);assert.equal(f.guard.holding,true);
  await f.guard.request();assert.deepEqual(f.events,['start','sync','finish','close']);assert.equal(f.signal?.aborted,false);
  f.guard.nativeClose({preventDefault:()=>assert.fail('final close must pass through')});assert.equal(f.guard.request(),undefined);
});

test('a renderer quit arriving before the native event shares the operation and lets Obsidian await OTHER quit tasks',async()=>{
  const d=deferred(),f=fixture({work:()=>d.promise});const tasks:Promise<unknown>[]=[];
  f.guard.quit({addPromise:p=>tasks.push(p)});let prevented=false;
  f.guard.nativeClose({preventDefault:()=>{prevented=true;}});d.resolve();await Promise.all(tasks);
  assert.equal(prevented,true);assert.deepEqual(f.events,['start','finish']);assert.equal(f.results[0]?.kind,'success');
  assert.equal(f.events.includes('close'),false,'core closes only after every registered quit task');
});

test('a native event arriving before renderer quit also delegates closing to Obsidian',async()=>{
  const f=fixture();f.guard.nativeClose({preventDefault:()=>{}});const tasks:Promise<unknown>[]=[];
  f.guard.quit({addPromise:p=>tasks.push(p)});await Promise.all(tasks);assert.equal(f.events.includes('close'),false);
});

test('repeated close requests do not create parallel uploads or reset the timeout',async()=>{
  const d=deferred();let runs=0;const f=fixture({work:async()=>{runs++;await d.promise;}});
  const first=f.guard.request();assert.strictEqual(f.guard.request(),first);
  f.guard.nativeClose({preventDefault:()=>{}});await Promise.resolve();d.resolve();await first;assert.equal(runs,1);
});

test('disabled or paused close sync does not prevent native closing or register quit tasks',()=>{
  const f=fixture({enabled:()=>false});f.guard.nativeClose({preventDefault:()=>assert.fail()});f.guard.quit({addPromise:()=>assert.fail()});assert.deepEqual(f.events,[]);
});

test('a network or disk error cancels remaining work and closes with an unconfirmed result',async()=>{
  const f=fixture({work:async()=>{throw new Error('offline');}});const result=await f.guard.request();
  assert.equal(result?.kind,'error');assert.deepEqual(f.events,['start','abort','finish','close']);
});

test('timeout aborts outstanding requests and does not wait for an unresponsive worker',async()=>{
  const d=deferred();let signal:AbortSignal|undefined;
  const f=fixture({timeoutMs:()=>15,work:async s=>{signal=s;await d.promise;}});
  const result=await f.guard.request();assert.equal(result?.kind,'timeout');assert.equal(signal?.aborted,true);assert.equal(f.events.filter(e=>e==='close').length,1);
  d.resolve();await new Promise(r=>setTimeout(r,5));assert.equal(f.results.length,1,'a late success must not replace a timed out receipt');
});

test('skip button stops the sync and releases the close immediately',async()=>{
  const d=deferred(),f=fixture({work:()=>d.promise});const p=f.guard.request();f.guard.skip();assert.equal((await p)?.kind,'skipped');assert.deepEqual(f.events,['abort','finish','close']);d.resolve();
});

test('plugin unload never initiates a new sync or closes the window by itself',async()=>{
  const f=fixture();f.guard.dispose();assert.equal(f.guard.request(),undefined);assert.deepEqual(f.events,[]);
  const d=deferred(),g=fixture({work:()=>d.promise});const p=g.guard.request();await Promise.resolve();g.guard.dispose();assert.equal((await p)?.kind,'disposed');assert.equal(g.events.includes('close'),false);d.resolve();
});

test('failure to cancel the native event aborts instead of pretending the long wait is protected',async()=>{
  const f=fixture();f.guard.nativeClose({preventDefault:()=>{throw new Error('unsupported');}});const result=await f.guard.request();assert.equal(result?.kind,'error');assert.equal(f.events.includes('sync'),false);
});

test('a receipt marks interrupted closing and is cleared by a confirmed later sync',t=>{
  const dir=fs.mkdtempSync(path.resolve('.test-build','close-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'close-sync.json'),receipt=new CloseReceipt(dir,file);assert.equal(receipt.pending(),false);
  receipt.write(true,'started');assert.equal(new CloseReceipt(dir,file).pending(),true);
  receipt.write(false,'confirmed');assert.equal(new CloseReceipt(dir,file).pending(),false);
  fs.writeFileSync(file,'{broken');assert.equal(receipt.pending(),true);
});

test('close receipt refuses junction redirection',t=>{
  const dir=fs.mkdtempSync(path.resolve('.test-build','receipt-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'real'));fs.symlinkSync(path.join(dir,'real'),path.join(dir,'link'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>new CloseReceipt(dir,path.join(dir,'link','close-sync.json')).write(true),/Symbolische/);
});
