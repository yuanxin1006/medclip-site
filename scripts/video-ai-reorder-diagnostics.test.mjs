import assert from 'node:assert/strict';
import test from 'node:test';
import { setup } from './video-ai-reorder-test-fixture.mjs';
import { runAcceptanceCLI, parseMode, runReorderAcceptance } from './run-video-ai-reorder-live-acceptance.mjs';
import { assetAInteractionCondition, AUTO_OPEN_EDITOR_SELECTOR, createReorderAdapter, persistedReplacementCondition, replaceChronologicalClipAssetsAndClose } from './video-ai-reorder-browser-adapter.mjs';
import { verifyRemoteIdentity } from './video-ai-reorder-identity.mjs';
import { ASSET_REPLACEMENT_SUBSTAGES, GATE_CODES, SAFE_CODES, OWNED_MEDIA_SUBSTAGES, LIVE_ACCEPTANCE_SUBSTAGES, gateScope, SafeAcceptanceGateError, formatAcceptanceFailure } from './video-ai-reorder-diagnostics.mjs';
const secret = ['fake-api-key','Bearer fake-bearer','eyJfake.JWT.signature','fake-password','https://private.supabase.co/?secret=fake','https://media.private/secret.mp4','editorContext:private-fragment','raw Provider response:private'].join('|');
const raw = () => new Error(secret);
const env = Object.fromEntries(['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY','MEDCLIP_TEST_USER_A_EMAIL','MEDCLIP_TEST_USER_A_PASSWORD','SUPABASE_ACCESS_TOKEN','MEDCLIP_INTERNAL_LIVE_VALIDATION_SECRET','MEDCLIP_REORDER_VIDEO_A','MEDCLIP_REORDER_VIDEO_B','MEDCLIP_REORDER_VIDEO_C','MEDCLIP_REORDER_AUDIO'].map(k=>[k,'mock']));
env.NEXT_PUBLIC_SUPABASE_URL='https://mock.supabase.co';
test('all LIVE_ACCEPTANCE substages are allowlisted and render as fixed names only',()=>{
  assert.equal(GATE_CODES.LIVE_ACCEPTANCE,'ASSERTION_FAILED');
  assert.equal(LIVE_ACCEPTANCE_SUBSTAGES.length,34);
  for(const substage of LIVE_ACCEPTANCE_SUBSTAGES){
    const error=new SafeAcceptanceGateError('LIVE_ACCEPTANCE','ASSERTION_FAILED',substage);
    assert.equal(error.substage,substage);
    assert.equal(formatAcceptanceFailure(error,false).split('\n').find(line=>line.startsWith('SUBSTAGE = ')),`SUBSTAGE = ${substage}`);
  }
  assert.equal(new SafeAcceptanceGateError('LIVE_ACCEPTANCE','ASSERTION_FAILED','raw secret').substage,undefined);
});
test('known inner LIVE_ACCEPTANCE substage survives nested gateScope wrappers and sanitization',async()=>{
  await assert.rejects(gateScope('LIVE_ACCEPTANCE',async(_stage,setSubstage)=>{
    setSubstage('LIVE_ACTION_TARGET');
    await gateScope('LIVE_ACCEPTANCE',async(_innerStage,innerSubstage)=>{
      innerSubstage('LIVE_ACTION_REFERENCE');throw new Error(secret);
    });
  }),error=>{
    assert.equal(error.gate,'LIVE_ACCEPTANCE');assert.equal(error.code,'ASSERTION_FAILED');
    assert.equal(error.substage,'LIVE_ACTION_REFERENCE');
    const output=formatAcceptanceFailure(error,false);
    assert.match(output,/SUBSTAGE = LIVE_ACTION_REFERENCE/);
    assert.doesNotMatch(output,/fake-api-key|private\.supabase|raw Provider response/);
    return true;
  });
});
test('CLI reaches formatAcceptanceFailure with the safe fixed LIVE substage only',async()=>{
  const s=setup(),lines=[];s.adapter.prepareRequirement=async()=>{throw new Error(secret);};
  const code=await runAcceptanceCLI(['--mode=live'],{MEDCLIP_ALLOW_REORDER_LIVE:'YES'},()=>s.adapter,{log:value=>lines.push(value),error:value=>lines.push(value)});
  assert.equal(code,1);assert.ok(lines.join('\n').includes('GATE = LIVE_ACCEPTANCE'));
  assert.ok(lines.join('\n').includes('SUBSTAGE = LIVE_REQUIREMENT_PREPARE'));
  assert.ok(lines.join('\n').includes('CODE = ASSERTION_FAILED'));
  assert.doesNotMatch(lines.join('\n'),/fake-api-key|private\.supabase|raw Provider response/);
  assert.equal(s.clicks(),0);
});
async function expectGate(action, gate, code=GATE_CODES[gate], substage) {
  await assert.rejects(action,e=>{
    assert.ok(e instanceof SafeAcceptanceGateError);
    assert.equal(e.gate,gate); assert.equal(e.code,code);
    if (substage) assert.equal(e.substage,substage);
    for(const output of [JSON.stringify(e),formatAcceptanceFailure(e),String(e),e.stack]) for(const item of secret.split('|')) assert.ok(!output.includes(item));
    return true;
  });
}
function mockedAdapter(failure) {
  const s=setup();
  const project=structuredClone(s.project);
  project.assets.forEach((a,i)=>{a.name=`medclip-reorder-${'ABC'[i]}.mp4`;});
  if(failure==='THREE_CLIP_SETUP') project.tracks.flatMap(t=>t.clips).forEach(c=>{c.timelineEndMs=c.timelineStartMs;});
  const state={project,audio:[{id:'audio'}],ownedIds:failure==='OWNERSHIP_VALIDATION'?[]:project.assets.map(a=>a.id),segments:[]};
  const fail=(gate)=>{if(failure===gate)throw raw();};
  let waitForFunctionCalls=0;
  const locator=selector=>({
    locator:child=>locator(child),getByLabel:name=>locator(name),getByRole:(_role,options)=>locator(options.name),
    nth:index=>locator(`${selector}:nth(${index})`), setInputFiles:async file=>{
      fail('OWNED_MEDIA_SETUP');
      if(file.name==='medclip-reorder-A.mp4')fail('VIDEO_A_REGISTRATION');
      if(file.name==='medclip-reorder-B.mp4')fail('VIDEO_B_REGISTRATION');
      if(file.name==='medclip-reorder-C.mp4')fail('VIDEO_C_REGISTRATION');
      if(file.name==='medclip-reorder.wav')fail('AUDIO_REGISTRATION');
    },
    waitFor:async()=>{if(selector==='section[aria-label="生成后继续剪辑"]')fail('PROJECT_OPEN');}, fill:async()=>{fail('SUBTITLE_PREPARATION');},
    isChecked:async()=>{fail('CONSENT_CONFIRMATION');return true;},check:async()=>{fail('CONSENT_CONFIRMATION');},
    click:async()=>{if(selector.startsWith('.subtitle-source-tabs button'))fail('SUBTITLE_PREPARATION');if(selector==='button.generate-button')fail('PROJECT_GENERATION');},
    count:async()=>1,dispatchEvent:async()=>{},selectOption:async()=>{fail('ASSET_REPLACEMENT');},evaluate:async()=>{},
  });
  const page={locator,getByRole:(_role,o)=>locator(o.name),getByLabel:name=>locator(name),
    goto:async()=>{fail('EDITOR_LOAD');return {ok:()=>true};},url:()=> 'http://localhost:3000/editor',on:()=>{},waitForFunction:async()=>{waitForFunctionCalls++;if(waitForFunctionCalls===1)fail('GENERATE_READINESS');},
    evaluate:async fn=>{
      if(fn.toString().includes('__reactFiber$')){fail('PROJECT_STATE_VALIDATION');return state;}
      return JSON.stringify(project);
    },
  };
  const deps={
    readFile:async()=>{fail('LOCAL_FILE_READ');return new Uint8Array([0]);},fetch:async()=>{fail('AUTH_HEALTH');return {ok:failure!=='HTTP_FAILURE'};},
    supabase:{createClient:()=>({auth:{
      signInWithPassword:async()=>{fail('AUTH_SIGN_IN');return {error:null,data:{session:{access_token:'mock',user:{id:'user'}}}};},
      getUser:async()=>({error:null,data:{user:{id:failure==='AUTH_GET_USER'?'wrong':'user'}}}),stopAutoRefresh:()=>{},
    }})},
    playwright:{chromium:{launch:async()=>{fail('BROWSER_LAUNCH');return {close:async()=>{},newContext:async()=>({addInitScript:async()=>{},route:async()=>{},newPage:async()=>page})};}}},
  };
  return {deps,s};
}
for(const args of [[],['--mode=unknown'],['--mode=live'],['--mode=preflight','--debug']]) test(`safe mode rejection ${JSON.stringify(args)}`,()=>{
  assert.throws(()=>parseMode(args,{}),{gate:'MODE_VALIDATION',code:'INVALID_ARGUMENT'});
});

