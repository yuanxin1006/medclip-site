/**
 * Provider-free authenticated browser verification for SET_CAPTION_TEXT.
 * Requires a running localhost app and .env.local values for the Supabase URL,
 * anon key, test user, and internal fixture proof secret. Playwright resolves
 * from Node normally; MEDCLIP_PLAYWRIGHT_MODULE is an optional module override.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { parseAIEditingPlan } from '../app/editor-ai-requirements.ts';
import { parseEditorProject } from '../app/editor-core.ts';
import {
  createInternalTextTaskFixtureApplicationContext,
  INTERNAL_TEXT_TASK_FIXTURE_HEADER,
} from '../supabase/functions/_shared/ai-tasks/text-fixtures.ts';
import {
  createInternalLiveValidationProof,
  INTERNAL_LIVE_VALIDATION_HEADER,
} from '../supabase/functions/_shared/ai-tasks/internal-live-validation.ts';
import {
  createAITaskNetworkTracker,
  readEditorSpecificSurface,
} from './video-ai-live-acceptance-harness.ts';

const REQUIRED_CHECKPOINT='12dc080b17a182af7a5b9f40f96566ceb1ea2dbc';
const PROJECT_KEY='medclip-editor-draft-v1';
const REQUIREMENT='把第一条字幕改成“高血压”。';
const FIXTURE='valid_caption_first_chinese_medical_correction';
const ORIGINAL_TEXT='高血呀';
const REPLACEMENT_TEXT='高血压';
let stage='START';
let authClient;
let rawContext,page,realBrowser;
let aiTaskRequests=0;
let fixtureExecutions=0;
let realProviderGenerations=0;
let routeViolation=false;
let requestDispatched=false;

function envFileValue(name) {
  let content;
  try { content=readFileSync('.env.local','utf8'); }
  catch(error) { if(error?.code==='ENOENT') return undefined; throw error; }
  const line=content.split(/\r?\n/).find(item=>item.startsWith(`${name}=`));
  return line?line.slice(name.length+1).trim().replace(/^['"]|['"]$/g,''):undefined;
}
async function resolvePlaywright(env=process.env) {
  try { return await import('playwright'); }
  catch(error) {
    if(!env.MEDCLIP_PLAYWRIGHT_MODULE || error?.code!=='ERR_MODULE_NOT_FOUND') throw error;
    return import(env.MEDCLIP_PLAYWRIGHT_MODULE);
  }
}
function clone(value){return structuredClone(value);}
function persisted(page){return page.evaluate(key=>JSON.parse(localStorage.getItem(key)),PROJECT_KEY);}
function caption(project,id){return project.captions.find(item=>item.id===id);}
function assertCanonicalAction(action,targetId){
  assert.ok(action&&typeof action==='object'&&!Array.isArray(action));
  assert.deepEqual(Object.keys(action).sort(),['reason','targetId','text','type']);
  assert.equal(action.type,'SET_CAPTION_TEXT');
  assert.equal(action.targetId,targetId);
  assert.equal(action.text,REPLACEMENT_TEXT);
  assert.equal(typeof action.reason,'string');
  assert.ok(action.reason.trim());
}
function assertPreserved(before,after,targetId,expectedText){
  assert.equal(after.schemaVersion,before.schemaVersion);
  assert.equal(after.id,before.id);
  assert.equal(after.title,before.title);
  assert.equal(after.durationMs,before.durationMs);
  assert.equal(after.ratio,before.ratio);
  assert.deepEqual(after.audioSelection,before.audioSelection);
  assert.deepEqual(after.assets,before.assets);
  assert.deepEqual(after.tracks,before.tracks);
  assert.equal(after.captions.length,before.captions.length);
  for(const prior of before.captions){
    const current=caption(after,prior.id);
    assert.ok(current);
    assert.equal(current.startMs,prior.startMs);
    assert.equal(current.endMs,prior.endMs);
    assert.equal(current.text,prior.id===targetId?expectedText:prior.text);
    for(const key of Object.keys(prior)) if(!['text'].includes(key)) assert.deepEqual(current[key],prior[key]);
  }
}
async function waitPersistedText(page,targetId,text){
  await page.waitForFunction(({key,targetId,text})=>{
    try{return JSON.parse(localStorage.getItem(key))?.captions?.find(item=>item.id===targetId)?.text===text;}
    catch{return false;}
  },{key:PROJECT_KEY,targetId,text},{timeout:15_000});
}
async function derivedText(page){
  return (await page.locator('.preview-subtitle').textContent())?.trim();
}
async function waitDerivedText(page,text){
  const deadline=Date.now()+15_000;
  while(Date.now()<deadline){
    if(await derivedText(page)===text)return text;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.fail('DERIVED_CAPTION_TIMEOUT');
}
async function assertTimelinePreview(page,text){
  const preview=page.locator('.timeline-editor-shell .editor-caption-preview');
  await preview.waitFor({state:'visible',timeout:15_000});
  assert.equal((await preview.textContent())?.trim(),text);
  return text;
}

async function main(){
  stage='BASELINE';
  execFileSync('git',['merge-base','--is-ancestor',REQUIRED_CHECKPOINT,'HEAD'],{stdio:'ignore'});
  assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),'');
  const internalSecret=process.env.MEDCLIP_INTERNAL_LIVE_VALIDATION_SECRET??envFileValue('MEDCLIP_INTERNAL_LIVE_VALIDATION_SECRET');
  assert.ok(internalSecret);
  const base=new URL(process.env.MEDCLIP_BASE_URL??'http://localhost:3000');
  assert.ok(['localhost','127.0.0.1'].includes(base.hostname));
  const projectUrl=process.env.NEXT_PUBLIC_SUPABASE_URL??envFileValue('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY??envFileValue('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const testEmail=process.env.MEDCLIP_TEST_USER_A_EMAIL??envFileValue('MEDCLIP_TEST_USER_A_EMAIL');
  const testPassword=process.env.MEDCLIP_TEST_USER_A_PASSWORD??envFileValue('MEDCLIP_TEST_USER_A_PASSWORD');
  assert.ok(projectUrl&&anonKey&&testEmail&&testPassword);
  const supabaseOrigin=new URL(projectUrl).origin;
  const supabaseRef=new URL(projectUrl).hostname.split('.')[0];
  assert.match(supabaseRef,/^[a-z0-9]+$/);
  const fixtureContext=createInternalTextTaskFixtureApplicationContext(FIXTURE);
  const baseline=clone(fixtureContext.project);
  assert.equal(baseline.captions.length,3);
  const targetId=baseline.captions[0].id;
  assert.equal(baseline.captions[0].text,ORIGINAL_TEXT);

  stage='PLAYWRIGHT_SETUP';
  const realPlaywright=await resolvePlaywright(process.env);
  stage='AUTH';
  authClient=createClient(projectUrl,anonKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:authData,error:authError}=await authClient.auth.signInWithPassword({email:testEmail,password:testPassword});
  assert.ifError(authError);
  const session=authData.session;
  assert.ok(session?.access_token&&session.user?.id);
  const {data:userData,error:userError}=await authClient.auth.getUser(session.access_token);
  assert.ifError(userError);
  assert.equal(userData.user?.id,session.user.id);

  stage='PROVIDER_FREE_ROUTE';
  realBrowser=await realPlaywright.chromium.launch({headless:true});
  rawContext=await realBrowser.newContext();
  await rawContext.addInitScript(({authKey,sessionValue,projectKey,project})=>{
    localStorage.setItem(authKey,JSON.stringify(sessionValue));
    localStorage.setItem(projectKey,JSON.stringify(project));
  },{authKey:`sb-${supabaseRef}-auth-token`,sessionValue:session,projectKey:PROJECT_KEY,project:baseline});
  let armed=false;
  await rawContext.route('**/*',async route=>{
    const request=route.request();
    const url=new URL(request.url());
    if(!['http:','https:'].includes(url.protocol)) return route.continue();
    if(url.origin===base.origin) return route.continue();
    if(url.origin===supabaseOrigin&&url.pathname.endsWith('/functions/v1/ai-tasks')&&request.method()==='POST'){
      aiTaskRequests++;
      let body;
      try{body=request.postDataJSON();}catch{routeViolation=true;return route.abort();}
      let trusted=false;
      try{
        const context=JSON.parse(body.input?.editorContext);
        trusted=Array.isArray(context.captions)&&context.captions.length===3
          &&context.captions.every((item,index)=>item.id===baseline.captions[index].id
            &&item.text===baseline.captions[index].text&&item.startMs===baseline.captions[index].startMs
            &&item.endMs===baseline.captions[index].endMs&&item.ordinal===index+1&&item.eligible===true);
      }catch{}
      if(!armed||aiTaskRequests!==1||body.task!=='editor.requirements_parse'||body.provider!=='deepseek'
        ||body.input?.editingRequirement!==REQUIREMENT||!trusted){routeViolation=true;return route.abort();}
      const proof=await createInternalLiveValidationProof({secret:internalSecret,userId:session.user.id,request:body});
      fixtureExecutions++;
      requestDispatched=true;
      return route.continue({headers:{...request.headers(),[INTERNAL_TEXT_TASK_FIXTURE_HEADER]:FIXTURE,
        [INTERNAL_LIVE_VALIDATION_HEADER]:proof}});
    }
    if(url.origin===supabaseOrigin&&url.pathname.endsWith('/functions/v1/ai-credentials')&&request.method()==='POST'){
      let body;try{body=request.postDataJSON();}catch{routeViolation=true;return route.abort();}
      if(body.action==='list'&&request.headers()['authorization']?.startsWith('Bearer '))return route.continue();
      routeViolation=true;return route.abort();
    }
    if(url.origin===supabaseOrigin&&url.pathname==='/auth/v1/user'&&request.method()==='GET')return route.continue();
    if(url.origin===supabaseOrigin&&url.pathname==='/auth/v1/token'&&request.method()==='POST')return route.continue();
    if(url.origin===supabaseOrigin&&url.pathname.startsWith('/storage/v1/'))return route.continue();
    if(url.pathname.startsWith('/functions/'))routeViolation=true;
    return route.abort();
  });

  stage='FIXTURE_INJECTION';
  stage='FIXTURE_RELOAD';
  page=await rawContext.newPage();
  const restoredResponse=await page.goto(new URL('/editor',base).href,{waitUntil:'domcontentloaded'});
  assert.equal(restoredResponse?.status(),200);
  stage='FIXTURE_MAIN_READY';
  await page.locator('main.app-shell').waitFor({state:'visible',timeout:30_000});
  stage='FIXTURE_CAPTION_READY';
  await waitDerivedText(page,ORIGINAL_TEXT);
  stage='FIXTURE_TEXT';
  assert.equal(await derivedText(page),ORIGINAL_TEXT);
  stage='FIXTURE_COUNT';
  assert.match((await page.locator('.compact-project-summary').textContent())??'',/3 句字幕/);
  stage='FIXTURE_PARSE';
  const restored=parseEditorProject(JSON.stringify(await persisted(page)));
  assert.ok(restored);
  stage='FIXTURE_IDENTITY';
  assertPreserved(baseline,restored,targetId,ORIGINAL_TEXT);

  stage='REQUIREMENT';
  const providerRadio=page.getByRole('radio',{name:/DeepSeek/i});
  await providerRadio.waitFor({state:'visible',timeout:30_000});
  const providerDeadline=Date.now()+30_000;
  while(!(await providerRadio.isEnabled())&&Date.now()<providerDeadline)await new Promise(resolve=>setTimeout(resolve,50));
  stage='REQUIREMENT_PROVIDER_READY';
  assert.equal(await providerRadio.isEnabled(),true);
  await providerRadio.click();
  stage='REQUIREMENT_DETAILS';
  await page.locator('.requirement-advanced summary').click();
  stage='REQUIREMENT_DIALOG';
  await page.locator('.requirement-trigger').click();
  stage='REQUIREMENT_INPUT';
  await page.locator('#requirement-text').fill(REQUIREMENT);
  assert.equal(await page.locator('#requirement-text').inputValue(),REQUIREMENT);

  stage='FIXTURE_EXECUTION';
  const tracker=createAITaskNetworkTracker(page,90_000);
  const rawPromise=page.waitForResponse(response=>response.request().method()==='POST'
    &&new URL(response.url()).pathname.endsWith('/functions/v1/ai-tasks'),{timeout:90_000});
  const safePromise=tracker.waitForResponse();
  assert.equal(tracker.getRequestCount(),0);
  armed=true;
  await page.locator('.ai-apply-button').click();
  const [rawResponse,safeResponse]=await Promise.all([rawPromise,safePromise]);
  const envelope=await rawResponse.json();
  const confirm=page.getByRole('button',{name:'确认并应用剪辑建议',exact:true});
  await confirm.waitFor({timeout:90_000});
  assert.deepEqual(await persisted(page),baseline);
  await confirm.click();
  await page.waitForFunction(()=>Boolean(document.querySelector('.editor-ai-apply-summary'))
    ||Boolean(document.querySelector('.editor-ai-dialog-error[role="alert"]')),undefined,{timeout:90_000});
  const surface=await readEditorSpecificSurface(page);
  assert.equal(rawResponse.status(),200);
  assert.equal(safeResponse.httpStatus,200);
  assert.equal(safeResponse.ok,true);
  assert.equal(envelope.ok,true);
  assert.equal(envelope.task,'editor.requirements_parse');
  assert.equal(envelope.provider,'deepseek');
  assert.equal(envelope.metadata?.providerFreeFixture,true);
  assert.equal(envelope.metadata?.generationOccurred,false);
  assert.equal(surface.successVisible,true);
  assert.equal(surface.errorVisible,false);
  assert.equal(routeViolation,false);
  assert.equal(aiTaskRequests,1);
  assert.equal(fixtureExecutions,1);
  assert.equal(tracker.getRequestCount(),1);
  const plan=parseAIEditingPlan(envelope.result?.data);
  assert.equal(plan.actions.length,1);
  assertCanonicalAction(plan.actions[0],targetId);

  stage='PRODUCT_APPLY';
  await waitPersistedText(page,targetId,REPLACEMENT_TEXT);
  const applied=await persisted(page);
  assertPreserved(baseline,applied,targetId,REPLACEMENT_TEXT);
  assert.equal(caption(applied,targetId).id,targetId);
  assert.equal(await derivedText(page),REPLACEMENT_TEXT);

  stage='TIMELINE_PREVIEW';
  const closeDialog=page.getByRole('button',{name:'关闭需求对话框',exact:true});
  if(await closeDialog.isVisible())await closeDialog.click();
  const continueButton=page.locator('.continue-edit-button');
  await continueButton.waitFor({state:'visible',timeout:15_000});
  await continueButton.click();
  const timeline=page.locator('.timeline-editor-shell');
  await timeline.waitFor({state:'visible',timeout:15_000});
  const targetCaption=timeline.locator('.timeline-caption').filter({hasText:REPLACEMENT_TEXT});
  assert.equal(await targetCaption.count(),1);
  await targetCaption.click();
  const captionEditor=timeline.locator('.editor-properties textarea');
  await captionEditor.waitFor({state:'visible',timeout:15_000});
  assert.equal(await captionEditor.inputValue(),REPLACEMENT_TEXT);
  assert.equal(await captionEditor.isEnabled(),true);
  await timeline.getByRole('button',{name:'播放头定位到字幕',exact:true}).click();
  const previewApplied=await assertTimelinePreview(page,REPLACEMENT_TEXT);
  const undoButton=timeline.getByRole('button',{name:'↶ 撤销',exact:true});
  const redoButton=timeline.getByRole('button',{name:'↷ 重做',exact:true});
  assert.equal(await undoButton.count(),1);
  await page.waitForFunction(()=>{
    const shell=document.querySelector('.timeline-editor-shell');
    const button=[...shell?.querySelectorAll('button')??[]].find(item=>item.textContent?.trim()==='↶ 撤销');
    return button?.disabled===false;
  },undefined,{timeout:15_000});
  assert.equal(await redoButton.isDisabled(),true);

  stage='UNDO';
  await undoButton.click();
  await waitPersistedText(page,targetId,ORIGINAL_TEXT);
  await waitDerivedText(page,ORIGINAL_TEXT);
  const undone=await persisted(page);
  assertPreserved(baseline,undone,targetId,ORIGINAL_TEXT);
  assert.equal(await derivedText(page),ORIGINAL_TEXT);
  assert.equal(await captionEditor.inputValue(),ORIGINAL_TEXT);
  const undoPreview=await assertTimelinePreview(page,ORIGINAL_TEXT);
  await page.waitForFunction(()=>{
    const shell=document.querySelector('.timeline-editor-shell');
    const undo=[...shell?.querySelectorAll('button')??[]].find(item=>item.textContent?.trim()==='↶ 撤销');
    const redo=[...shell?.querySelectorAll('button')??[]].find(item=>item.textContent?.trim()==='↷ 重做');
    return undo?.disabled===true&&redo?.disabled===false;
  },undefined,{timeout:15_000});

  stage='REDO';
  await redoButton.click();
  await waitPersistedText(page,targetId,REPLACEMENT_TEXT);
  await waitDerivedText(page,REPLACEMENT_TEXT);
  const redone=await persisted(page);
  assertPreserved(baseline,redone,targetId,REPLACEMENT_TEXT);
  assert.equal(await derivedText(page),REPLACEMENT_TEXT);
  assert.equal(await captionEditor.inputValue(),REPLACEMENT_TEXT);
  const redoPreview=await assertTimelinePreview(page,REPLACEMENT_TEXT);
  assert.equal(await captionEditor.isEnabled(),true);

  stage='SRT_EXPORT';
  await timeline.getByRole('button',{name:'关闭编辑器',exact:true}).click();
  await timeline.waitFor({state:'hidden',timeout:15_000});
  const downloadPromise=page.waitForEvent('download',{timeout:15_000});
  await page.getByRole('button',{name:'下载 SRT',exact:true}).click();
  const download=await downloadPromise;
  const downloadPath=await download.path();
  assert.ok(downloadPath);
  const srt=await readFile(downloadPath,'utf8');
  assert.match(srt,/1\n00:00:00,000 --> 00:00:01,000\n高血压/);
  assert.match(srt,/2\n00:00:01,000 --> 00:00:02,000\nTake medicine/);
  assert.match(srt,/3\n00:00:02,000 --> 00:00:03,000\n患者无发热/);
  assert.equal((srt.match(/--> /g)??[]).length,3);
  const finalProject=await persisted(page);
  assertPreserved(baseline,finalProject,targetId,REPLACEMENT_TEXT);
  assert.equal(envelope.metadata.providerFreeFixture,true);
  realProviderGenerations=envelope.metadata.generationOccurred===true?1:0;
  assert.equal(realProviderGenerations,0);

  console.log(JSON.stringify({result:'PASS',requestDispatched,fixtureExecutions,realProviderGenerations,
    auth:true,authVerified:true,sessionIsolated:true,reused:{browser:'shared Playwright resolver',auth:true,
      history:true,persistence:true,providerAccounting:true},captionCount:baseline.captions.length,targetId,
    initialText:baseline.captions[0].text,startMs:baseline.captions[0].startMs,endMs:baseline.captions[0].endMs,
    requirement:REQUIREMENT,action:{count:plan.actions.length,type:plan.actions[0].type,targetTrust:true,
      text:plan.actions[0].text,reasonNonEmpty:true,unknownFields:'NONE'},planAccepted:true,productError:false,
    projectText:caption(applied,targetId).text,derivedText:REPLACEMENT_TEXT,stateSync:true,idPreserved:true,
    startPreserved:true,endPreserved:true,timingPreserved:true,preview:{binding:true,text:previewApplied,pass:true},
    historyEntries:1,undo:{controlFound:true,controlEnabled:true,projectText:caption(undone,targetId).text,
      derivedText:ORIGINAL_TEXT,previewText:undoPreview,timingPreserved:true,pass:true},
    redo:{projectText:caption(redone,targetId).text,derivedText:REPLACEMENT_TEXT,previewText:redoPreview,
      timingPreserved:true,pass:true},preservation:true,persistence:true,srt:true,manualEditPath:true,
    noOp:'DEFERRED — already locally proven',ambiguous:'DEFERRED — contract-level PASS',aiTaskRequests,
    providerCalls:{deepseek:0,kimi:0,doubao:0,tokenhub:0}}));
}

if(process.argv[2]==='--source-integrity'){
  const source=readFileSync(new URL(import.meta.url),'utf8');
  assert.equal(source.includes(REQUIREMENT),true);
  assert.equal(source.includes('\ufffd'),false);
  assert.equal(Buffer.from(source,'utf8').toString('utf8'),source);
  console.log('SOURCE_INTEGRITY=PASS');
}else{
  try{await main();}
  catch{console.log(JSON.stringify({result:'FAIL',stage,requestDispatched,fixtureExecutions,
    realProviderGenerations,aiTaskRequests,providerCalls:{deepseek:0,kimi:0,doubao:0,tokenhub:0}}));process.exitCode=1;}
  finally{
    if(rawContext){try{await rawContext.close();}catch{}}
    if(realBrowser){try{await realBrowser.close();}catch{}}
    if(authClient){try{await authClient.auth.signOut({scope:'local'});}catch{}}
  }
}
