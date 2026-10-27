import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveClient, DriveError, acknowledged, validateUploadURL } from '../src/drive';
import { HttpRequest, HttpResponse, Transport } from '../src/http';
import { ChangedError, FOLDER, RemoteFile, emptyState, md5 } from '../src/model';
import { ScanProgress } from '../src/progress';

interface MockFile {id:string;title:string;mimeType:string;etag:string;parents:{id:string}[];labels:{trashed:boolean};md5Checksum?:string;fileSize?:string;capabilities:{canEdit:boolean;canAddChildren:boolean;canListChildren:boolean};driveId?:string}
const response=(status:number,value:unknown):HttpResponse=>({status,headers:{},body:Buffer.from(JSON.stringify(value))});
const caps={canEdit:true,canAddChildren:true,canListChildren:true};
class Google {
  files=new Map<string,MockFile>();data=new Map<string,Buffer>();calls:HttpRequest[]=[];counter=0;
  lostCreate=false;failUpdates=false;incomplete=false;omitItems=false;pages=false;rateLimit=0;unauthorized=0;
  sessions=new Map<string,{metadata:{id?:string;title:string;parents?:{id:string}[]};id:string;bytes:Buffer;total:number;done?:MockFile}>();
  lostChunk=false;lostFinal=false;badUploadURL=false;staleOnFinal=false;
  constructor(){this.files.set('root-id',{id:'root-id',title:'Vault',mimeType:FOLDER,etag:'"root"',parents:[{id:'mydrive'}],labels:{trashed:false},capabilities:caps});}
  add(id:string,title:string,data:string,parent='root-id'):MockFile{
    const bytes=Buffer.from(data),f={id,title,mimeType:'application/octet-stream',etag:'"'+id+'"',parents:[{id:parent}],labels:{trashed:false},capabilities:caps,md5Checksum:md5(bytes),fileSize:String(bytes.length)};
    this.files.set(id,f);this.data.set(id,bytes);return f;
  }
  folder(id:string,title:string,parent='root-id'):void{this.files.set(id,{id,title,mimeType:FOLDER,etag:'"'+id+'"',parents:[{id:parent}],labels:{trashed:false},capabilities:caps});}
  remote(id:string):RemoteFile{const f=this.files.get(id)!;return{id,name:f.title,parent:f.parents[0]!.id,hash:f.md5Checksum??'',size:Number(f.fileSize??0),etag:f.etag,trashed:f.labels.trashed,mime:f.mimeType};}
  transport:Transport=async r=>{
    this.calls.push(r);const u=new URL(r.url),method=r.method??'GET';
    assert.equal(r.headers?.Authorization,'Bearer token');
    if(this.unauthorized-->0)return response(401,{error:{errors:[{reason:'authError'}]}});
    if(this.rateLimit-->0)return response(429,{error:{errors:[{reason:'rateLimitExceeded'}]}});
    if(u.pathname.endsWith('/generateIds'))return response(200,{ids:['generated-'+(++this.counter)]});
    if(u.pathname.endsWith('/about'))return response(200,{user:{permissionId:'account-id',emailAddress:'test@example.com'}});
    if(u.pathname==='/drive/v2/files'&&method==='GET'){
      const parent=u.searchParams.get('q')?.match(/^'([^']+)'/u)?.[1];
      const items=[...this.files.values()].filter(f=>f.parents.some(p=>p.id===parent)&&!f.labels.trashed);
      return response(200,{...(this.omitItems?{}:{items:this.pages?(u.searchParams.get('pageToken')?items.slice(1):items.slice(0,1)):items}),incompleteSearch:this.incomplete,...(this.pages&&!u.searchParams.get('pageToken')?{nextPageToken:'page2'}:{})});
    }
    const id=u.pathname.match(/\/files\/([^/]+)$/u)?.[1];
    if(method==='GET'&&id){
      const f=this.files.get(id);if(!f)return response(404,{error:{errors:[{reason:'notFound'}]}});
      if(u.searchParams.get('alt')==='media'){
        if(r.headers?.['If-Match']!==f.etag)return response(412,{});
        return{status:200,headers:{},body:this.data.get(id)!};
      }return response(200,f);
    }
    if(method==='PATCH'&&id){
      const f=this.files.get(id)!;assert.equal(r.headers?.['If-Match'],f.etag);f.labels.trashed=true;return response(200,f);
    }
    if(u.pathname.startsWith('/upload/')&&u.searchParams.has('upload_id')){
      const session=this.sessions.get(u.searchParams.get('upload_id')!)!;
      const range=r.headers?.['Content-Range']??'';
      if(range.startsWith('bytes */')){
        if(session.done)return response(200,session.done);
        return{status:308,headers:session.bytes.length?{range:`bytes=0-${session.bytes.length-1}`}:{},body:Buffer.alloc(0)};
      }
      const match=/^bytes (\d+)-(\d+)\/(\d+)$/u.exec(range)!;
      assert.ok(match);assert.equal(Number(match[1]),session.bytes.length);
      session.bytes=Buffer.concat([session.bytes,r.body!]);
      if(session.bytes.length===session.total){
        const f=this.add(session.id,session.metadata.title,session.bytes.toString(),session.metadata.parents?.[0]?.id??this.files.get(session.id)?.parents[0]?.id);
        session.done=f;
        if(this.lostFinal){this.lostFinal=false;throw new Error('lost final response');}
        return response(200,f);
      }
      if(this.staleOnFinal){const existing=this.files.get(session.id);if(existing)existing.etag='"edited-during-upload"';}
      if(this.lostChunk){this.lostChunk=false;throw new Error('lost chunk response');}
      return{status:308,headers:{range:`bytes=0-${session.bytes.length-1}`},body:Buffer.alloc(0)};
    }
    if(u.pathname.startsWith('/upload/')&&u.searchParams.get('uploadType')==='resumable'){
      const metadata=JSON.parse(r.body!.toString()) as {id?:string;title:string;parents?:{id:string}[]};
      const key='session-'+(++this.counter);
      this.sessions.set(key,{metadata,id:id??metadata.id!,bytes:Buffer.alloc(0),total:Number(r.headers?.['X-Upload-Content-Length'])});
      return{status:200,headers:{location:this.badUploadURL?'https://evil.example/upload?upload_id=x':`https://www.googleapis.com/upload/drive/v2/files?upload_id=${key}`},body:Buffer.alloc(0)};
    }
    if(u.pathname.startsWith('/upload/')&&(method==='POST'||method==='PUT')){
      if(method==='PUT'&&this.failUpdates)return response(412,{});
      const contentType=r.headers?.['Content-Type']??'',boundary=contentType.split('boundary=')[1]!;
      const payload=r.body!,first=payload.indexOf('\r\n\r\n')+4,metadataEnd=payload.indexOf('\r\n--'+boundary,first);
      const metadata=JSON.parse(payload.subarray(first,metadataEnd).toString()) as {id?:string;title:string;parents?:{id:string}[]};
      const dataStart=payload.indexOf('\r\n\r\n',metadataEnd)+4,dataEnd=payload.length-Buffer.byteLength(`\r\n--${boundary}--\r\n`),bytes=payload.subarray(dataStart,dataEnd);
      const target=id??metadata.id!,old=this.files.get(target);
      if(method==='PUT')assert.equal(r.headers?.['If-Match'],old?.etag);
      const f=this.add(target,metadata.title,bytes.toString(),metadata.parents?.[0]?.id??old?.parents[0]?.id);
      f.etag='"updated-'+(++this.counter)+'"';
      if(this.lostCreate&&method==='POST'){this.lostCreate=false;throw new Error('connection reset after commit');}
      return response(200,f);
    }
    if(method==='POST'&&u.pathname==='/drive/v2/files'){
      const m=JSON.parse(r.body!.toString()) as MockFile;
      this.folder(m.id,m.title,m.parents[0]!.id);return response(200,this.files.get(m.id));
    }
    throw new Error('unhandled request: '+method+' '+u.pathname);
  };
  client(){
    const state=emptyState('root-id'),saves:string[]=[],waits:number[]=[];let invalidates=0;
    const client=new DriveClient({token:async()=>'token',invalidate:()=>{invalidates++;}},state,async()=>{saves.push(JSON.stringify(state));},'.obsidian',[],undefined,this.transport,async ms=>{waits.push(ms);});
    return{client,state,saves,waits,invalidates:()=>invalidates};
  }
}
test('recursive Drive scan handles pagination, binary metadata and exclusions',async()=>{
  const g=new Google();g.pages=true;g.folder('sub','Notes');g.add('a','a.md','a','sub');g.add('b','b.md','b');g.folder('hidden','.obsidian');g.add('secret','data.json','secret','hidden');
  const{client}=g.client(),snapshot=await client.scan('root-id');assert.deepEqual([...snapshot.files.keys()].sort(),['Notes/a.md','b.md']);
});