test('offline Playwright A/B/C replacement role locator is exact and scoped to the active properties pane', async () => {
  const { chromium } = await import('file:///C:/Users/26484/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage();
    const replacement = String.fromCodePoint(0x66ff, 0x6362, 0x7d20, 0x6750);
    const fit = String.fromCodePoint(0x9002, 0x914d, 0x65b9, 0x5f0f);
    const shellName = String.fromCodePoint(0x751f, 0x6210, 0x540e, 0x7ee7, 0x7eed, 0x526a);
    const replacementMarkup = `<label><span>${replacement}</span><select><option>Asset A</option><option>Asset B</option></select></label>`;
    const html = `<section aria-label="${shellName}"><div class="editor-properties">${replacementMarkup}<label><span>${fit}</span><select><option>Cover</option></select></label></div><label><span>${replacement}</span><select><option>Outside properties</option></select></label></section><section aria-label="other editor">${replacementMarkup}</section>`;
    await page.setContent(html);

    const activeShell = page.locator(`section[aria-label="${shellName}"]`);
    const properties = activeShell.locator('.editor-properties');
    assert.equal(await properties.getByLabel(replacement, { exact:true }).count(), 0, 'old exact label locator must reproduce the failure');
    const control = properties.getByRole('combobox', { name:replacement, exact:true });
    assert.equal(await control.count(), 1, 'exact accessible role locator uniquely finds replacement control');
    assert.equal(await properties.getByRole('combobox', { name:fit, exact:true }).count(), 1, 'fit-mode select remains a distinct control');
    assert.equal(await activeShell.getByRole('combobox', { name:replacement, exact:true }).count(), 2, 'same-shell outside-properties control is excluded by properties scope');
    assert.equal(await page.locator('section[aria-label="other editor"]').getByRole('combobox', { name:replacement, exact:true }).count(), 1);
    assert.equal(await control.count(), 1, 'other-shell control cannot affect active pane locator');

    await properties.locator('label').first().evaluate((label, text) => label.insertAdjacentHTML('afterend', `<label><span>${text}</span><select><option>Duplicate</option></select></label>`), replacement);
    const duplicates = properties.getByRole('combobox', { name:replacement, exact:true });
    assert.equal(await duplicates.count(), 2, 'duplicate replacement controls fail the exactly-one contract');
    assert.notEqual(await duplicates.count(), 1);
  } finally {
    await browser.close();
  }
});
test('missing Supabase URL',()=>expectGate(()=>createReorderAdapter({...env,NEXT_PUBLIC_SUPABASE_URL:''}),'ENV_CONFIGURATION'));
test('invalid Supabase URL',()=>expectGate(()=>createReorderAdapter({...env,NEXT_PUBLIC_SUPABASE_URL:secret}),'SUPABASE_URL_VALIDATION'));
for(const gate of ['AUTH_HEALTH','AUTH_SIGN_IN','AUTH_GET_USER','BROWSER_LAUNCH','EDITOR_LOAD','OWNED_MEDIA_SETUP','PROJECT_GENERATION','PROJECT_OPEN','ASSET_REPLACEMENT','PROJECT_STATE_VALIDATION','OWNERSHIP_VALIDATION']) test(`real adapter mocked ${gate}`,async()=>{
  const {deps}=mockedAdapter(gate), a=await createReorderAdapter(env,deps);
  try {
    if(gate==='AUTH_HEALTH')return await expectGate(()=>a.reachability(),gate);
    if(gate.startsWith('AUTH_'))return await expectGate(()=>a.authenticate(),gate);
    await a.authenticate();
    if(['BROWSER_LAUNCH','EDITOR_LOAD'].includes(gate))return await expectGate(()=>a.openEditor(),gate);
    await a.openEditor();await expectGate(()=>a.fixture(),gate);
  } finally {await a.close();}
});
for(const substage of OWNED_MEDIA_SUBSTAGES) test(`owned-media safe substage ${substage}`,async()=>{
  const {deps}=mockedAdapter(substage), a=await createReorderAdapter(env,deps);
  try {
    await a.authenticate();await a.openEditor();
    await expectGate(()=>a.fixture(),'OWNED_MEDIA_SETUP','FIXTURE_SETUP_FAILED',substage);
  } finally {await a.close();}
});
test('auth health HTTP failure',async()=>{const {deps}=mockedAdapter('HTTP_FAILURE');const a=await createReorderAdapter(env,deps);await expectGate(()=>a.reachability(),'AUTH_HEALTH','HTTP_FAILURE');await a.close();});
test('three clip setup rejects zero generated clips',async()=>{
  const {deps}=mockedAdapter('THREE_CLIP_SETUP');
  // Return an empty generated timeline, while preserving uploads in project assets.
  const browser=await deps.playwright.chromium.launch();const context=await browser.newContext();const page=await context.newPage();
  const old=page.evaluate;page.evaluate=async fn=>{const result=await old(fn);if(typeof result==='string'){const p=JSON.parse(result);p.tracks.forEach(t=>{t.clips=[];});return JSON.stringify(p);}return result;};
  const a=await createReorderAdapter(env,deps);await a.authenticate();await a.openEditor();await expectGate(()=>a.fixture(),'THREE_CLIP_SETUP');await a.close();
});
test('remote version mismatch uses mocked metadata only',()=>expectGate(()=>verifyRemoteIdentity(env,async()=>({ok:true,json:async()=>({version:69})})),'REMOTE_VERSION'));
for(const [name,mutate,gate] of [
  ['version',s=>{s.adapter.identity=async()=>({version:69});},'REMOTE_VERSION'],
  ['hash',s=>{s.adapter.identity=async()=>({version:70,hashMismatches:1,fileCount:1});},'REMOTE_SOURCE_IDENTITY'],
  ['smoke',s=>{s.adapter.smoke=async()=>({pass:false,providerCalls:0});},'REMOTE_REORDER_SMOKE'],
  ['order',s=>{const c=JSON.parse(s.input.serializedContext);c.clips.reverse();s.input.serializedContext=JSON.stringify(c);},'SAFE_CONTEXT_ORDER'],
  ['missing target',s=>{s.input.expectedTargetClipId='missing';s.input.expectedClipId='missing';},'TARGET_REFERENCE_GATE'],
  ['missing reference',s=>{s.input.expectedReferenceClipId='missing';},'TARGET_REFERENCE_GATE'],
  ['equal target reference',s=>{s.input.expectedReferenceClipId=s.input.expectedTargetClipId;},'TARGET_REFERENCE_GATE'],
]) test(`runner diagnostic ${name}`,async()=>{const s=setup();mutate(s);await expectGate(()=>runReorderAcceptance(['--mode=preflight'],{},s.adapter),gate);assert.equal(s.clicks(),0);});
test('success plus failed cleanup blocks',async()=>{const s=setup();s.adapter.close=async()=>{throw raw();};await expectGate(()=>runReorderAcceptance(['--mode=preflight'],{},s.adapter),'CLEANUP');});
test('primary AUTH_HEALTH survives failed cleanup and CLI prints safe fields only',async()=>{
  const s=setup();s.adapter.reachability=async()=>{throw raw();};s.adapter.close=async()=>{throw raw();};
  const stdout=[],stderr=[];
  const exit=await runAcceptanceCLI(['--mode=preflight'],{},async()=>s.adapter,{log:v=>stdout.push(v),error:v=>stderr.push(v)});
  assert.equal(exit,1);assert.deepEqual(stdout,[]);
  assert.deepEqual(stderr,['REORDER_PREFLIGHT_BLOCKED\nGATE = AUTH_HEALTH\nCODE = NETWORK_UNREACHABLE\nPROVIDER_CALLS = 0\nRETRY = 0\nFALLBACK = NONE\nCLEANUP_STATUS = FAILED']);
});
test('success CLI returns zero and bounded success evidence',async()=>{const s=setup(),out=[];assert.equal(await runAcceptanceCLI(['--mode=preflight'],{},async()=>s.adapter,{log:v=>out.push(v),error:()=>assert.fail('unexpected stderr')}),0);assert.deepEqual(JSON.parse(out[0]),{result:'PREFLIGHT_PASS',providerCalls:0,remoteVersion:70,sourceIdentity:'PASS',remoteSmoke:'PASS',ownedFixture:'PASS',safeContextOrder:'A,B,C',target:'C',reference:'A'});assert.equal(s.clicks(),0);});
for(const thrown of [null,undefined,42,secret,{message:secret,stack:secret}])test(`unknown raw type ${typeof thrown} sanitized`,()=>expectGate(()=>gateScope('OWNED_MEDIA_SETUP',async()=>{throw thrown;}),'OWNED_MEDIA_SETUP'));
for(const [gate,code] of Object.entries(GATE_CODES))test(`allowlisted gate secret-leak test ${gate}`,async()=>{
  assert.ok(SAFE_CODES.includes(code));await expectGate(()=>gateScope(gate,async()=>{throw raw();}),gate);
  const stdout=[],stderr=[];const exit=await runAcceptanceCLI(['--mode=preflight'],{},async()=>gateScope(gate,async()=>{throw raw();}),{log:v=>stdout.push(v),error:v=>stderr.push(v)});
  assert.equal(exit,1);assert.deepEqual(stdout,[]);assert.equal(stderr[0],formatAcceptanceFailure(new SafeAcceptanceGateError(gate)));
});
for (const scenario of ['returned sign-in error','missing session','returned getUser error']) test(scenario,async()=>{
  const {deps}=mockedAdapter();const client=deps.supabase.createClient();deps.supabase.createClient=()=>client;
  if(scenario==='returned sign-in error')client.auth.signInWithPassword=async()=>({error:raw()});
  if(scenario==='missing session')client.auth.signInWithPassword=async()=>({error:null,data:{session:null}});
  if(scenario==='returned getUser error')client.auth.getUser=async()=>({error:raw()});
  const a=await createReorderAdapter(env,deps);
  await expectGate(()=>a.authenticate(),scenario==='returned sign-in error'?'AUTH_SIGN_IN':'AUTH_GET_USER');await a.close();
});
test('real smoke adapter sanitizes mocked HTTP/body failure',async()=>{
  const {deps}=mockedAdapter();deps.fetch=async()=>({status:403,json:async()=>({message:secret})});
  const a=await createReorderAdapter(env,deps);await a.authenticate();await expectGate(()=>a.smoke(),'REMOTE_REORDER_SMOKE');await a.close();
});
test('invalid diagnostic identifiers cannot enter serialized output',()=>{
  const e=new SafeAcceptanceGateError(secret,secret);
  assert.deepEqual(JSON.parse(JSON.stringify(e)),{gate:'INTERNAL',code:'INTERNAL_SAFE_FAILURE'});
  assert.ok(!formatAcceptanceFailure(e).includes(secret));
});
test('invalid owned-media substage cannot enter serialized output',async()=>{
  await assert.rejects(
    ()=>gateScope('OWNED_MEDIA_SETUP',async(_stage,substage)=>{substage(secret);throw raw();}),
    error=>{
      assert.equal(error.gate,'OWNED_MEDIA_SETUP');
      assert.equal(error.code,'FIXTURE_SETUP_FAILED');
      assert.equal(error.substage,undefined);
      assert.ok(!formatAcceptanceFailure(error).includes(secret));
      return true;
    },
  );
});
test('mode rejection never constructs an adapter',async()=>{
  for(const args of [[],['--mode=unknown'],['--mode=live'],['--mode=preflight','--debug']]) {
    const out=[];assert.equal(await runAcceptanceCLI(args,{},()=>assert.fail('adapter constructed'),{log:()=>assert.fail('stdout'),error:v=>out.push(v)}),1);
    assert.match(out[0],/GATE = MODE_VALIDATION\nCODE = INVALID_ARGUMENT/);
  }
});

