import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { App } from 'obsidian';
import { FileSystemAdapter, MarkdownView, TextFileView, TFile, TFolder } from './obsidian-mock';
import { ObsidianLocal, saveOpenEditors } from '../src/local';
import { ChangedError, md5 } from '../src/model';
import { ScanProgress } from '../src/progress';

class Vault {
  entries=new Map<string,TFile|TFolder>();root:string;adapter:FileSystemAdapter;configDir='.obsidian';
  rootFolder=new TFolder('/');
  leaves:{view:MarkdownView}[]=[];processed=0;modifiedBinary=0;
  constructor(t:TestContext){this.root=fs.mkdtempSync(path.resolve('.test-build','local-'));this.adapter=new FileSystemAdapter(this.root);t.after(()=>fs.rmSync(this.root,{recursive:true,force:true}));}
  absolute(p:string):string{return path.join(this.root,...p.split('/'));}
  add(p:string,bytes:Buffer):void{fs.mkdirSync(path.dirname(this.absolute(p)),{recursive:true});fs.writeFileSync(this.absolute(p),bytes);this.entries.set(p,new TFile(p,{size:bytes.length}));}
  local():ObsidianLocal{
    const vault=this;
    const adapter=Object.assign(this.adapter,{readBinary:async(p:string)=>{const b=fs.readFileSync(vault.absolute(p));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);},exists:async(p:string)=>fs.existsSync(vault.absolute(p))});
    const app={vault:{adapter,configDir:this.configDir,
      getRoot:()=>vault.rootFolder,getAllLoadedFiles:()=>[vault.rootFolder,...vault.entries.values()],getAbstractFileByPath:(p:string)=>vault.entries.get(p)??null,
      createFolder:async(p:string)=>{fs.mkdirSync(vault.absolute(p));vault.entries.set(p,new TFolder(p));},
      createBinary:async(p:string,bytes:ArrayBuffer)=>{if(fs.existsSync(vault.absolute(p)))throw new Error('exists');vault.add(p,Buffer.from(bytes));},
      modifyBinary:async(f:TFile,bytes:ArrayBuffer)=>{vault.modifiedBinary++;vault.add(f.path,Buffer.from(bytes));},
      process:async(f:TFile,callback:(current:string)=>string)=>{vault.processed++;vault.add(f.path,Buffer.from(callback(fs.readFileSync(vault.absolute(f.path),'utf8'))));},
      trash:async(f:TFile,system:boolean)=>{assert.equal(system,false,'always use vault trash, regardless of the permanent-delete preference');const dst=vault.absolute('.trash/'+f.path);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.renameSync(vault.absolute(f.path),dst);vault.entries.delete(f.path);}
    },workspace:{getLeavesOfType:()=>vault.leaves}};
    return new ObsidianLocal(app as unknown as App,[]);
  }
  backups():string[]{const dir=this.absolute('.drive-vault-sync/recovery');return fs.existsSync(dir)?fs.readdirSync(dir,{recursive:true}).filter(p=>typeof p==='string'&&p.endsWith('.bak')).map(p=>path.join(dir,p as string)):[];}
}
test('local scan includes binary and text while excluding hidden/configuration files',async t=>{
  const v=new Vault(t);v.add('note.md',Buffer.from('a'));v.add('pic.bin',Buffer.from([0,255,128]));v.add('.obsidian/private.json',Buffer.from('secret'));v.add('.git/config',Buffer.from('git'));
  const result=await v.local().scan();assert.deepEqual([...result.files.keys()].sort(),['note.md','pic.bin']);
});

test('local scan progress counts only included files and confirms each hash read',async t=>{
  const v=new Vault(t),progress:ScanProgress[]=[];v.add('a.md',Buffer.from('a'));v.add('b.md',Buffer.from('b'));v.add('.obsidian/data.json',Buffer.from('secret'));
  await v.local().scan(p=>progress.push(p));assert.equal(progress[0]?.total,2);assert.equal(progress.at(-1)?.completed,2);assert.equal(progress.some(p=>p.path?.startsWith('.')),false);
});

test('Obsidian root slash is metadata, not a relative folder to validate or upload',async t=>{
  const v=new Vault(t);v.entries.set('Notes',new TFolder('Notes'));v.add('Notes/note.md',Buffer.from('a'));
  const snapshot=await v.local().scan();assert.deepEqual([...snapshot.folders],['Notes']);assert.deepEqual([...snapshot.files.keys()],['Notes/note.md']);
});

test('an empty vault with only the Obsidian root is a valid empty inventory',async t=>{
  const v=new Vault(t);for(const rootPath of ['/','']){v.rootFolder.path=rootPath;const snapshot=await v.local().scan();assert.equal(snapshot.files.size,0);assert.equal(snapshot.folders.size,0);}
});