test('Drive scan reports each page while the total inventory size is still unknown',async()=>{
  const g=new Google(),progress:ScanProgress[]=[];g.pages=true;g.add('a','a.md','a');g.add('b','b.md','b');await g.client().client.scan('root-id',p=>progress.push(p));
  assert.ok(progress.some(p=>p.completed===1));assert.equal(progress.at(-1)?.completed,2);assert.equal(progress.at(-1)?.folders,1);assert.equal(progress.every(p=>p.total===undefined),true);
});
test('duplicate Drive names block sync instead of choosing one',async()=>{
  const g=new Google();g.add('a','note.md','a');g.add('b','NOTE.md','b');await assert.rejects(g.client().client.scan('root-id'),/Dubbele/u);
});
test('native Google Docs, shortcuts and unsafe filenames are rejected',async()=>{
  for(const mime of ['application/vnd.google-apps.document','application/vnd.google-apps.shortcut']){
    const g=new Google();const f=g.add('a','note','a');f.mimeType=mime;delete f.md5Checksum;await assert.rejects(g.client().client.scan('root-id'),/Geen normaal/u);
  }
  const g=new Google();g.add('a','outside/name.md','a');await assert.rejects(g.client().client.scan('root-id'),/Windows/u);
});
test('incomplete listings block deletions and uploads',async()=>{
  const g=new Google();g.incomplete=true;await assert.rejects(g.client().client.scan('root-id'),/onvolledige/u);
  g.incomplete=false;g.omitItems=true;await assert.rejects(g.client().client.scan('root-id'),/onvolledige/u);
});
test('missing, trashed and Shared Drive roots fail closed',async()=>{
  const g=new Google();g.files.get('root-id')!.labels.trashed=true;await assert.rejects(g.client().client.scan('root-id'),/gekoppelde/u);
  g.files.get('root-id')!.labels.trashed=false;g.files.get('root-id')!.driveId='shared';await assert.rejects(g.client().client.scan('root-id'),/Shared/u);
});
test('download verifies ETag, checksum and size',async()=>{
  const g=new Google();g.add('a','note.md','content');const{client}=g.client();assert.equal((await client.read(g.remote('a'))).toString(),'content');
  const stale={...g.remote('a'),etag:'"stale"'};await assert.rejects(client.read(stale),ChangedError);
  g.data.set('a',Buffer.from('corrupt'));await assert.rejects(client.read(g.remote('a')),/Downloadcontrole/u);
});
test('create journals a generated ID before POST and confirms content',async()=>{
  const g=new Google(),{client,state,saves}=g.client();await client.scan('root-id');const f=await client.write('note.md',Buffer.from('new'));
  assert.ok(saves.some(s=>s.includes('generated-1')&&s.includes('pending')));assert.equal(f.hash,md5(Buffer.from('new')));assert.equal(Object.keys(state.pending).length,0);assert.equal(state.entries['note.md']?.id,f.id);
});
test('lost successful create response is reconciled without another POST',async()=>{
  const g=new Google();g.lostCreate=true;const{client}=g.client();await client.scan('root-id');await client.write('note.md',Buffer.from('new'));
  assert.equal(g.calls.filter(r=>new URL(r.url).pathname==='/upload/drive/v2/files').length,1);assert.equal([...g.files.values()].filter(f=>f.title==='note.md').length,1);
});
test('interrupted create with unexpected content does not assume a successful baseline',async()=>{
  const g=new Google();g.add('reserved','note.md','newer remote');const{client,state}=g.client();
  state.pending['note.md']={id:'reserved',name:'note.md',parent:'root-id',hash:md5(Buffer.from('uploaded')),folder:false};
  await client.recoverPending();assert.equal(state.entries['note.md'],undefined);assert.equal(Object.keys(state.pending).length,0);
});
test('interrupted create with verified matching content restores the baseline',async()=>{
  const g=new Google();g.add('reserved','note.md','uploaded');const{client,state}=g.client();
  state.pending['note.md']={id:'reserved',name:'note.md',parent:'root-id',hash:md5(Buffer.from('uploaded')),folder:false};
  await client.recoverPending();assert.equal(state.entries['note.md']?.hash,md5(Buffer.from('uploaded')));
});
test('pending nonexistent create reuses its reserved ID',async()=>{
  const g=new Google(),{client,state}=g.client();state.pending['note.md']={id:'reserved',name:'note.md',parent:'root-id',hash:md5(Buffer.from('new')),folder:false};
  await client.recoverPending();await client.scan('root-id');const f=await client.write('note.md',Buffer.from('new'));assert.equal(f.id,'reserved');assert.equal(g.calls.some(r=>r.url.includes('generateIds')),false);
});
test('update uses an ETag and does not blindly retry HTTP 412',async()=>{
  const g=new Google();g.add('a','note.md','old');g.failUpdates=true;const{client}=g.client();await client.scan('root-id');
  await assert.rejects(client.write('note.md',Buffer.from('new'),g.remote('a')),ChangedError);
  assert.equal(g.calls.filter(r=>r.method==='PUT').length,1);assert.equal(g.data.get('a')?.toString(),'old');
});
test('new remote file discovered after scan blocks a conflicting create',async()=>{
  const g=new Google(),{client}=g.client();await client.scan('root-id');g.add('other','note.md','other-device');
  await assert.rejects(client.write('note.md',Buffer.from('local')),ChangedError);assert.equal(g.calls.some(r=>r.method==='POST'),false);
});
test('remote file move outside root blocks mutation',async()=>{
  const g=new Google();g.folder('folder','Notes');g.add('a','note.md','old','folder');const{client}=g.client();await client.scan('root-id');
  g.files.get('folder')!.parents=[{id:'elsewhere'}];await assert.rejects(client.write('Notes/note.md',Buffer.from('new'),g.remote('a')),/verplaatst/u);
});
test('new folders use journaled generated IDs',async()=>{
  const g=new Google(),{client,state}=g.client();await client.scan('root-id');await client.write('New/note.md',Buffer.from('a'));
  const folder=[...g.files.values()].find(f=>f.title==='New')!;assert.equal(folder.mimeType,FOLDER);assert.ok(state.entries['New/note.md']);assert.equal(Object.keys(state.pending).length,0);
});
test('trash uses a conditional metadata update, never permanent delete',async()=>{
  const g=new Google();g.add('a','note.md','old');const{client}=g.client();await client.trash(g.remote('a'));
  assert.equal(g.files.get('a')?.labels.trashed,true);assert.equal(g.calls.some(r=>r.method==='DELETE'),false);
});
test('read rate limits back off and unauthorized requests refresh once',async()=>{
  const g=new Google();g.rateLimit=2;const c=g.client();await c.client.account();assert.equal(c.waits.length,2);
  g.unauthorized=1;await c.client.account();assert.equal(c.invalidates(),1);
});
test('permanent permission errors are not retried as network failures',async()=>{
  const g=new Google(),{client}=g.client();const original=g.transport;
  let calls=0;const forbidden=new DriveClient({token:async()=>'token',invalidate:()=>{}},emptyState('root-id'),async()=>{},'.obsidian',[],undefined,async()=>{calls++;return response(403,{error:{errors:[{reason:'insufficientFilePermissions'}]}});},async()=>{});
  await assert.rejects(forbidden.account(),DriveError);assert.equal(calls,1);
});
test('large upload sends bounded chunks and verifies final metadata',async()=>{
  const g=new Google(),{client}=g.client();await client.scan('root-id');const data=Buffer.alloc(9*1024*1024,65);
  const result=await client.write('large.bin',data);assert.equal(result.hash,md5(data));
  const chunks=g.calls.filter(r=>r.headers?.['Content-Range']?.startsWith('bytes ')&&!r.headers['Content-Range'].startsWith('bytes */'));
  assert.equal(chunks.length,2);assert.equal(chunks[0]?.body?.length,8*1024*1024);assert.equal(chunks[1]?.body?.length,1024*1024);
});
test('lost chunk response queries the acknowledged offset before resuming',async()=>{
  const g=new Google();g.lostChunk=true;const{client}=g.client();await client.scan('root-id');const data=Buffer.alloc(9*1024*1024,66);
  const result=await client.write('large.bin',data);assert.equal(result.hash,md5(data));
  assert.ok(g.calls.some(r=>r.headers?.['Content-Range']===`bytes */${data.length}`));
  const chunks=g.calls.filter(r=>r.body?.length===8*1024*1024);assert.equal(chunks.length,1);
});
test('lost final response retrieves committed result without duplicate upload',async()=>{
  const g=new Google();g.lostFinal=true;const{client}=g.client();await client.scan('root-id');const data=Buffer.alloc(6*1024*1024,67);
  assert.equal((await client.write('large.bin',data)).hash,md5(data));assert.equal(g.sessions.size,1);
});
test('remote edit during large upload blocks the final chunk',async()=>{
  const g=new Google();g.add('existing','large.bin','old');g.staleOnFinal=true;const{client}=g.client();await client.scan('root-id');
  await assert.rejects(client.write('large.bin',Buffer.alloc(9*1024*1024,68),g.remote('existing')),ChangedError);
  assert.equal(g.data.get('existing')?.toString(),'old');
});
test('upload location cannot redirect credentials to another host',async()=>{
  const g=new Google();g.badUploadURL=true;const{client}=g.client();await client.scan('root-id');
  await assert.rejects(client.write('large.bin',Buffer.alloc(6*1024*1024,69)),/uploadadres/u);
  for(const url of ['http://www.googleapis.com/upload/drive/v2/files?upload_id=a','https://www.googleapis.com.evil.test/upload/drive/v2/files?upload_id=a','https://www.googleapis.com/upload/drive/v2/files-evil?upload_id=a','https://www.googleapis.com/upload/drive/v2/files'])assert.throws(()=>validateUploadURL(url));
});
test('invalid acknowledged byte ranges cannot skip data',()=>{
  assert.equal(acknowledged({status:308,headers:{range:'bytes=0-255'},body:Buffer.alloc(0)},512),256);
  assert.throws(()=>acknowledged({status:308,headers:{range:'bytes=0-1000'},body:Buffer.alloc(0)},512));
  assert.throws(()=>acknowledged({status:308,headers:{range:'bytes=10-20'},body:Buffer.alloc(0)},512));
});
test('concurrent folder rename is detected before upload',async()=>{
  const g=new Google();g.folder('folder','Notes');const{client}=g.client();await client.scan('root-id');g.files.get('folder')!.title='Renamed';
  await assert.rejects(client.write('Notes/note.md',Buffer.from('new')),ChangedError);
});