function replacementProject({ reversedStorageOrder = false, ambiguousOrder = false } = {}) {
  const project = structuredClone(setup().project);
  project.assets.forEach((asset, index) => { asset.name = `medclip-reorder-${'ABC'[index]}.mp4`; });
  const track = project.tracks.find(item => item.type === 'video');
  if (reversedStorageOrder) track.clips.reverse();
  if (ambiguousOrder) track.clips[1].timelineStartMs = track.clips[0].timelineStartMs;
  return project;
}

function replacementPage({
  reversedStorageOrder = false,
  ambiguousOrder = false,
  renderedCountMismatch = false,
  visibleShellCount = 1,
  aClipLocateFailure = false,
  aClipSelectTimeout = false,
  aPageGlobalMisleadingSelection = false,
  aMultipleSelected = false,
  aPropertiesContextAbsent = false,
  aPropertiesContextState = '素材片段',
  aControlLocatorFailure = false,
  aReplaceSelectCount,
  outsideShellReplaceSelect = false,
  hiddenOutsideShellReplaceSelect = false,
  aControlAttachedTimeout = false,
  aControlVisibleTimeout = false,
  aControlEnabledTimeout = false,
  aControlReadyFailure = false,
  aOptionTimeout = false,
  aConfirmationTimeout = false,
  bClipLocateFailure = false,
  bClipSelectTimeout = false,
  bWrongOrdinal = false,
  bPageGlobalMisleadingSelection = false,
  bMultipleSelected = false,
  bPropertiesContextAbsent = false,
  bPropertiesContextState = String.fromCodePoint(0x7d20, 0x6750, 0x7247, 0x6bb5),
  bControlLocatorFailure = false,
  bReplaceSelectCount,
  bControlAttachedTimeout = false,
  bControlVisibleTimeout = false,
  bControlEnabledTimeout = false,
  bControlReadyFailure = false,
  bOptionTimeout = false,
  bConfirmationTimeout = false,
  bControlValueMismatch = false,
  cClipLocateFailure = false,
  cClipSelectTimeout = false,
  cWrongOrdinal = false,
  cPageGlobalMisleadingSelection = false,
  cMultipleSelected = false,
  cPropertiesContextAbsent = false,
  cPropertiesContextState = String.fromCodePoint(0x7d20, 0x6750, 0x7247, 0x6bb5),
  cControlLocatorFailure = false,
  cReplaceSelectCount,
  cControlAttachedTimeout = false,
  cControlVisibleTimeout = false,
  cControlEnabledTimeout = false,
  cControlReadyFailure = false,
  cOptionTimeout = false,
  cConfirmationTimeout = false,
  cControlValueMismatch = false,
  selectFailureIndex = -1,
  persistenceTimeoutIndex = -1,
  finalMismatch = false,
  closeFailure = false,
  postCloseMismatch = false,
  rawFailure = 'raw replacement verifier failure',
} = {}) {
  const project = replacementProject({ reversedStorageOrder, ambiguousOrder });
  const files = project.assets.map(asset => ({ name:asset.name }));
  const events = [];
  let selectedChronologicalIndex = -1;
  let selectedDomIndex = -1;
  let selectedReady = false;
  let controlEnabled = false;
  let controlReady = false;
  let optionReady = false;
  let controlConfirmed = false;
  let pending;
  let evaluateCalls = 0;
  const shellReplaceSelectCount = aReplaceSelectCount ?? (aControlLocatorFailure ? 2 : 1);
  const bShellReplaceSelectCount = bReplaceSelectCount ?? (bControlLocatorFailure ? 2 : shellReplaceSelectCount);
  const cShellReplaceSelectCount = cReplaceSelectCount ?? (cControlLocatorFailure ? 2 : shellReplaceSelectCount);
  const chronological = () => project.tracks.filter(track => ['video','broll'].includes(track.type))
    .flatMap(track => track.clips).sort((left,right) => left.timelineStartMs-right.timelineStartMs);
  const clipCollection = scope => ({
    nth(index) { return {
        async waitFor(options) {
          assert.deepEqual(options, { state:'visible', timeout:30_000 });
          assert.equal(scope, 'shell');
          const label = 'ABC'[index];
          events.push(`clip-locate:${label}`);
          if ((index === 0 && aClipLocateFailure) || (index === 1 && bClipLocateFailure) || (index === 2 && cClipLocateFailure)) throw new Error(rawFailure);
        },
        async click() {
          assert.equal(scope, 'shell');
          const selectedId = project.tracks.find(track => track.type === 'video').clips[index].id;
          selectedChronologicalIndex = chronological().findIndex(clip => clip.id === selectedId);
          selectedDomIndex = ((index === 1 && bWrongOrdinal) || (index === 2 && cWrongOrdinal)) ? index + 1 : index;
          selectedReady = false;
          controlEnabled = controlReady = optionReady = controlConfirmed = false;
          events.push(`select-clip:${'ABC'[selectedChronologicalIndex]}`);
        },
        async dispatchEvent(event) {
          assert.equal(event, 'click');
          const selectedId = project.tracks.find(track => track.type === 'video').clips[index].id;
          selectedChronologicalIndex = chronological().findIndex(clip => clip.id === selectedId);
          selectedDomIndex = index;
          events.push(`select-clip:${'ABC'[selectedChronologicalIndex]}`);
        },
      }; },
  });
  const replaceControl = scope => ({
    async count() {
      assert.equal(scope, 'shell');
      assert.notEqual(selectedChronologicalIndex, -1, 'replace control locator queried before intended clip selection');
      events.push(`control-locator:${'ABC'[selectedChronologicalIndex]}`);
      return selectedChronologicalIndex === 1 ? bShellReplaceSelectCount
        : selectedChronologicalIndex === 2 ? cShellReplaceSelectCount : shellReplaceSelectCount;
    },
    async waitFor(waitOptions) {
      assert.equal(scope, 'shell');
      assert.notEqual(selectedChronologicalIndex, -1, 'replace control queried before intended clip selection');
      assert.equal(waitOptions.timeout, 30_000);
      assert.ok(['attached','visible'].includes(waitOptions.state));
      const label = 'ABC'[selectedChronologicalIndex];
      events.push(`control-${waitOptions.state}:${label}`);
      if (waitOptions.state === 'attached' && ((label === 'A' && aControlAttachedTimeout) || (label === 'B' && bControlAttachedTimeout) || (label === 'C' && cControlAttachedTimeout))) throw new Error(rawFailure);
      if (waitOptions.state === 'visible' && ((label === 'A' && aControlVisibleTimeout) || (label === 'B' && bControlVisibleTimeout) || (label === 'C' && cControlVisibleTimeout))) throw new Error(rawFailure);
    },
    async selectOption(assetId) {
      const index = project.assets.findIndex(asset => asset.id === assetId);
      assert.equal(index, selectedChronologicalIndex);
      if (index < 3) {
        assert.equal(scope, 'shell');
        assert.equal(selectedChronologicalIndex, index, 'selectOption before intended clip selected');
        assert.ok(controlReady, 'selectOption before control ready');
        assert.ok(optionReady, 'selectOption before option ready');
      }
      events.push(`replace:${'ABC'[index]}`);
      if (index === selectFailureIndex) throw new Error(rawFailure);
      pending = { index, assetId };
    },
  });
  const activeShell = {
    async count() {
      events.push('active-shell-count');
      return visibleShellCount;
    },
    locator(selector) {
      if (selector === '.timeline-clip') return clipCollection('shell');
      assert.equal(selector, '.editor-properties');
      return {
        getByRole(role, options) {
          assert.equal(role, 'combobox');
          assert.deepEqual(options, { name:'\u66ff\u6362\u7d20\u6750', exact:true });
          events.push(`role-locator:${'ABC'[selectedChronologicalIndex]}`);
          return replaceControl('shell');
        },
      };
    },
    getByLabel() { assert.fail('A replacement must use the properties-scoped role locator'); },
  };
  const page = {
    locator(selector) {
      if (selector === `${AUTO_OPEN_EDITOR_SELECTOR}:visible`) return activeShell;
      assert.equal(selector, '.timeline-clip');
      return clipCollection('page');
    },
    getByLabel() { assert.fail('asset replacement must not use the legacy exact-label locator'); },
    getByRole(role, options) {
      assert.equal(role, 'button'); assert.deepEqual(options, { name:'关闭编辑器', exact:true });
      return { async click() {
        events.push('close');
        if (closeFailure) throw new Error(rawFailure);
        if (postCloseMismatch) chronological()[1].assetId = project.assets[0].id;
      } };
    },
    async waitForFunction(predicate, expected, options) {
      if (predicate === assetAInteractionCondition && expected.kind === 'control-ready') {
        assert.ok(options.timeout > 0 && options.timeout <= 30_000);
      } else {
        assert.equal(options.timeout, 30_000);
      }
      if (predicate === assetAInteractionCondition) {
        assert.equal(expected.shellSelector, AUTO_OPEN_EDITOR_SELECTOR);
        if (expected.kind === 'active-shell') {
          events.push('active-shell-wait');
          if (visibleShellCount !== 1) throw new Error(rawFailure);
          events.push('active-shell-resolved');
          return;
        }
        if (expected.kind === 'selected-clip') {
          const label = 'ABC'[expected.index];
          events.push(`selected-wait:${label}`);
          assert.equal(selectedDomIndex, expected.index);
          if ((expected.index === 0 && (aClipSelectTimeout || aPageGlobalMisleadingSelection || aMultipleSelected))
            || (expected.index === 1 && (bClipSelectTimeout || bPageGlobalMisleadingSelection || bMultipleSelected))
            || (expected.index === 2 && (cClipSelectTimeout || cPageGlobalMisleadingSelection || cMultipleSelected))) throw new Error(rawFailure);
          selectedReady = true;
          events.push(`selected:${label}`);
          return;
        }
        if (expected.kind === 'properties-context') {
          const label = 'ABC'[selectedChronologicalIndex];
          events.push(`properties-context-wait:${label}`);
          assert.ok(selectedReady);
          const materialState = String.fromCodePoint(0x7d20, 0x6750, 0x7247, 0x6bb5);
          if ((label === 'A' && (aPropertiesContextAbsent || aPropertiesContextState !== materialState))
            || (label === 'B' && (bPropertiesContextAbsent || bPropertiesContextState !== materialState))
            || (label === 'C' && (cPropertiesContextAbsent || cPropertiesContextState !== materialState))) throw new Error(rawFailure);
          events.push(`properties-context:${label}`);
          return;
        }
        if (expected.kind === 'replace-control-count') {
          const label = 'ABC'[selectedChronologicalIndex];
          events.push(`control-locator-wait:${label}`);
          assert.ok(selectedReady);
          assert.equal(expected.count, 1);
          if ((label === 'A' ? shellReplaceSelectCount : label === 'B' ? bShellReplaceSelectCount : cShellReplaceSelectCount) !== 1) throw new Error(rawFailure);
          events.push(`control-locator-ready:${label}`);
          return;
        }
        if (expected.kind === 'control-ready') {
          const label = 'ABC'[selectedChronologicalIndex];
          events.push(`control-ready-wait:${label}`);
          assert.ok(controlEnabled);
          if ((label === 'A' && aControlReadyFailure) || (label === 'B' && bControlReadyFailure) || (label === 'C' && cControlReadyFailure)) throw new Error(rawFailure);
          controlReady = true;
          events.push(`control-ready:${label}`);
          return;
        }
        if (expected.kind === 'control-enabled') {
          const label = 'ABC'[selectedChronologicalIndex];
          events.push(`control-enabled-wait:${label}`);
          assert.ok(selectedReady);
          if ((label === 'A' && aControlEnabledTimeout) || (label === 'B' && bControlEnabledTimeout) || (label === 'C' && cControlEnabledTimeout)) throw new Error(rawFailure);
          controlEnabled = true;
          events.push(`control-enabled:${label}`);
          return;
        }
        if (expected.kind === 'option-ready') {
          const label = 'ABC'[selectedChronologicalIndex];
          events.push(`option-wait:${label}`);
          assert.ok(controlReady);
          assert.equal(expected.assetId, project.assets[selectedChronologicalIndex].id);
          if ((label === 'A' && aOptionTimeout) || (label === 'B' && bOptionTimeout) || (label === 'C' && cOptionTimeout)) throw new Error(rawFailure);
          optionReady = true;
          events.push(`option-ready:${label}`);
          return;
        }
        assert.equal(expected.kind, 'control-value');
        const label = 'ABC'[selectedChronologicalIndex];
        events.push(`control-confirmation-wait:${label}`);
        if ((label === 'B' && bControlValueMismatch) || (label === 'C' && cControlValueMismatch)) throw new Error(rawFailure);
        assert.deepEqual(pending, { index:selectedChronologicalIndex, assetId:expected.assetId });
        if ((label === 'A' && aConfirmationTimeout) || (label === 'B' && bConfirmationTimeout) || (label === 'C' && cConfirmationTimeout)) throw new Error(rawFailure);
        controlConfirmed = true;
        events.push(`control-confirmed:${label}`);
        return;
      }
      assert.equal(predicate, persistedReplacementCondition);
      if (expected.kind === 'rendered-count') {
        events.push('rendered-count');
        if (renderedCountMismatch) throw new Error(rawFailure);
        assert.equal(expected.clipCount, chronological().length);
        return;
      }
      if (expected.kind === 'binding') {
        const label = 'ABC'[expected.index];
        events.push(`persistence-wait:${label}`);
        if (expected.index < 3) assert.ok(controlConfirmed, 'persistence wait before control confirmation');
        assert.deepEqual(pending, { index:expected.index, assetId:expected.assetId });
        if (expected.index === persistenceTimeoutIndex) throw new Error(rawFailure);
        const clip = chronological()[expected.index];
        assert.equal(clip.id, expected.clipId);
        clip.assetId = expected.assetId;
        pending = undefined;
        events.push(`persisted:${label}`);
        return;
      }
      assert.equal(expected.kind, 'bindings');
      events.push('final-bindings-wait');
      assert.deepEqual(chronological().map(clip => clip.assetId), expected.assetIds);
    },
    async evaluate() {
      evaluateCalls++;
      if (finalMismatch && evaluateCalls === 8) chronological()[1].assetId = project.assets[0].id;
      return JSON.stringify(project);
    },
  };
  return { page, files, events, project };
}

