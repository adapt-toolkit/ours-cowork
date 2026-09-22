import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createManagementAuthorizer } from '../src/http-management.ts';

test('management credential validation pins instance, checks revocation, and refuses redirects without leaking tokens',async t=>{
  const expected='11111111-2222-3333-4444-555555555555';
  let instance=expected,revoked=false,redirect=false,leaked=0,authenticated=0;
  const sink=http.createServer((_req,res)=>{leaked++;res.end('{}');});
  await new Promise(r=>sink.listen(0,'127.0.0.1',r));t.after(()=>{sink.closeAllConnections();sink.close();});
  const server=http.createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(redirect){res.statusCode=302;res.setHeader('location',`http://127.0.0.1:${sink.address().port}/capture`);return res.end();}
    if(req.url==='/selection')return res.end(JSON.stringify({schema:1,instanceId:instance,capabilities:['external-sessions-v1']}));
    authenticated++;
    if(req.headers['x-ours-api-token']!=='test-issued'||revoked){res.statusCode=401;return res.end('{}');}
    if(req.url==='/identities')return res.end('{"identities":[]}');
    res.statusCode=404;res.end('{}');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const authorize=createManagementAuthorizer({OURS_COWORK_HTTP_MANAGEMENT:'1',OURS_DAEMON_URL:`http://127.0.0.1:${server.address().port}`,OURS_DAEMON_ID:expected});
  const request=token=>({headers:{'x-ours-api-token':token},rawHeaders:['x-ours-api-token',token]});
  assert.equal(await authorize(request('test-issued')),true);
  revoked=true;assert.equal(await authorize(request('test-issued')),false);
  revoked=false;instance='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';const before=authenticated;
  assert.equal(await authorize(request('test-issued')),false);assert.equal(authenticated,before);
  instance=expected;redirect=true;assert.equal(await authorize(request('test-issued')),false);assert.equal(leaked,0);
});
