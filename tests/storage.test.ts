import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StateStore, acquireLock, assertNoSymlinks, parseState } from '../src/storage';
import { emptyState, md5 } from '../src/model';

function temp(t: TestContext): string {
  const root=fs.mkdtempSync(path.resolve('.test-build','drive-vault-sync-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root;
}
test('state writes atomically and preserves the previous checkpoint',t=>{
  const root=temp(t), file=path.join(root,'sync-state.json'), store=new StateStore(root,file);
  const state=emptyState('root'); store.save(state);
  state.entries['note.md']={id:'file-id',hash:md5(Buffer.from('a'))}; store.save(state);
  assert.equal(store.load().entries['note.md']?.id,'file-id');
  assert.equal(Object.keys(parseState(fs.readFileSync(file+'.bak','utf8')).entries).length,0);
  assert.equal(fs.readdirSync(root).some(name=>name.endsWith('.tmp')),false);
});
test('corrupt or incompatible state never becomes an empty baseline',t=>{
  const root=temp(t), file=path.join(root,'sync-state.json'), store=new StateStore(root,file);
  fs.writeFileSync(file,'{invalid'); assert.throws(()=>store.load(),/beschadigd/u);
  assert.throws(()=>parseState(JSON.stringify({...emptyState(),schema:2})));
  assert.throws(()=>parseState(JSON.stringify({...emptyState(),entries:{'../outside':{id:'id',hash:'a'.repeat(32)}}})));
});
test('missing state with an existing backup blocks a silent reset',t=>{
  const root=temp(t), file=path.join(root,'sync-state.json');fs.writeFileSync(file+'.bak',JSON.stringify(emptyState()));
  assert.throws(()=>new StateStore(root,file).load(),/Hoofdbestand/u);
});
test('pending upload journal is validated and survives restart',t=>{
  const root=temp(t),file=path.join(root,'sync-state.json'),store=new StateStore(root,file),s=emptyState('root');
  s.pending['note.md']={id:'reserved-id',parent:'root',name:'note.md',hash:md5(Buffer.from('a')),folder:false};
  store.save(s);assert.deepEqual(store.load().pending,s.pending);
  assert.throws(()=>parseState(JSON.stringify({...s,pending:{'note.md':{...s.pending['note.md'],id:'../evil'}}})));
});
test('active process lock is exclusive and release is idempotent',t=>{
  const root=temp(t),file=path.join(root,'sync.lock'),release=acquireLock(root,file);
  assert.throws(()=>acquireLock(root,file),/al gesynchroniseerd/u);
  release();release();const release2=acquireLock(root,file);release2();assert.equal(fs.existsSync(file),false);
});
test('unreadable locks are not removed automatically',t=>{
  const root=temp(t),file=path.join(root,'sync.lock');fs.writeFileSync(file,'bad');
  assert.throws(()=>acquireLock(root,file),/Onleesbaar/u);assert.equal(fs.readFileSync(file,'utf8'),'bad');
});
test('lock owner nonce prevents deleting a replacement lock',t=>{
  const root=temp(t),file=path.join(root,'sync.lock'),release=acquireLock(root,file);
  fs.writeFileSync(file,JSON.stringify({pid:process.pid,nonce:'other-owner'}));release();assert.equal(fs.existsSync(file),true);
});
test('path containment rejects escape and junctions',t=>{
  const root=temp(t);assert.throws(()=>assertNoSymlinks(root,path.join(root,'..','outside')));
  const target=path.join(root,'target'),link=path.join(root,'linked');fs.mkdirSync(target);
  fs.symlinkSync(target,link,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>assertNoSymlinks(root,path.join(link,'note.md')),/Symbolische/u);
});