async function runReplacementScenario(options = {}) {
  const scenario = replacementPage(options);
  const substages = [];
  const result = await gateScope('ASSET_REPLACEMENT', async (_stage, substage) => (
    replaceChronologicalClipAssetsAndClose(scenario.page, scenario.files, value => {
      substages.push(value); substage(value);
    })
  ));
  return { ...scenario, substages, result };
}

async function expectReplacementFailure(options, expectedSubstage) {
  const scenario = replacementPage(options);
  const substages = [];
  await assert.rejects(
    () => gateScope('ASSET_REPLACEMENT', async (_stage, substage) => (
      replaceChronologicalClipAssetsAndClose(scenario.page, scenario.files, value => {
        substages.push(value); substage(value);
      })
    )),
    error => {
      assert.ok(error instanceof SafeAcceptanceGateError);
      assert.equal(error.gate, 'ASSET_REPLACEMENT');
      assert.equal(error.code, 'PROJECT_SETUP_FAILED');
      assert.equal(error.substage, expectedSubstage);
      return true;
    },
  );
  return { ...scenario, substages };
}

test('clip-order resolution succeeds with exactly three chronological persisted and rendered clips', async () => {
  const scenario = await runReplacementScenario({ reversedStorageOrder:true });
  assert.equal(scenario.result.clipCount, 3);
  assert.deepEqual(scenario.events.slice(0, 4), ['rendered-count','active-shell-wait','active-shell-resolved','active-shell-count']);
  assert.ok(scenario.events.findIndex(event => event.startsWith('active-shell-count')) < scenario.events.findIndex(event => event.startsWith('clip-locate:')));
  assert.equal(scenario.substages[0], 'CLIP_ORDER_RESOLUTION');
});

test('clip-order resolution failure is safely attributed', async () => {
  const scenario = await expectReplacementFailure({ ambiguousOrder:true }, 'CLIP_ORDER_RESOLUTION');
  assert.deepEqual(scenario.events, []);
});

