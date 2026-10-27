import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalPort, RemotePort, SyncEngine } from '../src/engine';
import { ChangedError, FOLDER, LocalFile, RemoteFile, SyncState, assertDeletionBudget, conflictName, emptyState, included, md5, planSync, safePath, validateNamespace } from '../src/model';
import { ProgressObserver, SyncProgress } from '../src/progress';

const bytes = (s: string): Buffer => Buffer.from(s);
const lf = (s: string): LocalFile => ({ hash: md5(bytes(s)), size: bytes(s).length });
const rf = (s: string, id = 'remote-id'): RemoteFile => ({ id, name: 'note.md', parent: 'root-id', hash: md5(bytes(s)), size: bytes(s).length, etag: '"etag-' + s + '"', trashed: false, mime: 'application/octet-stream' });
class Fixture {
  data = new Map<string, Buffer>(); cloud = new Map<string, { file: RemoteFile; data: Buffer }>();
  tombstones = new Map<string, RemoteFile>(); events: string[] = []; backups: Buffer[] = [];
  state: SyncState = emptyState('root-id'); folders = new Set<string>();
  failRead = false; cancelled = false; onDownload?: () => void;
  local: LocalPort = {
    scan: async () => ({ files: new Map([...this.data].map(([p, b]) => [p, { hash: md5(b), size: b.length }])), folders: this.folders }),
    read: async p => { const b = this.data.get(p); if (!b) throw new Error('missing local'); return b; },
    write: async (p, b, expected) => {
      const now = this.data.get(p);
      if ((now ? md5(now) : null) !== expected) throw new ChangedError('local changed');
      if (now) this.backups.push(now);
      this.events.push('local-write:' + p); this.data.set(p, b);
    },
    remove: async (p, expected) => {
      const now = this.data.get(p); if (!now || md5(now) !== expected) throw new ChangedError('local changed');
      this.backups.push(now); this.events.push('local-trash:' + p); this.data.delete(p);
    },
    backup: async (_p, b) => { this.backups.push(b); }
  };
  remote: RemotePort = {
    scan: async () => ({ files: new Map([...this.cloud].map(([p, c]) => [p, c.file])), folders: new Set() }),
    inspect: async id => [...this.cloud.values()].find(c => c.file.id === id)?.file ?? this.tombstones.get(id) ?? null,
    read: async f => {
      this.events.push('download:' + f.name); this.onDownload?.();
      if (this.failRead) throw new Error('network down');
      const entry = [...this.cloud.values()].find(c => c.file.id === f.id);
      if (!entry || entry.file.etag !== f.etag) throw new ChangedError('remote changed'); return entry.data;
    },
    write: async (p, b, expected) => {
      this.events.push('upload:' + p);
      const now = this.cloud.get(p);
      if (expected ? now?.file.etag !== expected.etag : !!now) throw new ChangedError('remote changed');
      const file = { ...rf(b.toString(), expected?.id ?? 'new-' + p), name: p.split('/').at(-1)! };
      this.cloud.set(p, { file, data: b }); return file;
    },
    trash: async f => {
      const entry = [...this.cloud].find(([, c]) => c.file.id === f.id);
      if (!entry || entry[1].file.etag !== f.etag) throw new ChangedError('remote changed');
      this.events.push('remote-trash:' + entry[0]); this.cloud.delete(entry[0]);
      this.tombstones.set(f.id, { ...f, trashed: true });
    },
    recoverPending: async () => { this.events.push('recover'); }
  };
  both(p: string, local: string, cloud: string, base?: string): void {
    this.data.set(p, bytes(local)); this.cloud.set(p, { data: bytes(cloud), file: { ...rf(cloud, 'id-' + p), name: p } });
    if (base !== undefined) this.state.entries[p] = { id: 'id-' + p, hash: md5(bytes(base)) };
  }
  engine(deletes = false, progress?: ProgressObserver): SyncEngine {
    return new SyncEngine(this.local, this.remote, this.state, { deletes, configDir: '.obsidian', exclude: [], check: () => { if (this.cancelled) throw new Error('cancelled'); }, save: async () => { this.events.push('checkpoint'); }, log: () => {}, progress });
  }
}

