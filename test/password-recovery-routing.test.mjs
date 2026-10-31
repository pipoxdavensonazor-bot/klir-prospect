import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

async function router({hash='#/landing',recovery=false,user={id:'fixture'},pending=null,callbackError=null}={}) {
  const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
  const sandbox={location:{hash},authState:{user,passwordRecovery:recovery},rendered:null};
  sandbox.KS={S:{user}};
  sandbox.window={KlirStore:sandbox.KS,KlirAuth:{state:()=>({pending,callbackError})}};
  for(const [name,label] of [['vAuthError','error'],['vLanding','landing'],['vResetPassword','reset'],['vAuthCallback','confirm']])
    sandbox[name]=()=>{sandbox.rendered=label;};
  sandbox.vAuth=()=>{sandbox.rendered='login';};
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function nav('),source.indexOf('window.addEventListener("hashchange"')),sandbox);
  vm.runInContext(source.slice(source.indexOf('function render(){'),source.indexOf('function vProfile(')),sandbox);
  return sandbox;
}

test('une session de récupération ouvre le formulaire depuis accueil, connexion ou dashboard',async()=>{
  for(const hash of ['#/landing','#/login','#/dashboard']){
    const app=await router({hash,recovery:true});app.render();
    assert.equal(app.location.hash,'#/reset-password');assert.equal(app.rendered,'reset');
  }
});
test('un événement de récupération tardif remplace la page de connexion sans boucle',async()=>{
  const app=await router({hash:'#/login'});app.render();assert.equal(app.rendered,'login');
  app.authState.passwordRecovery=true;app.render();app.render();assert.equal(app.rendered,'reset');
});
test('le jeton en attente reste à confirmer avant de présenter le formulaire',async()=>{
  const app=await router({recovery:true,pending:{type:'recovery'}});app.render();
  assert.equal(app.location.hash,'#/auth/confirm');assert.equal(app.rendered,'confirm');
});
test('une session ordinaire ou absente ne reçoit pas une redirection de récupération',async()=>{
  for(const user of [null,{id:'fixture'}]){
    const app=await router({hash:'#/login',user});app.render();
    assert.equal(app.location.hash,'#/login');assert.equal(app.rendered,'login');
  }
});

test('un lien refuse presente une reprise sans ouvrir la session de recuperation',async()=>{
  const app=await router({recovery:true,callbackError:'Lien expire'});app.render();
  assert.equal(app.rendered,'error');
});