test('rendered and persisted clip-count mismatch is safely attributed', async () => {
  const scenario = await expectReplacementFailure({ renderedCountMismatch:true }, 'CLIP_ORDER_RESOLUTION');
  assert.deepEqual(scenario.events, ['rendered-count']);
});

test('browser persistence predicate checks rendered count and chronological bindings', () => {
  const project = replacementProject({ reversedStorageOrder:true });
  const clips = project.tracks[0].clips.slice().sort((left,right) => left.timelineStartMs-right.timelineStartMs);
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  try {
    globalThis.window = { localStorage:{ getItem:() => JSON.stringify(project) } };
    globalThis.document = { querySelectorAll:selector => {
      assert.equal(selector, '.timeline-clip');
      return Array.from({ length:3 });
    } };
    assert.equal(persistedReplacementCondition({ kind:'rendered-count', clipCount:3 }), true);
    assert.equal(persistedReplacementCondition({ kind:'binding', index:1, clipId:clips[1].id, assetId:clips[1].assetId }), true);
    assert.equal(persistedReplacementCondition({ kind:'bindings', clipIds:clips.map(clip => clip.id), assetIds:clips.map(clip => clip.assetId) }), true);
    assert.equal(persistedReplacementCondition({ kind:'binding', index:1, clipId:clips[1].id, assetId:project.assets[0].id }), false);
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});

function installAInteractionDom({
  visibleShellCount = 1,
  hiddenShellCount = 0,
  selectedIndexes = [0],
  replaceSelectCount = 1,
  propertiesContext = true,
  propertiesState = '素材片段',
  propertiesPaneAbsent = false,
  outsideSelected = false,
  outsideReplaceSelect = false,
} = {}) {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const optionValue = 'safe-option';
  const visibleNode = extra => ({
    ...extra,
    style:{ display:'block', visibility:'visible' },
    getBoundingClientRect:() => ({ width:120, height:32 }),
  });
  const select = visibleNode({
    disabled:false,
    value:optionValue,
    options:[{ value:optionValue }],
  });
  const label = currentSelect => ({
    children:[{ tagName:'SPAN', textContent:'替换素材' }, currentSelect],
    querySelectorAll:selector => selector === 'select' ? [currentSelect] : [],
  });
  const clips = Array.from({ length:3 }, (_, index) => ({
    classList:{ contains:value => value === 'selected' && selectedIndexes.includes(index) },
  }));
  const libraryTitle = visibleNode({ children:[{ tagName:'B', textContent:'素材库' }, { tagName:'SPAN', textContent:'3 项' }] });
  const propertiesTitle = visibleNode({ children:propertiesContext ? [
    { tagName:'B', textContent:'属性' }, { tagName:'SPAN', textContent:propertiesState },
  ] : [] });
  const propertiesPane = propertiesPaneAbsent ? null : { title:propertiesTitle };
  const editorTitlesInDomOrder = [libraryTitle, ...(!propertiesPaneAbsent ? [propertiesTitle] : [])];
  const makeShell = ({ visible = true, selects = [] } = {}) => ({
    style:{ display:visible ? 'block' : 'none', visibility:'visible' },
    getBoundingClientRect:() => ({ width:visible ? 800 : 0, height:visible ? 600 : 0 }),
    querySelectorAll:selector => selector === '.timeline-clip' ? clips : selector === 'label' ? selects.map(label) : [],
    querySelector:selector => {
      if (selector === '.editor-pane-title') return editorTitlesInDomOrder[0] ?? null;
      if (selector === '.editor-properties .editor-pane-title') return propertiesPane?.title ?? null;
      return null;
    },
    editorTitlesInDomOrder,
  });
  const activeShell = makeShell({ selects:Array.from({ length:replaceSelectCount }, () => select) });
  const shells = [activeShell,
    ...Array.from({ length:Math.max(0, visibleShellCount - 1) }, () => makeShell({ selects:[select] })),
    ...Array.from({ length:hiddenShellCount }, () => makeShell({ visible:false, selects:[select] })),
  ];
  if (visibleShellCount === 0) shells.shift();
  const outsideClip = { classList:{ contains:value => value === 'selected' && outsideSelected } };
  const outsideLabels = outsideReplaceSelect ? [label(select)] : [];
  globalThis.window = { getComputedStyle:node => node.style ?? { display:'block', visibility:'visible' } };
  globalThis.document = { querySelectorAll:selector => {
    if (selector === AUTO_OPEN_EDITOR_SELECTOR) return shells;
    if (selector === '.timeline-clip') return [outsideClip, ...clips];
    if (selector === 'label') return outsideLabels;
    return [];
  } };
  return {
    optionValue,
    select,
    shell:activeShell,
    restore() {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    },
  };
}

function checkAInteraction(options, expected) {
  const dom = installAInteractionDom(options);
  try { return assetAInteractionCondition({ shellSelector:AUTO_OPEN_EDITOR_SELECTOR, ...expected }); }
  finally { dom.restore(); }
}

test('active editor shell predicate accepts exactly one visible shell', () => {
  assert.equal(checkAInteraction({}, { kind:'active-shell' }), true);
});

test('active editor shell predicate safely rejects zero visible shells', () => {
  assert.equal(checkAInteraction({ visibleShellCount:0 }, { kind:'active-shell' }), false);
});

test('active editor shell predicate safely rejects multiple visible shells', () => {
  assert.equal(checkAInteraction({ visibleShellCount:2 }, { kind:'active-shell' }), false);
});

test('browser A interaction predicate requires intended shell clip to be solely selected', () => {
  assert.equal(checkAInteraction({ selectedIndexes:[0] }, { kind:'selected-clip', index:0 }), true);
  assert.equal(checkAInteraction({ selectedIndexes:[1], outsideSelected:true }, { kind:'selected-clip', index:0 }), false);
  assert.equal(checkAInteraction({ selectedIndexes:[0,1] }, { kind:'selected-clip', index:0 }), false);
  assert.equal(checkAInteraction({ selectedIndexes:[1] }, { kind:'selected-clip', index:0 }), false);
});

test('browser A interaction predicate verifies shell properties and exact replace-control count', () => {
  assert.equal(checkAInteraction({}, { kind:'properties-context' }), true);
  assert.equal(checkAInteraction({ propertiesPaneAbsent:true }, { kind:'properties-context' }), false);
  assert.equal(checkAInteraction({ propertiesState:'未选择' }, { kind:'properties-context' }), false);
  assert.equal(checkAInteraction({ propertiesState:'字幕' }, { kind:'properties-context' }), false);
  assert.equal(checkAInteraction({ replaceSelectCount:0 }, { kind:'replace-control-count', count:1 }), false);
  assert.equal(checkAInteraction({ replaceSelectCount:1 }, { kind:'replace-control-count', count:1 }), true);
  assert.equal(checkAInteraction({ replaceSelectCount:2 }, { kind:'replace-control-count', count:1 }), false);
  assert.equal(checkAInteraction({ replaceSelectCount:0, outsideReplaceSelect:true }, { kind:'replace-control-count', count:1 }), false);
  assert.equal(checkAInteraction({ replaceSelectCount:0, hiddenShellCount:1 }, { kind:'replace-control-count', count:1 }), false);
});

test('A_PROPERTIES_CONTEXT targets the second pane title when the material library title comes first', () => {
  const dom = installAInteractionDom({ propertiesState:'素材片段' });
  try {
    const [libraryTitle, propertiesTitle] = dom.shell.editorTitlesInDomOrder;
    assert.equal(dom.shell.querySelector('.editor-pane-title'), libraryTitle);
    assert.notEqual(libraryTitle, propertiesTitle);
    assert.equal(dom.shell.querySelector('.editor-properties .editor-pane-title'), propertiesTitle);
    assert.equal(assetAInteractionCondition({ kind:'properties-context', shellSelector:AUTO_OPEN_EDITOR_SELECTOR }), true);
  } finally { dom.restore(); }
});

test('browser A interaction predicate keeps enabled, ready, option, and value checks shell-scoped', () => {
  const dom = installAInteractionDom();
  try {
    const expected = kind => ({ kind, shellSelector:AUTO_OPEN_EDITOR_SELECTOR });
    assert.equal(assetAInteractionCondition(expected('control-enabled')), true);
    assert.equal(assetAInteractionCondition(expected('control-ready')), true);
    assert.equal(assetAInteractionCondition({ ...expected('option-ready'), assetId:dom.optionValue }), true);
    assert.equal(assetAInteractionCondition({ ...expected('control-value'), assetId:dom.optionValue }), true);
    dom.select.disabled = true;
    assert.equal(assetAInteractionCondition(expected('control-enabled')), false);
    assert.equal(assetAInteractionCondition(expected('control-ready')), false);
  } finally { dom.restore(); }
});

for (const [index, label] of ['A','B','C'].entries()) test(`asset ${label} replacement succeeds through the production control`, async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.indexOf(`replace:${label}`) < scenario.events.indexOf(`persisted:${label}`));
  assert.ok(scenario.substages.includes(`${label}_SELECT_OPTION`));
  assert.equal(scenario.project.tracks[0].clips[index].assetId, scenario.project.assets[index].id);
});

for (const [index, label] of ['A','B','C'].entries()) test(`asset ${label} control failure has its allowlisted substage`, async () => {
  const scenario = await expectReplacementFailure({ selectFailureIndex:index }, `${label}_SELECT_OPTION`);
  assert.ok(scenario.events.includes(`replace:${label}`));
  assert.ok(!scenario.events.includes(`persistence-wait:${label}`));
});

