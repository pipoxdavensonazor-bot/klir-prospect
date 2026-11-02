import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {parseAuthError,parseAuthCallback,recoveryRequestMessage} from '../src/auth-policy.js';

test('les messages ne reprennent jamais une description ou un code arbitraire',()=>{
  assert.equal(parseAuthError('?other=1'),null);
  assert.match(parseAuthError('?error=access_denied&error_code=otp_expired'),/expiré/);
  assert.doesNotMatch(parseAuthError('?error=secret&error_description=<script>secret</script>'),/secret|script/);
});

test('la demande de récupération masque les comptes absents et les erreurs brutes',()=>{
  const success=recoveryRequestMessage(null);
  for(const code of ['user_not_found','email_not_found','user_not_registered'])
    assert.equal(recoveryRequestMessage({code,message:'secret@example.invalid'}),success);
  assert.match(recoveryRequestMessage({status:429,message:'private'}),/Patientez/);
  assert.doesNotMatch(recoveryRequestMessage({status:500,message:'secret@example.invalid'}),/secret|example/);
});

test('le fournisseur de récupération simulé ne reçoit que l’adresse et la redirection prévues',async()=>{
  const source=await readFile(new URL('../src/auth.js',import.meta.url),'utf8');
  const calls=[];
  const context={redirectUrl:()=> 'https://fixture.invalid/',requireClient:async()=>({auth:{resetPasswordForEmail:async(...args)=>{calls.push(args);return {error:null};}}})};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function sendRecovery('),source.indexOf('async function updatePassword(')),context);
  assert.equal((await context.sendRecovery(' fictional@example.invalid ')).error,null);
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'fictional@example.invalid');
  assert.equal(calls[0][1].redirectTo,'https://fixture.invalid/');
});

test('un refus retire les paramètres et le jeton en attente sans créer de session',async()=>{
  const source=await readFile(new URL('../src/auth.js',import.meta.url),'utf8');
  for(const fragment of [false,true]){
    const suffix='error=access_denied&error_code=otp_expired&error_description=fixture-only';
    const url=new URL('https://fixture.invalid/'+(fragment?'#'+suffix:'?keep=1&'+suffix+'#/landing'));
    const removed=[];
    const context={parseAuthError,parseAuthCallback,URL,callbackError:null,CALLBACK_KEY:'fixture',readPending:()=>null,
      sessionStorage:{removeItem:key=>removed.push(key),setItem:()=>assert.fail('aucun jeton refusé conservé')},
      window:{location:url,history:{replaceState:(_state,_title,path)=>{context.cleaned=path;}}}};
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('function captureCallback()'),source.indexOf('async function requireClient()')),context);
    assert.equal(context.captureCallback(),null);
    assert.match(context.callbackError,/expiré/);
    assert.deepEqual(removed,['fixture']);
    assert.doesNotMatch(context.cleaned,/error|fixture-only/);
    if(!fragment)assert.equal(context.cleaned,'/?keep=1#/landing');
  }
});

test('le retour PKCE sans verificateur est explique et le code retire',async()=>{
  const source=await readFile(new URL('../src/auth.js',import.meta.url),'utf8');
  let subscribed=false;
  const context={captureCallback:()=>{},initialized:false,callbackError:null,URL,URLSearchParams,
    hydrate:async()=>({user:null}),
    window:{location:new URL('https://fixture.invalid/?code=synthetic-only#/landing'),history:{replaceState:(_s,_t,path)=>{context.cleaned=path;}}},
    client:{auth:{onAuthStateChange:()=>{subscribed=true;},initialize:async()=>{
      assert.equal(subscribed,true,'abonnement avant reception de PASSWORD_RECOVERY');
      return {error:{code:'pkce_code_verifier_not_found',message:'private-fixture'}};
    }}}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function initialize()'),source.indexOf('window.KlirAuth =')),context);
  assert.equal((await context.initialize()).user,null);
  assert.match(context.callbackError,/onglet/);
  assert.doesNotMatch(context.callbackError,/private-fixture/);
  assert.equal(context.cleaned,'/#/landing');
});

test('un code ignore sans erreur par le SDK ne retombe pas silencieusement sur la connexion',async()=>{
  const source=await readFile(new URL('../src/auth.js',import.meta.url),'utf8');
  const context={captureCallback:()=>{},initialized:false,callbackError:null,URL,URLSearchParams,
    hydrate:async()=>({user:null}),
    window:{location:new URL('https://fixture.invalid/?code=synthetic-only#/login'),history:{replaceState:(_s,_t,path)=>{context.cleaned=path;}}},
    client:{auth:{onAuthStateChange:()=>{},initialize:async()=>({error:null})}}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function initialize()'),source.indexOf('window.KlirAuth =')),context);
  assert.equal((await context.initialize()).user,null);
  assert.match(context.callbackError,/onglet/);
  assert.equal(context.cleaned,'/#/login');
});

test('un echange reussi conserve PASSWORD_RECOVERY sans erreur ni second echange',async()=>{
  const source=await readFile(new URL('../src/auth.js',import.meta.url),'utf8');
  let subscriber;
  const context={captureCallback:()=>{},initialized:false,callbackError:null,passwordRecovery:false,URL,URLSearchParams,
    queueMicrotask:()=>{},
    hydrate:async()=>({user:{id:'fiction'},passwordRecovery:context.passwordRecovery}),
    window:{location:new URL('https://fixture.invalid/?code=synthetic-only'),history:{replaceState:()=>assert.fail('ne pas retraiter le code consomme')}},
    client:{auth:{onAuthStateChange:fn=>{subscriber=fn;},initialize:async()=>{
      context.window.location.search='';subscriber('PASSWORD_RECOVERY');return {error:null};
    }}}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function initialize()'),source.indexOf('window.KlirAuth =')),context);
  const result=await context.initialize();
  assert.equal(result.passwordRecovery,true);
  assert.equal(result.user.id,'fiction');
  assert.equal(context.callbackError,null);
});
