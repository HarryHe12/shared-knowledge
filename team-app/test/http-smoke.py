"""Run against the local disposable demo server; does not access provider credentials."""
import json,urllib.request,urllib.error
base='http://127.0.0.1:5181'
token='local-demo-only-20261021-token'
def call(path,body=None,authorization=token):
 req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+authorization,'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=10) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
assert call('/api/projects',authorization='invalid')[0]==401
status,projects=call('/api/projects');assert status==200
p=projects[0]['id']
assert call('/api/projects/'+p+'/records',{'text':''})[0]==400
assert call('/api/projects/'+p+'/records',{'text':'x','changes':[{'title':'x','status':'invalid'}]})[0]==400
assert call('/api/projects/'+p+'/items')[0]==200
assert call('/api/projects/'+p+'/records')[0]==200
print('HTTP smoke: 5 assertions passed (401, invalid text, invalid status, items, records)')