test('A_CLIP_LOCATE succeeds before any selection action', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.indexOf('clip-locate:A') < scenario.events.indexOf('select-clip:A'));
  assert.ok(scenario.substages.includes('A_CLIP_LOCATE'));
});

test('A_CLIP_LOCATE safely rejects zero visible active editor shells', async () => {
  const scenario = await expectReplacementFailure({ visibleShellCount:0 }, 'A_CLIP_LOCATE');
  assert.deepEqual(scenario.events.slice(-1), ['active-shell-wait']);
  assert.ok(!scenario.events.includes('clip-locate:A'));
});

test('A_CLIP_LOCATE safely rejects multiple visible active editor shells', async () => {
  const scenario = await expectReplacementFailure({ visibleShellCount:2 }, 'A_CLIP_LOCATE');
  assert.deepEqual(scenario.events.slice(-1), ['active-shell-wait']);
  assert.ok(!scenario.events.includes('clip-locate:A'));
});

test('A_CLIP_LOCATE failure is safely attributed', async () => {
  const scenario = await expectReplacementFailure({ aClipLocateFailure:true }, 'A_CLIP_LOCATE');
  assert.ok(scenario.events.includes('clip-locate:A'));
  assert.ok(!scenario.events.includes('select-clip:A'));
});

test('A_CLIP_SELECT confirms the intended positional clip', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.indexOf('select-clip:A') < scenario.events.indexOf('selected:A'));
  assert.ok(scenario.substages.includes('A_CLIP_SELECT'));
});

test('A_CLIP_SELECT timeout blocks all select interaction', async () => {
  const scenario = await expectReplacementFailure({ aClipSelectTimeout:true }, 'A_CLIP_SELECT');
  assert.ok(scenario.events.includes('selected-wait:A'));
  assert.ok(!scenario.events.includes('control-attached:A'));
  assert.ok(!scenario.events.includes('replace:A'));
});

test('intended clip not selected in the active shell fails A_CLIP_SELECT', async () => {
  const scenario = await expectReplacementFailure({ aClipSelectTimeout:true }, 'A_CLIP_SELECT');
  assert.ok(scenario.events.includes('selected-wait:A'));
  assert.ok(!scenario.events.includes('properties-context-wait:A'));
});

test('page-global misleading selection does not satisfy A_CLIP_SELECT', async () => {
  const scenario = await expectReplacementFailure({ aPageGlobalMisleadingSelection:true }, 'A_CLIP_SELECT');
  assert.ok(scenario.events.includes('selected-wait:A'));
  assert.ok(!scenario.events.includes('properties-context-wait:A'));
});

test('two selected clips in the active shell fail A_CLIP_SELECT', async () => {
  const scenario = await expectReplacementFailure({ aMultipleSelected:true }, 'A_CLIP_SELECT');
  assert.ok(scenario.events.includes('selected-wait:A'));
  assert.ok(!scenario.events.includes('properties-context-wait:A'));
});

test('A_PROPERTIES_CONTEXT appears after sole A selection', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.indexOf('selected:A') < scenario.events.indexOf('properties-context:A'));
  assert.ok(scenario.substages.includes('A_PROPERTIES_CONTEXT'));
});

test('absent clip properties context fails at A_PROPERTIES_CONTEXT', async () => {
  const scenario = await expectReplacementFailure({ aPropertiesContextAbsent:true }, 'A_PROPERTIES_CONTEXT');
  assert.ok(scenario.events.includes('properties-context-wait:A'));
  assert.ok(!scenario.events.includes('control-locator-wait:A'));
});

for (const state of ['未选择','字幕']) test(`A_PROPERTIES_CONTEXT rejects properties state ${state}`, async () => {
  const scenario = await expectReplacementFailure({ aPropertiesContextState:state }, 'A_PROPERTIES_CONTEXT');
  assert.ok(scenario.events.includes('properties-context-wait:A'));
  assert.ok(!scenario.events.includes('control-locator-wait:A'));
});

test('A_REPLACE_CONTROL_LOCATOR resolves exactly one labelled select', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.includes('control-locator:A'));
  assert.ok(scenario.substages.includes('A_REPLACE_CONTROL_LOCATOR'));
});

test('A_REPLACE_CONTROL_LOCATOR failure short-circuits attached-state evaluation', async () => {
  const scenario = await expectReplacementFailure({ aControlLocatorFailure:true }, 'A_REPLACE_CONTROL_LOCATOR');
  assert.ok(scenario.events.includes('control-locator-wait:A'));
  assert.ok(!scenario.events.includes('control-attached:A'));
});

test('zero replacement selects remaining fails at A_REPLACE_CONTROL_LOCATOR', async () => {
  const scenario = await expectReplacementFailure({ aReplaceSelectCount:0 }, 'A_REPLACE_CONTROL_LOCATOR');
  assert.ok(scenario.events.includes('control-locator-wait:A'));
  assert.ok(!scenario.events.includes('control-attached:A'));
});

test('replacement select outside the active shell cannot satisfy locator uniqueness', async () => {
  const scenario = await expectReplacementFailure({ aReplaceSelectCount:0, outsideShellReplaceSelect:true }, 'A_REPLACE_CONTROL_LOCATOR');
  assert.ok(scenario.events.includes('control-locator-wait:A'));
});

test('hidden stale replacement select outside the active shell cannot satisfy locator uniqueness', async () => {
  const scenario = await expectReplacementFailure({ aReplaceSelectCount:0, hiddenOutsideShellReplaceSelect:true }, 'A_REPLACE_CONTROL_LOCATOR');
  assert.ok(scenario.events.includes('control-locator-wait:A'));
});

test('A_REPLACE_CONTROL_ATTACHED confirms the locator becomes attached', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.indexOf('control-locator:A') < scenario.events.indexOf('control-attached:A'));
  assert.ok(scenario.substages.includes('A_REPLACE_CONTROL_ATTACHED'));
});

test('A_REPLACE_CONTROL_ATTACHED timeout short-circuits visibility evaluation', async () => {
  const scenario = await expectReplacementFailure({ aControlAttachedTimeout:true }, 'A_REPLACE_CONTROL_ATTACHED');
  assert.ok(scenario.events.includes('control-attached:A'));
  assert.ok(!scenario.events.includes('control-visible:A'));
});

test('A_REPLACE_CONTROL_VISIBLE confirms the attached control becomes visible', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.indexOf('control-attached:A') < scenario.events.indexOf('control-visible:A'));
  assert.ok(scenario.substages.includes('A_REPLACE_CONTROL_VISIBLE'));
});

test('A_REPLACE_CONTROL_VISIBLE timeout short-circuits enabled-state evaluation', async () => {
  const scenario = await expectReplacementFailure({ aControlVisibleTimeout:true }, 'A_REPLACE_CONTROL_VISIBLE');
  assert.ok(scenario.events.includes('control-visible:A'));
  assert.ok(!scenario.events.includes('control-enabled-wait:A'));
});

test('A_REPLACE_CONTROL_ENABLED confirms the visible control becomes enabled', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.indexOf('control-visible:A') < scenario.events.indexOf('control-enabled:A'));
  assert.ok(scenario.substages.includes('A_REPLACE_CONTROL_ENABLED'));
});

test('A_REPLACE_CONTROL_ENABLED timeout short-circuits final readiness evaluation', async () => {
  const scenario = await expectReplacementFailure({ aControlEnabledTimeout:true }, 'A_REPLACE_CONTROL_ENABLED');
  assert.ok(scenario.events.includes('control-enabled-wait:A'));
  assert.ok(!scenario.events.includes('control-ready-wait:A'));
});

test('A_REPLACE_CONTROL_READY preserves the final verifier-specific predicate', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.indexOf('control-enabled:A') < scenario.events.indexOf('control-ready:A'));
  assert.ok(scenario.substages.includes('A_REPLACE_CONTROL_READY'));
});

test('A_REPLACE_CONTROL_READY failure blocks option and select evaluation', async () => {
  const scenario = await expectReplacementFailure({ aControlReadyFailure:true }, 'A_REPLACE_CONTROL_READY');
  assert.ok(scenario.events.includes('control-ready-wait:A'));
  assert.ok(!scenario.events.includes('option-wait:A'));
  assert.ok(!scenario.events.includes('replace:A'));
});

test('replace-control predicates stop at the first failure', async () => {
  const cases = [
    [{ aControlLocatorFailure:true }, 'A_REPLACE_CONTROL_LOCATOR', 'control-attached:A'],
    [{ aControlAttachedTimeout:true }, 'A_REPLACE_CONTROL_ATTACHED', 'control-visible:A'],
    [{ aControlVisibleTimeout:true }, 'A_REPLACE_CONTROL_VISIBLE', 'control-enabled-wait:A'],
    [{ aControlEnabledTimeout:true }, 'A_REPLACE_CONTROL_ENABLED', 'control-ready-wait:A'],
    [{ aControlReadyFailure:true }, 'A_REPLACE_CONTROL_READY', 'option-wait:A'],
  ];
  for (const [options, substage, forbiddenEvent] of cases) {
    const scenario = await expectReplacementFailure(options, substage);
    assert.ok(!scenario.events.includes(forbiddenEvent));
  }
});

