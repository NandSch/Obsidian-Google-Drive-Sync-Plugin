import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { DRIVE_SCOPE, GoogleAuth, Secrets, challenge, stateMatches } from '../src/auth';
import { Transport } from '../src/http';

class MemorySecrets implements Secrets {
  values=new Map<string,string>();getSecret(id:string):string|null{return this.values.get(id)??null;}setSecret(id:string,v:string):void{this.values.set(id,v);}
}
const response=(status:number,value:unknown)=>({status,headers:{},body:Buffer.from(JSON.stringify(value))});
const client='123-test.apps.googleusercontent.com';
async function get(url:string):Promise<number>{return new Promise((resolve,reject)=>{http.get(url,res=>{res.resume();res.on('end',()=>resolve(res.statusCode??0));}).on('error',reject);});}
test('PKCE matches RFC7636 S256 vector and state comparison is strict',()=>{
  assert.equal(challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(stateMatches('abc','abc'),true);assert.equal(stateMatches('abc','abcd'),false);assert.equal(stateMatches('abc',null),false);
});
test('login uses system browser, loopback, state, PKCE and SecretStorage',async()=>{
  const secrets=new MemorySecrets();let verifier='';let authUrl:URL|undefined;
  const transport:Transport=async r=>{
    assert.equal(r.url,'https://oauth2.googleapis.com/token');
    const form=new URLSearchParams(r.body?.toString());verifier=form.get('code_verifier')??'';
    assert.equal(form.get('client_secret'),'secret');assert.equal(form.get('code'),'returned-code');
    return response(200,{access_token:'access',refresh_token:'refresh',expires_in:3600,scope:DRIVE_SCOPE});
  };
  const auth=new GoogleAuth(client,'test-secret',secrets,transport);auth.setClientSecret('secret');
  await auth.login(async url=>{
    authUrl=new URL(url);assert.equal(authUrl.hostname,'accounts.google.com');
    const redirect=new URL(authUrl.searchParams.get('redirect_uri')!);assert.equal(redirect.hostname,'127.0.0.1');
    assert.equal(authUrl.searchParams.get('scope'),DRIVE_SCOPE);
    const bad=new URL(redirect);bad.search=new URLSearchParams({code:'evil',state:'wrong'}).toString();assert.equal(await get(bad.toString()),400);
    const good=new URL(redirect);good.search=new URLSearchParams({code:'returned-code',state:authUrl.searchParams.get('state')!}).toString();assert.equal(await get(good.toString()),200);
  });
  assert.equal(authUrl?.searchParams.get('code_challenge'),challenge(verifier));assert.equal(await auth.token(),'access');
  assert.equal(auth.connected(),true);assert.equal(auth.stored().refreshToken,'refresh');
  const port=new URL(authUrl!.searchParams.get('redirect_uri')!);await assert.rejects(get(port.toString()));
});
test('refresh requests are serialized and refresh-token rotation persists',async()=>{
  const secrets=new MemorySecrets();secrets.setSecret('tokens',JSON.stringify({clientSecret:'s',refreshToken:'old'}));let calls=0;
  const auth=new GoogleAuth(client,'tokens',secrets,async r=>{
    calls++;const form=new URLSearchParams(r.body?.toString());assert.equal(form.get('grant_type'),'refresh_token');assert.equal(form.get('refresh_token'),'old');
    await Promise.resolve();return response(200,{access_token:'new',refresh_token:'rotated',expires_in:3600});
  });
  assert.deepEqual(await Promise.all([auth.token(),auth.token(),auth.token()]),['new','new','new']);assert.equal(calls,1);assert.equal(auth.stored().refreshToken,'rotated');
});
test('expired grant gives actionable error without exposing token',async()=>{
  const secrets=new MemorySecrets();secrets.setSecret('tokens',JSON.stringify({clientSecret:'s',refreshToken:'private-refresh'}));
  const auth=new GoogleAuth(client,'tokens',secrets,async()=>response(400,{error:'invalid_grant',error_description:'private-refresh'}));
  await assert.rejects(auth.token(),error=>error instanceof Error && /opnieuw aan/u.test(error.message) && !error.message.includes('private-refresh'));
});
test('disconnect clears refresh token while retaining client configuration',()=>{
  const secrets=new MemorySecrets();secrets.setSecret('tokens',JSON.stringify({clientSecret:'s',refreshToken:'r'}));const auth=new GoogleAuth(client,'tokens',secrets);
  auth.disconnect();assert.equal(auth.connected(),false);assert.equal(auth.stored().clientSecret,'s');
});
test('cancelled browser login closes listener and rejects',async()=>{
  const auth=new GoogleAuth(client,'tokens',new MemorySecrets());
  await assert.rejects(auth.login(async()=>{auth.cancel();}),/gestopt/u);
});
test('invalid credentials and missing scopes fail safely',async()=>{
  const secrets=new MemorySecrets();const auth=new GoogleAuth('invalid','tokens',secrets);await assert.rejects(auth.login(async()=>{}),/client-ID/u);
  secrets.setSecret('tokens',JSON.stringify({clientSecret:'s',refreshToken:'r'}));const scoped=new GoogleAuth(client,'tokens',secrets,async()=>response(200,{access_token:'a',scope:'openid'}));
  await assert.rejects(scoped.token(),/niet verleend/u);
});
test('corrupted secret storage can be cleared through disconnect',()=>{
  const secrets=new MemorySecrets();secrets.setSecret('tokens','bad json');const auth=new GoogleAuth(client,'tokens',secrets);
  assert.throws(()=>auth.connected(),/ongeldig/u);auth.disconnect();assert.equal(auth.connected(),false);auth.setClientSecret('repaired');assert.equal(auth.stored().clientSecret,'repaired');
});