test('progress follows the real pipeline and counts only checkpointed file transfers',async()=>{
  const f=new Fixture(),progress:SyncProgress[]=[],confirmedAfter:(string|undefined)[]=[];f.both('pull.md','base','remote','base');f.both('push.md','local','base','base');
  await f.engine(false,p=>{progress.push(p);if((p.phase==='download'||p.phase==='upload')&&p.completed>0)confirmedAfter.push(f.events.at(-1));}).run();
  assert.deepEqual(confirmedAfter,['checkpoint','checkpoint']);
  const phases=progress.map(p=>p.phase);assert.ok(phases.indexOf('scan-drive')<phases.indexOf('scan-local'));assert.ok(phases.indexOf('download')<phases.indexOf('upload'));assert.equal(phases.at(-1),'finalize');
  assert.deepEqual(progress.filter(p=>p.phase==='download').map(p=>[p.completed,p.total,p.path]),[[0,1,'pull.md'],[1,1,'pull.md']]);
  assert.deepEqual(progress.filter(p=>p.phase==='upload').map(p=>[p.completed,p.total,p.path]),[[0,1,'push.md'],[1,1,'push.md']]);
});

test('conflict copies are included in the actual upload-phase denominator',async()=>{
  const f=new Fixture(),progress:SyncProgress[]=[];f.both('note.md','mine','theirs','base');f.data.set('new.md',bytes('new'));
  await f.engine(false,p=>progress.push(p)).run();const uploads=progress.filter(p=>p.phase==='upload');
  assert.equal(uploads[0]?.total,2);assert.equal(uploads.at(-1)?.completed,2);assert.ok(uploads.some(p=>p.path?.includes('conflict lokaal')));
});

test('preview progress never claims files were transferred or a sync was finalized',async()=>{
  const f=new Fixture(),progress:SyncProgress[]=[];f.both('note.md','mine','theirs');await f.engine(false,p=>progress.push(p)).run(true);
  assert.equal(progress.at(-1)?.phase,'compare');assert.equal(progress.some(p=>['upload','download','finalize'].includes(p.phase)),false);assert.equal(f.data.get('note.md')?.toString(),'mine');
});

test('failed downloads do not advance progress or enter the upload phase',async()=>{
  const f=new Fixture(),progress:SyncProgress[]=[];f.both('note.md','base','theirs','base');f.failRead=true;
  await assert.rejects(f.engine(false,p=>progress.push(p)).run(),/network down/);assert.equal(progress.at(-1)?.phase,'download');assert.equal(progress.at(-1)?.completed,0);assert.equal(progress.some(p=>p.phase==='upload'),false);
});

test('progress observer errors cannot interrupt the sync or change its result',async()=>{
  const f=new Fixture();f.both('note.md','mine','base','base');const report=await f.engine(false,()=>{throw new Error('broken UI');}).run();assert.equal(report.pushed,1);assert.equal(f.cloud.get('note.md')?.data.toString(),'mine');
});