test('A_OPTION_WAIT confirms the exact asset-ID option', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.indexOf('control-ready:A') < scenario.events.indexOf('option-wait:A'));
  assert.ok(scenario.events.indexOf('option-ready:A') < scenario.events.indexOf('replace:A'));
  assert.ok(scenario.substages.includes('A_OPTION_WAIT'));
});

test('A_OPTION_WAIT timeout blocks selectOption', async () => {
  const scenario = await expectReplacementFailure({ aOptionTimeout:true }, 'A_OPTION_WAIT');
  assert.ok(scenario.events.includes('option-wait:A'));
  assert.ok(!scenario.events.includes('replace:A'));
});

test('A_SELECT_OPTION runs only after all deterministic preconditions', async () => {
  const scenario = await runReplacementScenario();
  for (const prerequisite of [
    'selected:A','control-locator:A','control-attached:A','control-visible:A',
    'control-enabled:A','control-ready:A','option-ready:A',
  ]) {
    assert.ok(scenario.events.indexOf(prerequisite) < scenario.events.indexOf('replace:A'));
  }
  assert.ok(scenario.substages.includes('A_SELECT_OPTION'));
});

test('A_SELECT_OPTION failure is safely attributed and never reaches persistence', async () => {
  const scenario = await expectReplacementFailure({ selectFailureIndex:0 }, 'A_SELECT_OPTION');
  assert.ok(scenario.events.includes('replace:A'));
  assert.ok(!scenario.events.includes('control-confirmation-wait:A'));
  assert.ok(!scenario.events.includes('persistence-wait:A'));
});

test('A_CONTROL_CONFIRMATION succeeds before persisted-state confirmation', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.indexOf('control-confirmed:A') < scenario.events.indexOf('persistence-wait:A'));
  assert.ok(scenario.substages.includes('A_CONTROL_CONFIRMATION'));
});

test('A_CONTROL_CONFIRMATION timeout blocks persisted-state confirmation', async () => {
  const scenario = await expectReplacementFailure({ aConfirmationTimeout:true }, 'A_CONTROL_CONFIRMATION');
  assert.ok(scenario.events.includes('control-confirmation-wait:A'));
  assert.ok(!scenario.events.includes('persistence-wait:A'));
});

test('B clip locator and sole-selection contract are shell scoped and follow A persistence', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.indexOf('persisted:A') < scenario.events.indexOf('active-shell-wait', scenario.events.indexOf('persisted:A')));
  assert.ok(scenario.events.indexOf('active-shell-count', scenario.events.indexOf('persisted:A')) < scenario.events.indexOf('clip-locate:B'));
  assert.ok(scenario.events.indexOf('select-clip:B') < scenario.events.indexOf('selected:B'));
  assert.ok(scenario.substages.includes('B_CLIP_LOCATE'));
  assert.ok(scenario.substages.includes('B_CLIP_SELECT'));
});

test('B clip locate failure is safely attributed', async () => {
  const scenario = await expectReplacementFailure({ bClipLocateFailure:true }, 'B_CLIP_LOCATE');
  assert.ok(scenario.events.includes('clip-locate:B'));
  assert.ok(!scenario.events.includes('select-clip:B'));
});

for (const [options, description] of [
  [{ bClipSelectTimeout:true }, 'selection timeout'],
  [{ bPageGlobalMisleadingSelection:true }, 'page-global misleading selected clip'],
  [{ bMultipleSelected:true }, 'multi-selected clips'],
  [{ bWrongOrdinal:true }, 'wrong ordinal'],
]) test(`B_CLIP_SELECT rejects ${description}`, async () => {
  const scenario = await expectReplacementFailure(options, 'B_CLIP_SELECT');
  assert.ok(scenario.events.includes('selected-wait:B'));
  assert.ok(!scenario.events.includes('properties-context-wait:B'));
});

test('B_PROPERTIES_CONTEXT passes only for 素材片段', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.indexOf('selected:B') < scenario.events.indexOf('properties-context:B'));
  assert.ok(scenario.substages.includes('B_PROPERTIES_CONTEXT'));
});

for (const [options, description] of [
  [{ bPropertiesContextAbsent:true }, 'absent properties pane'],
  [{ bPropertiesContextState:String.fromCodePoint(0x672a, 0x9009, 0x62e9) }, 'unselected state'],
  [{ bPropertiesContextState:String.fromCodePoint(0x5b57, 0x5e55) }, 'subtitle state'],
]) test(`B_PROPERTIES_CONTEXT rejects ${description}`, async () => {
  const scenario = await expectReplacementFailure(options, 'B_PROPERTIES_CONTEXT');
  assert.ok(scenario.events.includes('properties-context-wait:B'));
  assert.ok(!scenario.events.includes('control-locator-wait:B'));
});

test('B resolves the exact properties-scoped combobox and never uses legacy getByLabel', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.indexOf('role-locator:B') < scenario.events.indexOf('control-locator:B'));
  assert.ok(scenario.substages.includes('B_REPLACE_CONTROL_LOCATOR'));
  assert.ok(!scenario.events.includes('legacy-label:B'));
});

test('B duplicate replacement controls fail locator uniqueness', async () => {
  const scenario = await expectReplacementFailure({ bControlLocatorFailure:true }, 'B_REPLACE_CONTROL_LOCATOR');
  assert.ok(scenario.events.includes('control-locator-wait:B'));
  assert.ok(!scenario.events.includes('control-attached:B'));
});

for (const [options, substage, nextEvent] of [
  [{ bControlAttachedTimeout:true }, 'B_REPLACE_CONTROL_ATTACHED', 'control-visible:B'],
  [{ bControlVisibleTimeout:true }, 'B_REPLACE_CONTROL_VISIBLE', 'control-enabled-wait:B'],
  [{ bControlEnabledTimeout:true }, 'B_REPLACE_CONTROL_ENABLED', 'control-ready-wait:B'],
  [{ bControlReadyFailure:true }, 'B_REPLACE_CONTROL_READY', 'option-wait:B'],
]) test(`${substage} is preserved for B`, async () => {
  const scenario = await expectReplacementFailure(options, substage);
  assert.ok(!scenario.events.includes(nextEvent));
});

test('B option wait is bounded and blocks selectOption when the option is missing', async () => {
  const scenario = await expectReplacementFailure({ bOptionTimeout:true }, 'B_OPTION_WAIT');
  assert.ok(scenario.events.includes('option-wait:B'));
  assert.ok(!scenario.events.includes('replace:B'));
});

test('B selectOption runs only after option wait succeeds', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.indexOf('option-ready:B') < scenario.events.indexOf('replace:B'));
  assert.ok(scenario.substages.includes('B_SELECT_OPTION'));
});

test('B wrong control value fails confirmation and prevents persistence', async () => {
  const scenario = await expectReplacementFailure({ bControlValueMismatch:true }, 'B_CONTROL_CONFIRMATION');
  assert.ok(scenario.events.includes('replace:B'));
  assert.ok(!scenario.events.includes('persistence-wait:B'));
});

test('B DOM confirmation alone is insufficient; persisted binding must pass', async () => {
  const scenario = await expectReplacementFailure({ persistenceTimeoutIndex:1 }, 'B_REPLACEMENT_PERSISTENCE');
  assert.ok(scenario.events.includes('control-confirmed:B'));
  assert.ok(scenario.events.includes('persistence-wait:B'));
  assert.ok(!scenario.events.includes('persisted:B'));
});

test('C now uses the shared shell-scoped A/B interaction contract', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.substages.includes('C_CLIP_LOCATE'));
  assert.ok(scenario.substages.includes('C_REPLACEMENT_PERSISTENCE'));
  assert.ok(!scenario.events.includes('legacy-label:C'));
  assert.ok(scenario.events.includes('role-locator:C'));
  assert.ok(scenario.events.includes('select-clip:C'));
});

test('C clip locator is shell-scoped and page-global selection cannot satisfy it', async () => {
  const scenario = await expectReplacementFailure({ cPageGlobalMisleadingSelection:true }, 'C_CLIP_SELECT');
  assert.ok(scenario.events.includes('clip-locate:C'));
  assert.ok(!scenario.events.includes('properties-context:C'));
});

test('C_CLIP_LOCATE fails safely before selection when its shell-scoped clip is unavailable', async () => {
  const scenario = await expectReplacementFailure({ cClipLocateFailure:true }, 'C_CLIP_LOCATE');
  assert.ok(!scenario.events.includes('select-clip:C'));
});

test('C wrong ordinal and multi-selection fail before properties lookup', async () => {
  for (const options of [{ cWrongOrdinal:true }, { cMultipleSelected:true }]) {
    const scenario = await expectReplacementFailure(options, 'C_CLIP_SELECT');
    assert.ok(!scenario.events.includes('control-locator:C'));
  }
});

test('C properties context accepts 素材片段 and rejects absent, unselected, or subtitle states', async () => {
  const pass = await runReplacementScenario();
  assert.ok(pass.events.includes('properties-context:C'));
  for (const options of [
    { cPropertiesContextAbsent:true },
    { cPropertiesContextState:String.fromCodePoint(0x672a,0x9009,0x62e9) },
    { cPropertiesContextState:String.fromCodePoint(0x5b57,0x5e55) },
  ]) await expectReplacementFailure(options, 'C_PROPERTIES_CONTEXT');
});