test('skipping the actual Obsidian root never permits another unsafe folder path',async t=>{
  const v=new Vault(t);v.entries.set('rogue',new TFolder('/'));await assert.rejects(v.local().scan(),/Onveilige/);
  v.entries.set('rogue',new TFolder('/outside'));await assert.rejects(v.local().scan(),/Onveilige/);
});
test('local text update uses atomic Vault.process and durable preimage backup',async t=>{
  const v=new Vault(t);v.add('note.md',Buffer.from('old'));await v.local().write('note.md',Buffer.from('new'),md5(Buffer.from('old')));
  assert.equal(v.processed,1);assert.equal(fs.readFileSync(v.absolute('note.md'),'utf8'),'new');assert.equal(fs.readFileSync(v.backups()[0]!).toString(),'old');
});
test('binary update preserves exact bytes and creates backup',async t=>{
  const v=new Vault(t),old=Buffer.from([0,255,128]),next=Buffer.from([1,254,129]);v.add('image.bin',old);await v.local().write('image.bin',next,md5(old));
  assert.equal(v.modifiedBinary,1);assert.deepEqual(fs.readFileSync(v.absolute('image.bin')),next);assert.deepEqual(fs.readFileSync(v.backups()[0]!),old);
});
test('local create makes parents and refuses an existing file',async t=>{
  const v=new Vault(t),local=v.local();await local.write('Notes/Sub/a.md',Buffer.from('a'),null);
  assert.equal(fs.readFileSync(v.absolute('Notes/Sub/a.md'),'utf8'),'a');await assert.rejects(local.write('Notes/Sub/a.md',Buffer.from('b'),null),ChangedError);
});
test('unsaved editor contents prevent an overwrite and a deletion',async t=>{
  const v=new Vault(t);v.add('note.md',Buffer.from('old'));v.leaves=[{view:new MarkdownView(v.entries.get('note.md') as TFile,{getValue:()=>'unsaved edit'})}];const local=v.local();
  await assert.rejects(local.write('note.md',Buffer.from('new'),md5(Buffer.from('old'))),/editorwijziging/u);await assert.rejects(local.remove('note.md',md5(Buffer.from('old'))),/editorwijziging/u);
  assert.equal(fs.readFileSync(v.absolute('note.md'),'utf8'),'old');
});
test('Windows line-ending normalization does not look like an unsaved edit',async t=>{
  const v=new Vault(t),old=Buffer.from('line1\r\nline2\r\n');v.add('note.md',old);v.leaves=[{view:new MarkdownView(v.entries.get('note.md') as TFile,{getValue:()=>'line1\nline2\n'})}];
  await v.local().write('note.md',Buffer.from('new'),md5(old));assert.equal(fs.readFileSync(v.absolute('note.md'),'utf8'),'new');
});
test('disk edits after planning fail the precondition',async t=>{
  const v=new Vault(t);v.add('note.md',Buffer.from('changed'));await assert.rejects(v.local().write('note.md',Buffer.from('new'),md5(Buffer.from('old'))),ChangedError);
  assert.equal(fs.readFileSync(v.absolute('note.md'),'utf8'),'changed');
});
test('local removal uses trash plus a separate recovery copy',async t=>{
  const v=new Vault(t),old=Buffer.from('old');v.add('note.md',old);await v.local().remove('note.md',md5(old));
  assert.equal(fs.existsSync(v.absolute('note.md')),false);assert.equal(fs.readFileSync(v.absolute('.trash/note.md'),'utf8'),'old');assert.equal(fs.readFileSync(v.backups()[0]!).toString(),'old');
});
test('junctions cannot redirect downloads outside the intended folder',async t=>{
  const v=new Vault(t);fs.mkdirSync(v.absolute('target'));fs.symlinkSync(v.absolute('target'),v.absolute('linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(v.local().write('linked/note.md',Buffer.from('a'),null),/Symbolische/u);assert.equal(fs.existsSync(v.absolute('target/note.md')),false);
});

test('closing flushes pending editor bytes before the final local scan',async t=>{
  const v=new Vault(t);v.add('note.md',Buffer.from('old'));
  const view=new TextFileView(v.entries.get('note.md') as TFile);let saved=0;
  view.save=async()=>{saved++;v.add('note.md',Buffer.from('last keystroke'));};
  const app={workspace:{iterateAllLeaves:(fn:(leaf:{view:unknown})=>void)=>[{view},{view},{view:{}}].forEach(fn)}} as unknown as App;
  await saveOpenEditors(app,new AbortController().signal);
  assert.equal(saved,1);assert.equal((await v.local().scan()).files.get('note.md')!.hash,md5(Buffer.from('last keystroke')));
});

test('a failed editor save prevents the following sync and is not reported as success',async()=>{
  const view=new TextFileView(new TFile('note.md',{size:0}));view.save=async()=>{throw new Error('disk full');};
  const app={workspace:{iterateAllLeaves:(fn:(leaf:{view:unknown})=>void)=>fn({view})}} as unknown as App;
  await assert.rejects(saveOpenEditors(app,new AbortController().signal),/disk full/);
});

test('timeout while saving an editor prevents saving further views or starting a sync',async()=>{
  const a=new TextFileView(new TFile('a.md',{size:0})),b=new TextFileView(new TFile('b.md',{size:0})),abort=new AbortController();let second=false;
  a.save=async()=>{abort.abort();};b.save=async()=>{second=true;};
  const app={workspace:{iterateAllLeaves:(fn:(leaf:{view:unknown})=>void)=>[a,b].forEach(view=>fn({view}))}} as unknown as App;
  await assert.rejects(saveOpenEditors(app,abort.signal),/Opslaan gestopt/);assert.equal(second,false);
});