const matrix: [string | null, string | null, string | null, boolean, string][] = [
  ['a','a',null,false,'adopt'], ['a','b',null,false,'conflict'],
  ['a','a','a',true,'adopt'], ['a','b','a',true,'pull'], ['b','a','a',true,'push'], ['b','c','a',true,'conflict'], ['b','b','a',true,'adopt'],
  ['a',null,null,true,'push'], [null,'a',null,true,'pull'], [null,null,null,true,'forget'],
  ['a',null,'a',true,'delete-local'], ['a',null,'a',false,'push'], ['b',null,'a',true,'push'],
  [null,'a','a',true,'delete-remote'], [null,'a','a',false,'pull'], [null,'b','a',true,'pull'], [null,null,'a',true,'forget']
];
for (const [l,r,b,deletes,expected] of matrix) test(`three-way ${JSON.stringify([l,r,b,deletes])} -> ${expected}`, () => {
  const plan = planSync(l === null ? new Map() : new Map([['note.md',lf(l)]]), r === null ? new Map() : new Map([['note.md',rf(r)]]), b === null ? {} : { 'note.md': { id: 'id', hash: lf(b).hash } }, deletes);
  if (l === null && r === null && b === null) assert.equal(plan.actions.length, 0);
  else assert.equal(plan.actions[0]?.kind, expected);
});
test('all downloads complete before content uploads', async () => {
  const f = new Fixture(); f.both('z.md','base','remote','base'); f.both('a.md','local','base','base');
  await f.engine().run();
  const firstUpload = f.events.findIndex(e => e.startsWith('upload:'));
  assert.ok(f.events.indexOf('local-write:z.md') < firstUpload);
  assert.equal(f.data.get('z.md')?.toString(), 'remote'); assert.equal(f.cloud.get('a.md')?.data.toString(), 'local');
});
test('first sync conflict preserves both versions locally and on Drive', async () => {
  const f = new Fixture(); f.both('note.md','local','remote');
  const result = await f.engine().run(); const copy = conflictName('note.md',lf('local').hash);
  assert.equal(result.conflicts,1); assert.equal(f.data.get('note.md')?.toString(),'remote');
  assert.equal(f.data.get(copy)?.toString(),'local'); assert.equal(f.cloud.get(copy)?.data.toString(),'local');
  assert.ok(f.backups.some(b => b.toString() === 'local'));
});
test('identical existing conflict copy is reused', async () => {
  const f = new Fixture(); f.both('note.md','local','remote');
  f.data.set(conflictName('note.md',lf('local').hash), bytes('local'));
  await f.engine().run(); assert.equal(f.data.size,2);
});
test('different existing conflict copy blocks overwrite', async () => {
  const f = new Fixture(); f.both('note.md','local','remote');
  f.data.set(conflictName('note.md',lf('local').hash),bytes('other'));
  await assert.rejects(f.engine().run(), /conflictkopie/u); assert.equal(f.data.get('note.md')?.toString(),'local');
});
test('failed pull prevents every upload', async () => {
  const f = new Fixture(); f.both('a.md','local','base','base'); f.both('b.md','base','remote','base'); f.failRead = true;
  await assert.rejects(f.engine().run(),/network/u); assert.ok(!f.events.some(e => e.startsWith('upload:')));
});
test('editing during a download cannot be overwritten', async () => {
  const f = new Fixture(); f.both('note.md','base','remote','base'); f.onDownload = () => f.data.set('note.md',bytes('typed meanwhile'));
  await assert.rejects(f.engine().run(),ChangedError); assert.equal(f.data.get('note.md')?.toString(),'typed meanwhile');
});
test('missing permissions are not inferred as remote deletions', async () => {
  const f = new Fixture(); f.data.set('note.md',bytes('base')); f.state.entries['note.md']={id:'lost',hash:lf('base').hash};
  await assert.rejects(f.engine(true).run(),/zonder bevestigde/u); assert.equal(f.data.size,1);
});
test('confirmed remote trash propagates only when enabled', async () => {
  const f = new Fixture(); f.data.set('note.md',bytes('base')); f.state.entries['note.md']={id:'deleted',hash:lf('base').hash};
  f.tombstones.set('deleted',{...rf('base','deleted'),trashed:true});
  await f.engine(true).run(); assert.equal(f.data.size,0); assert.equal(f.backups[0]?.toString(),'base');
});
test('remote deletion plus local edit restores local work to Drive', async () => {
  const f = new Fixture(); f.data.set('note.md',bytes('new work')); f.state.entries['note.md']={id:'deleted',hash:lf('base').hash};
  f.tombstones.set('deleted',{...rf('base','deleted'),trashed:true});
  await f.engine(true).run(); assert.equal(f.cloud.get('note.md')?.data.toString(),'new work');
});
test('local deletion plus remote edit restores remote work', async () => {
  const f = new Fixture(); f.both('note.md','base','new remote','base'); f.data.delete('note.md');
  await f.engine(true).run(); assert.equal(f.data.get('note.md')?.toString(),'new remote');
});
test('local deletion trashes remote only with a matching baseline and backup', async () => {
  const f = new Fixture(); f.both('note.md','base','base','base'); f.data.delete('note.md');
  await f.engine(true).run(); assert.equal(f.cloud.size,0); assert.ok(f.backups.length);
});
test('dry run does not change content or baseline', async () => {
  const f = new Fixture(); f.both('note.md','local','remote'); const before=JSON.stringify(f.state);
  const r=await f.engine().run(true); assert.equal(r.plan.conflicts,1); assert.equal(JSON.stringify(f.state),before);
  assert.equal(f.data.get('note.md')?.toString(),'local'); assert.ok(!f.events.some(e => e.startsWith('local-write:')));
});
test('completed operations checkpoint even when a later pull fails', async () => {
  const f = new Fixture(); f.both('a.md','base','new-a','base'); f.both('b.md','base','new-b','base');
  const original=f.remote.read; f.remote.read=async r => { if(r.name==='b.md') throw new Error('failure'); return original(r); };
  await assert.rejects(f.engine().run()); assert.equal(f.state.entries['a.md']?.hash,lf('new-a').hash);
  assert.equal(f.state.entries['b.md']?.hash,lf('base').hash);
});
test('cancellation prevents side effects', async () => {
  const f = new Fixture(); f.both('note.md','local','base','base'); f.cancelled=true;
  await assert.rejects(f.engine().run(),/cancelled/u); assert.equal(f.cloud.get('note.md')?.data.toString(),'base');
});
test('deletion fuse blocks bulk deletion before any mutation', async () => {
  const f=new Fixture(); for(let i=0;i<11;i++){const p=`${i}.md`;f.both(p,'a','a','a');f.data.delete(p);}
  await assert.rejects(f.engine(true).run(),/Massaverwijdering/u); assert.equal(f.cloud.size,11);
});
test('a dry run can inspect a bulk deletion without applying it', async () => {
  const f=new Fixture();for(let i=0;i<11;i++){const p=`${i}.md`;f.both(p,'a','a','a');f.data.delete(p);}
  const report=await f.engine(true).run(true);assert.equal(report.plan.deletions,11);assert.equal(f.cloud.size,11);
});
test('unchanged files share a bounded number of state checkpoints',async()=>{
  const f=new Fixture();for(let i=0;i<100;i++)f.both(`${i}.md`,'a','a','a');await f.engine().run();
  assert.equal(f.events.filter(e=>e==='checkpoint').length,2);
});
test('deletion ratio fuse catches >20% of an established vault',()=>{
  const actions=Array.from({length:3},(_,i)=>({path:String(i),kind:'delete-local' as const}));
  assert.throws(()=>assertDeletionBudget({actions,deletions:3,conflicts:0},10));
});
test('safety exclusions apply to custom config folders and hidden components',()=>{
  assert.equal(included('config/plugins/x','config',[]),false); assert.equal(included('a/.git/x','.obsidian',[]),false);
  assert.equal(included('large/movie.mp4','.obsidian',['large']),false); assert.equal(included('larger/a','.obsidian',['large']),true);
});
for(const p of ['../a','/abs','a//b','a\\b','CON.txt','a:stream','a.','a ','a/.obsidian/x','a/..','__proto__']) test(`reject unsafe path ${p}`,()=>assert.throws(()=>safePath(p)));
test('case, Unicode and file/folder collisions are blocked',()=>{
  assert.throws(()=>validateNamespace(['A.md','a.md'])); assert.throws(()=>validateNamespace(['é.md','e\u0301.md']));
  assert.throws(()=>validateNamespace(['a','a/b.md'])); assert.throws(()=>validateNamespace(['a'],['a']));
  assert.throws(()=>validateNamespace(['A/x.md','a/y.md']));
});
test('normal namespace and empty files are supported',async()=>{
  validateNamespace(['notes/a.md','images/pic.png'],['notes','images']);
  const f=new Fixture();f.both('note.md','','new','');await f.engine().run();assert.equal(f.data.get('note.md')?.toString(),'new');
});