test('C replacement role locator is unique and excludes duplicate controls', async () => {
  const pass = await runReplacementScenario();
  assert.ok(pass.events.includes('role-locator:C'));
  assert.ok(!pass.events.includes('legacy-label:C'));
  const duplicate = await expectReplacementFailure({ cReplaceSelectCount:2 }, 'C_REPLACE_CONTROL_LOCATOR');
  assert.ok(!duplicate.events.includes('control-attached:C'));
});

for (const [options, stage, next] of [
  [{ cControlAttachedTimeout:true }, 'C_REPLACE_CONTROL_ATTACHED', 'control-visible:C'],
  [{ cControlVisibleTimeout:true }, 'C_REPLACE_CONTROL_VISIBLE', 'control-enabled-wait:C'],
  [{ cControlEnabledTimeout:true }, 'C_REPLACE_CONTROL_ENABLED', 'control-ready-wait:C'],
  [{ cControlReadyFailure:true }, 'C_REPLACE_CONTROL_READY', 'option-wait:C'],
]) test(`${stage} is preserved for C`, async () => {
  const scenario = await expectReplacementFailure(options, stage);
  assert.ok(!scenario.events.includes(next));
});

test('C option wait blocks selection when missing and precedes selectOption when present', async () => {
  const fail = await expectReplacementFailure({ cOptionTimeout:true }, 'C_OPTION_WAIT');
  assert.ok(!fail.events.includes('replace:C'));
  const pass = await runReplacementScenario();
  assert.ok(pass.events.indexOf('option-ready:C') < pass.events.indexOf('replace:C'));
});

test('C control value must confirm before its persisted binding can pass', async () => {
  const mismatch = await expectReplacementFailure({ cControlValueMismatch:true }, 'C_CONTROL_CONFIRMATION');
  assert.ok(!mismatch.events.includes('persistence-wait:C'));
  const timeout = await expectReplacementFailure({ persistenceTimeoutIndex:2 }, 'C_REPLACEMENT_PERSISTENCE');
  assert.ok(timeout.events.includes('control-confirmed:C'));
  assert.ok(!timeout.events.includes('persisted:C'));
});

for (const [index, label] of ['A','B','C'].entries()) test(`asset ${label} persistence timeout is bounded and safe`, async () => {
  const scenario = await expectReplacementFailure({ persistenceTimeoutIndex:index }, index === 0 ? 'REPLACEMENT_PERSISTENCE' : `${label}_REPLACEMENT_PERSISTENCE`);
  assert.ok(scenario.events.includes(`persistence-wait:${label}`));
  assert.ok(!scenario.events.includes(`persisted:${label}`));
  assert.ok(!scenario.events.includes('close'));
});

test('final replacement verification mismatch is safely attributed', async () => {
  const scenario = await expectReplacementFailure({ finalMismatch:true }, 'REPLACEMENT_VERIFICATION');
  assert.ok(scenario.events.includes('persisted:C'));
  assert.ok(!scenario.events.includes('close'));
});

test('editor closes only after final replacement verification succeeds', async () => {
  const scenario = await runReplacementScenario();
  assert.ok(scenario.events.indexOf('final-bindings-wait') < scenario.events.indexOf('close'));
  assert.equal(scenario.substages.at(-1), 'EDITOR_CLOSE');
});

test('editor close failure is safely attributed', async () => {
  const scenario = await expectReplacementFailure({ closeFailure:true }, 'EDITOR_CLOSE');
  assert.equal(scenario.events.at(-1), 'close');
});

test('persisted A/B/C bindings remain intact after editor close', async () => {
  const scenario = await runReplacementScenario();
  assert.deepEqual(scenario.project.tracks[0].clips.map(clip => clip.assetId), scenario.project.assets.map(asset => asset.id));
});

test('post-close binding mismatch is safely attributed', async () => {
  await expectReplacementFailure({ postCloseMismatch:true }, 'EDITOR_CLOSE');
});

test('mock replacement flow persists A before B, B before C, and C before final verification', async () => {
  const scenario = await runReplacementScenario();
  assert.deepEqual(scenario.events, [
    'rendered-count',
    'active-shell-wait','active-shell-resolved','active-shell-count',
    'clip-locate:A','select-clip:A','selected-wait:A','selected:A',
    'properties-context-wait:A','properties-context:A',
    'control-locator-wait:A','control-locator-ready:A','role-locator:A','control-locator:A',
    'control-attached:A','control-visible:A',
    'control-enabled-wait:A','control-enabled:A','control-ready-wait:A','control-ready:A',
    'option-wait:A','option-ready:A','replace:A',
    'control-confirmation-wait:A','control-confirmed:A','persistence-wait:A','persisted:A',
    'active-shell-wait','active-shell-resolved','active-shell-count',
    'clip-locate:B','select-clip:B','selected-wait:B','selected:B',
    'properties-context-wait:B','properties-context:B',
    'control-locator-wait:B','control-locator-ready:B','role-locator:B','control-locator:B',
    'control-attached:B','control-visible:B',
    'control-enabled-wait:B','control-enabled:B','control-ready-wait:B','control-ready:B',
    'option-wait:B','option-ready:B','replace:B',
    'control-confirmation-wait:B','control-confirmed:B','persistence-wait:B','persisted:B',
    'active-shell-wait','active-shell-resolved','active-shell-count',
    'clip-locate:C','select-clip:C','selected-wait:C','selected:C',
    'properties-context-wait:C','properties-context:C',
    'control-locator-wait:C','control-locator-ready:C','role-locator:C','control-locator:C',
    'control-attached:C','control-visible:C',
    'control-enabled-wait:C','control-enabled:C','control-ready-wait:C','control-ready:C',
    'option-wait:C','option-ready:C','replace:C',
    'control-confirmation-wait:C','control-confirmed:C','persistence-wait:C','persisted:C',
    'final-bindings-wait','close',
  ]);
});

test('all asset-replacement substages are fixed allowlisted diagnostics', () => {
  assert.deepEqual(ASSET_REPLACEMENT_SUBSTAGES, [
    'CLIP_ORDER_RESOLUTION','ASSET_A_REPLACEMENT',
    'A_CLIP_LOCATE','A_CLIP_SELECT','A_PROPERTIES_CONTEXT',
    'A_REPLACE_CONTROL_LOCATOR','A_REPLACE_CONTROL_ATTACHED','A_REPLACE_CONTROL_VISIBLE',
    'A_REPLACE_CONTROL_ENABLED','A_REPLACE_CONTROL_READY',
    'A_OPTION_WAIT','A_SELECT_OPTION','A_CONTROL_CONFIRMATION',
    'B_CLIP_LOCATE','B_CLIP_SELECT','B_PROPERTIES_CONTEXT',
    'B_REPLACE_CONTROL_LOCATOR','B_REPLACE_CONTROL_ATTACHED','B_REPLACE_CONTROL_VISIBLE',
    'B_REPLACE_CONTROL_ENABLED','B_REPLACE_CONTROL_READY','B_OPTION_WAIT','B_SELECT_OPTION',
    'B_CONTROL_CONFIRMATION','B_REPLACEMENT_PERSISTENCE',
    'C_CLIP_LOCATE','C_CLIP_SELECT','C_PROPERTIES_CONTEXT','C_REPLACE_CONTROL_LOCATOR',
    'C_REPLACE_CONTROL_ATTACHED','C_REPLACE_CONTROL_VISIBLE','C_REPLACE_CONTROL_ENABLED',
    'C_REPLACE_CONTROL_READY','C_OPTION_WAIT','C_SELECT_OPTION','C_CONTROL_CONFIRMATION',
    'C_REPLACEMENT_PERSISTENCE',
    'REPLACEMENT_PERSISTENCE','REPLACEMENT_VERIFICATION','EDITOR_CLOSE',
  ]);
});

test('replacement failures never leak raw errors, IDs, URLs, localStorage bodies, credentials, or HTML', async () => {
  const scenario = replacementPage();
  const clipIds = scenario.project.tracks.flatMap(track => track.clips).map(clip => clip.id);
  const assetIds = scenario.project.assets.map(asset => asset.id);
  const storageBody = JSON.stringify(scenario.project);
  const url = 'https://private.invalid/editor?token=hidden';
  const credential = 'service_role=hidden-credential';
  const html = '<html><body data-private="hidden-markup">secret</body></html>';
  const hiddenValues = ['raw-exception-text', ...clipIds, ...assetIds, storageBody, url, credential, html];
  const rawFailure = hiddenValues.join('|');
  for (const [index, expectedSubstage] of [[0,'A_SELECT_OPTION'],[1,'B_SELECT_OPTION'],[2,'C_SELECT_OPTION']]) {
    await assert.rejects(
      () => gateScope('ASSET_REPLACEMENT', async (_stage, substage) => (
        replaceChronologicalClipAssetsAndClose(
          replacementPage({ selectFailureIndex:index, rawFailure }).page,
          scenario.files,
          substage,
        )
      )),
      error => {
        assert.equal(error.gate, 'ASSET_REPLACEMENT');
        assert.equal(error.code, 'PROJECT_SETUP_FAILED');
        assert.equal(error.substage, expectedSubstage);
        for (const output of [JSON.stringify(error), formatAcceptanceFailure(error), String(error), error.stack]) {
          for (const hidden of hiddenValues) assert.ok(!output.includes(hidden));
        }
        return true;
      },
    );
  }
});
