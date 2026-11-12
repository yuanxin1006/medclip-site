import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createSafeEditorAIContext } from '../app/editor-ai-requirements.ts';
import { buildOwnedAssetAcceptanceFixtureThroughEditor } from './video-ai-owned-asset-fixture.ts';
import { createAITaskNetworkTracker, readEditorSpecificSurface } from './video-ai-live-acceptance-harness.ts';
import { isAutoOpenedProjectEditorHydrated, readEditorState, readPersistedEditorProject, replaceChronologicalClipAssetsAndClose, waitForAutoOpenedProjectEditor } from './video-ai-reorder-browser-adapter.mjs';
import { classifyPositionScaleApplySignals, classifyPositionScaleEvidence, comparePositionScaleTargetIdentity, inspectPositionScaleCommittedState, inspectPositionScaleHistoryUI, inspectPositionScalePreview, inspectPositionScaleTimelineSelection, inspectPositionScaleUIValues, POSITION_SCALE_FIXTURE_REASON, PositionScaleGateError, resolvePositionScaleTimelineMapping, runPositionScalePostPlanFlow, validatePositionScaleTimelineDOMMapping } from './video-ai-position-scale-diagnostics.mjs';

const BASE_URL='http://localhost:3000';
const PROJECT_KEY='medclip-editor-draft-v1';
const REASON_REQUIREMENT='把第三个视频缩小到80%，放到右上角。';
const REORDER_DIAGNOSTICS=new URL('./video-ai-reorder-diagnostics.mjs',import.meta.url);
const RUNNER_URL=new URL('./run-video-ai-position-scale-preflight.mjs',import.meta.url);
const ADAPTER_URL=new URL('./video-ai-position-scale-browser-adapter.mjs',import.meta.url);
const toPath=url=>decodeURIComponent(new URL(url).pathname.replace(/^\//,''));

export const POSITION_SCALE_UNDO_CONTROL_NAME='\u21b6 \u64a4\u9500';
export const POSITION_SCALE_REDO_CONTROL_NAME='\u21b7 \u91cd\u505a';

export async function resolvePositionScalePlaywright(env=process.env,dependencies={}) {
  if(dependencies.playwright) return dependencies.playwright;
  const loadModule=dependencies.importModule ?? (specifier=>import(specifier));
  try { return await loadModule('playwright'); }
  catch(error) {
    if(!env.MEDCLIP_PLAYWRIGHT_MODULE || error?.code!=='ERR_MODULE_NOT_FOUND') throw error;
    return loadModule(env.MEDCLIP_PLAYWRIGHT_MODULE);
  }
}

export function classifyPositionScaleRequest(requestUrl, method, baseOrigin) {
  const url=new URL(requestUrl);
  if(url.origin===baseOrigin) return 'LOCAL';
  if(url.pathname.endsWith('/functions/v1/ai-tasks') && method==='POST') return 'AI_TASKS';
  if(url.pathname.endsWith('/functions/v1/ai-credentials') && method==='POST') return 'AI_CREDENTIALS';
  if(url.pathname.startsWith('/functions/')) return 'BLOCKED_FUNCTION';
  return 'BLOCKED_EXTERNAL';
}

export function assertPositionScaleApplyEntryReady({ targetTrusted, providerEnabled }) {
  if (targetTrusted !== true || providerEnabled !== true)
    throw new PositionScaleGateError('POSITION_SCALE_ACTION_TARGET');
}

const SAFE_CONNECTION_FIELDS=new Set(['id','user_id','provider','provider_resource_id','key_last4','status','last_validated_at','created_at','updated_at']);
export function assertConnectedDeepSeekMetadata(payload) {
  if(!payload || Object.keys(payload).some(key=>!['ok','connections'].includes(key)) || payload.ok!==true || !Array.isArray(payload.connections))
    throw new PositionScaleGateError('POSITION_SCALE_PROVIDER_METADATA');
  for(const connection of payload.connections) {
    if(!connection || typeof connection!=='object' || Object.keys(connection).some(key=>!SAFE_CONNECTION_FIELDS.has(key)))
      throw new PositionScaleGateError('POSITION_SCALE_PROVIDER_METADATA');
  }
  if(!payload.connections.some(connection=>connection.provider==='deepseek' && connection.status==='connected'))
    throw new PositionScaleGateError('POSITION_SCALE_PROVIDER_METADATA');
  return true;
}

export function createPositionScaleSyntheticResponse(targetId) {
  if(typeof targetId!=='string' || !targetId) throw new PositionScaleGateError('POSITION_SCALE_ACTION_TARGET');
  return {ok:true,task:'editor.requirements_parse',provider:'deepseek',result:{capability:'TEXT_REASONING',data:{summary:'Provider-free canonical position and scale fixture.',actions:[{
    type:'SET_CLIP_POSITION_SCALE',targetId,assetId:'',x:25,y:-25,scale:0.8,reason:POSITION_SCALE_FIXTURE_REASON,
  }],unsupported:[],warnings:[]}},usage:{input_tokens:1,output_tokens:1,total_tokens:2},
  metadata:{providerUsed:'deepseek',taskType:'editor.requirements_parse',generationOccurred:false,providerFreeFixture:true}};
}
export function assertPositionScaleSyntheticResponse(value,targetId) {
  assert.deepEqual(value,createPositionScaleSyntheticResponse(targetId));
  return true;
}

async function sourceHash(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
function envFileValue(name) {
  const text=readFileSync('.env.local','utf8');
  const line=text.split(/\r?\n/).find(item=>item.startsWith(`${name}=`));
  return line ? line.slice(name.length+1).trim().replace(/^['"]|['"]$/g,'') : undefined;
}
function ordered(project) { return project.tracks.filter(t=>['video','broll'].includes(t.type)).flatMap(t=>t.clips).sort((a,b)=>a.timelineStartMs-b.timelineStartMs); }
function contextWithoutActiveClip(value) {
  const context=JSON.parse(value);
  delete context.currentClipId;
  return JSON.stringify(context);
}
export function readTimelineEditorProjectFromCurrentReactTree(expectedClipIds) {
  const shell=document.querySelector('.timeline-editor-shell');
  const key=shell && Object.keys(shell).find(name=>name.startsWith('__reactFiber$'));
  const hostFiber=key && shell[key];
  if(!hostFiber) return null;
  const rootOf=fiber=>{let node=fiber;while(node?.return)node=node.return;return node;};
  const hostRoot=rootOf(hostFiber);
  const currentRoot=hostRoot?.stateNode?.current;
  let currentHost=hostFiber;
  if(hostRoot!==currentRoot) {
    const alternateHost=hostFiber.alternate;
    if(!alternateHost || rootOf(alternateHost)!==currentRoot) return null;
    currentHost=alternateHost;
  }
  const matches=[];
  for(let fiber=currentHost;fiber;fiber=fiber.return) {
    const props=fiber.memoizedProps;
    const project=props?.project;
    if(project?.schemaVersion!==2 || !Array.isArray(project.tracks)
      || typeof props.onProjectChange!=='function' || !Array.isArray(props.assets)) continue;
    const ids=project.tracks.filter(track=>['video','broll'].includes(track.type)).flatMap(track=>track.clips)
      .sort((a,b)=>a.timelineStartMs-b.timelineStartMs).map(clip=>clip.id);
    if(ids.length===expectedClipIds.length && ids.every((id,index)=>id===expectedClipIds[index])) matches.push(project);
  }
  return matches.length===1 ? matches[0] : null;
}
async function readCommittedPositionScaleProject(page, expectedClipIds) {
  return page.evaluate(readTimelineEditorProjectFromCurrentReactTree,expectedClipIds);
}

export async function createPositionScaleAdapter(env, dependencies={}) {
  const base=new URL(env.MEDCLIP_BASE_URL ?? BASE_URL);
  assert.ok(['localhost','127.0.0.1'].includes(base.hostname));
  const projectUrl=env.NEXT_PUBLIC_SUPABASE_URL ?? envFileValue('NEXT_PUBLIC_SUPABASE_URL');
  const token=env.SUPABASE_ACCESS_TOKEN;
  const anonKey=env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? envFileValue('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const testEmail=env.MEDCLIP_TEST_USER_A_EMAIL ?? envFileValue('MEDCLIP_TEST_USER_A_EMAIL');
  const testPassword=env.MEDCLIP_TEST_USER_A_PASSWORD ?? envFileValue('MEDCLIP_TEST_USER_A_PASSWORD');
  const mediaNames=['MEDCLIP_REORDER_VIDEO_A','MEDCLIP_REORDER_VIDEO_B','MEDCLIP_REORDER_VIDEO_C','MEDCLIP_REORDER_AUDIO'];
  for(const name of mediaNames) assert.ok(env[name]);
  if(!projectUrl || !token) throw new PositionScaleGateError('POSITION_SCALE_REMOTE_METADATA_EXEC');
  const supabaseRef=new URL(projectUrl).hostname.split('.')[0];
  assert.match(supabaseRef,/^[a-z0-9]+$/);
  const fetcher=dependencies.fetch ?? fetch;
  const read=dependencies.readFile ?? readFile;
  let browser,page,context,tracker,authClient,session,providerListCount=0,requestCount=0,syntheticResponsesSent=0,providerCalls=0,unexpected=false,armed=false,guardArmed=false,editorHttpStatus,expectedContext,ownedFixture,positionScaleFixture,targetId,baselineProject,appliedProject,applySignals,historyObservedProject;
  const media=async(name,label,mimeType)=>({name:`medclip-position-scale-${label}.${label==='audio'?'wav':'mp4'}`,mimeType,buffer:await read(env[name])});
  const selectTrustedTarget=async(reportStage=()=>{},stages={})=>{
    const timeline=page.locator('.timeline-editor-shell');
    const report=key=>{if(stages[key]) reportStage(stages[key]);};
    report('mapping');report('projectTrack');report('postPlanId');
    const currentProject=await readPersistedEditorProject(page);
    const identity=comparePositionScaleTargetIdentity(baselineProject,currentProject,targetId);
    if(!identity.matches) throw new PositionScaleGateError(identity.substage);
    const mappingResult=resolvePositionScaleTimelineMapping(positionScaleFixture.project,positionScaleFixture.expectedClipIds,targetId,{
      fixtureTargetId:positionScaleFixture.clipIds[2],actionTargetId:targetId,baselineProject,
    });
    if(!mappingResult.mapping) throw new PositionScaleGateError(mappingResult.substage);
    const targetMapping=mappingResult.mapping;
    report('trackContainer');
    const visualTrackGroups=timeline.locator('.timeline-track:not(.audio-track):not(.caption-track)');
    const visualTrackContainerCount=await visualTrackGroups.count();
    if(visualTrackContainerCount!==2) throw new PositionScaleGateError(stages.trackContainer ?? 'UI_SELECTION_MAPPING_TRACK_CONTAINER');
    const targetTrackContainer=visualTrackGroups.nth(targetMapping.renderedTrackOrdinal);
    report('localIndex');
    const trackClipCount=await targetTrackContainer.locator('.timeline-clip').count();
    if(targetMapping.localClipOrdinal<0 || targetMapping.localClipOrdinal>=trackClipCount)
      throw new PositionScaleGateError(stages.localIndex ?? 'UI_SELECTION_MAPPING_LOCAL_INDEX');
    report('domCount');
    const renderedClipCount=await timeline.locator('.timeline-clip').count();
    const expectedRenderedClipCount=ordered(positionScaleFixture.project).length;
    const domMapping=validatePositionScaleTimelineDOMMapping(targetMapping,
      {visualTrackContainerCount,trackClipCount,renderedClipCount,expectedRenderedClipCount});
    if(!domMapping.valid) throw new PositionScaleGateError(domMapping.substage);
    const precedingTrackClipCount=targetMapping.renderedTrackOrdinal===0 ? 0
      : await visualTrackGroups.nth(0).locator('.timeline-clip').count();
    const targetDomIndex=precedingTrackClipCount+targetMapping.localClipOrdinal;
    const targetClipLocator=targetTrackContainer.locator('.timeline-clip').nth(targetMapping.localClipOrdinal);
    report('click');
    await targetClipLocator.waitFor({state:'visible',timeout:15_000});
    await targetClipLocator.click();
    report('selectedState');
    await page.waitForFunction(({trackOrdinal,localClipOrdinal,clipCount})=>{
      const shell=document.querySelector('.timeline-editor-shell');
      if(!shell) return false;
      const rect=shell.getBoundingClientRect(),style=getComputedStyle(shell);
      if(rect.width<=0 || rect.height<=0 || style.display==='none' || style.visibility==='hidden') return false;
      const clips=[...shell.querySelectorAll('.timeline-clip')];
      const selected=clips.filter(node=>node.classList.contains('selected'));
      const groups=[...shell.querySelectorAll('.timeline-track:not(.audio-track):not(.caption-track)')];
      const target=groups[trackOrdinal]?.querySelectorAll('.timeline-clip')[localClipOrdinal];
      return clips.length===clipCount && groups.length===2 && selected.length===1 && selected[0]===target;
    },{trackOrdinal:targetMapping.renderedTrackOrdinal,localClipOrdinal:targetMapping.localClipOrdinal,
      clipCount:renderedClipCount},{timeout:15_000});
    report('propertyGrid');
    await page.waitForFunction(({assetId})=>{
      const shell=document.querySelector('.timeline-editor-shell');
      if(!shell) return false;
      const title=shell.querySelector('.editor-properties .editor-pane-title span')?.textContent?.trim();
      const grids=[...shell.querySelectorAll('.editor-properties .property-grid')];
      const transformGrid=grids.find(grid=>{
        const inputs=[...grid.querySelectorAll('input[type="number"]')];
        return inputs.length===4 && inputs[0].min==='-100' && inputs[1].min==='-100'
          && inputs[2].min==='0.25' && inputs[2].max==='3';
      });
      const assetSelect=[...shell.querySelectorAll('.editor-properties select')]
        .find(select=>[...select.options].some(option=>option.value===assetId));
      return title==='\u7d20\u6750\u7247\u6bb5' && Boolean(transformGrid) && assetSelect?.value===assetId;
    },{assetId:positionScaleFixture.assetIds[2]},{timeout:15_000});
    const selectionValue=await timeline.evaluate(shell=>{
      const clips=[...shell.querySelectorAll('.timeline-clip')];
      const selectedIndices=clips.flatMap((node,index)=>node.classList.contains('selected')?[index]:[]);
      const title=shell.querySelector('.editor-properties .editor-pane-title span')?.textContent?.trim();
      const grids=[...shell.querySelectorAll('.editor-properties .property-grid')];
      const transformGridVisible=grids.some(grid=>{
        const rect=grid.getBoundingClientRect(),style=getComputedStyle(grid);
        const inputs=[...grid.querySelectorAll('input[type="number"]')];
        return rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden'
          && inputs.length===4 && inputs[0].min==='-100' && inputs[1].min==='-100'
          && inputs[2].min==='0.25' && inputs[2].max==='3';
      });
      const assetSelect=[...shell.querySelectorAll('.editor-properties select')]
        .find(select=>[...select.options].some(option=>option.value));
      const rect=shell.getBoundingClientRect(),style=getComputedStyle(shell);
      return {timelineVisible:rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden',
        clipCount:clips.length,selectedIndices,propertyPaneKind:title,transformGridVisible,selectedAssetId:assetSelect?.value};
    });
    assert.equal(inspectPositionScaleTimelineSelection(selectionValue,
      {domIndex:targetDomIndex,clipCount:renderedClipCount,assetId:positionScaleFixture.assetIds[2]}).matches,true);
    return {timeline,targetClip:ordered(positionScaleFixture.project).find(clip=>clip.id===targetId)};
  };
  const observeTrustedTargetPreview=async(expectedTransform,reportStage=()=>{},stages={})=>{
    const bindingStage=stages.binding ?? 'PREVIEW_TARGET_BINDING';
    const elementStage=stages.element ?? 'PREVIEW_ELEMENT';
    const transformStage=stages.transform ?? 'PREVIEW_TRANSFORM_PRESENT';
    const timeline=page.locator('.timeline-editor-shell');
    const targetClip=ordered(positionScaleFixture.project).find(clip=>clip.id===targetId);
    assert.ok(targetClip);
    reportStage(bindingStage);
    const previewTimeMs=targetClip.timelineStartMs+50;
    if(previewTimeMs>=targetClip.timelineEndMs) throw new PositionScaleGateError(bindingStage);
    const editorProgress=timeline.locator('.editor-player-controls input[type="range"]');
    try {
      await editorProgress.evaluate((input,value)=>{
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(value));
        input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
      },previewTimeMs);
      await page.waitForFunction(({startMs,endMs,assetId,clipName,timeMs})=>{
        const shell=document.querySelector('.timeline-editor-shell');
        const playhead=shell?.querySelector('.editor-player-controls input[type="range"]');
        const assetSelect=[...shell?.querySelectorAll('.editor-properties select') ?? []]
          .find(select=>[...select.options].some(option=>option.value===assetId));
        const activeName=shell?.querySelector('.editor-preview-meta span')?.textContent?.trim();
        const value=Number(playhead?.value);
        return Number.isFinite(value) && value===timeMs && value>=startMs && value<endMs
          && assetSelect?.value===assetId && activeName===clipName;
      },{startMs:targetClip.timelineStartMs,endMs:targetClip.timelineEndMs,
        assetId:positionScaleFixture.assetIds[2],clipName:targetClip.name,timeMs:previewTimeMs},{timeout:15_000});
    } catch { throw new PositionScaleGateError(bindingStage); }
    reportStage(elementStage);
    const editorPreview=page.locator('.timeline-editor-shell .editor-canvas > video, .timeline-editor-shell .editor-canvas > img');
    const elementCount=await editorPreview.count();
    if(elementCount!==1 || !await editorPreview.isVisible().catch(()=>false))
      throw new PositionScaleGateError(elementStage);
    if(transformStage!==elementStage) reportStage(transformStage);
    const previewValue=await editorPreview.evaluate(node=>({
      targetBindingMatches:true,
      elementCount:1,
      visible:node.getBoundingClientRect().width>0 && node.getBoundingClientRect().height>0
        && getComputedStyle(node).display!=='none' && getComputedStyle(node).visibility!=='hidden',
      mediaKind:node.tagName.toLowerCase(),expectedMediaKind:'video',inlineTransform:node.style.transform,
    }));
    return inspectPositionScalePreview(previewValue,expectedTransform);
  };
  return {
    async provenance() {
      const cwd=process.cwd();
      const {execFileSync}=await import('node:child_process');
      return {pid:process.pid,cwd,gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim(),
        hashes:{runner:await sourceHash(toPath(RUNNER_URL)),browserAdapter:await sourceHash(toPath(ADAPTER_URL)),
          diagnostics:await sourceHash(toPath(new URL('./video-ai-position-scale-diagnostics.mjs',import.meta.url))),
          sharedReorderBrowserAdapter:await sourceHash(toPath(new URL('./video-ai-reorder-browser-adapter.mjs',import.meta.url))),
          sharedOwnedMediaFixture:await sourceHash(toPath(new URL('./video-ai-owned-asset-fixture.ts',import.meta.url))),
          sharedReorderDiagnostics:await sourceHash(toPath(REORDER_DIAGNOSTICS))}};
    },
    async remoteMetadata() {
      let response;
      try {
        response=await fetcher(`https://api.supabase.com/v1/projects/${supabaseRef}/functions/ai-tasks`,{
          headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30_000)});
      } catch { throw new PositionScaleGateError('POSITION_SCALE_REMOTE_METADATA_EXEC'); }
      if(!response.ok) throw new PositionScaleGateError('POSITION_SCALE_REMOTE_METADATA_EXEC');
      let metadata;
      try { metadata=await response.json(); }
      catch { throw new PositionScaleGateError('POSITION_SCALE_REMOTE_METADATA_PARSE'); }
      if(!metadata || typeof metadata!=='object' || Array.isArray(metadata)
        || typeof metadata.version!=='number' || !Number.isSafeInteger(metadata.version)
        || typeof metadata.status!=='string') throw new PositionScaleGateError('POSITION_SCALE_REMOTE_METADATA_PARSE');
      return {version:metadata.version,status:metadata.status};
    },
    async armProviderGuard() {
      assert.equal(providerCalls,0);assert.equal(unexpected,false);guardArmed=true;
    },
    async authenticate() {
      if(!projectUrl || !anonKey || !testEmail || !testPassword)
        throw new PositionScaleGateError('POSITION_SCALE_AUTH');
      try {
        const {createClient}=dependencies.supabase ?? await import('@supabase/supabase-js');
        authClient=createClient(projectUrl,anonKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
        const result=await authClient.auth.signInWithPassword({email:testEmail,password:testPassword});
        if(result.error || !result.data?.session?.access_token || !result.data.session.user?.id) throw new Error('AUTH_FAILED');
        const verified=await authClient.auth.getUser(result.data.session.access_token);
        if(verified.error || verified.data?.user?.id!==result.data.session.user.id) throw new Error('AUTH_VERIFY_FAILED');
        session=result.data.session;
        return session;
      } catch { throw new PositionScaleGateError('POSITION_SCALE_AUTH'); }
    },
    async readProviderMetadata() {
      if(!authClient || !session?.access_token || providerListCount!==0)
        throw new PositionScaleGateError('POSITION_SCALE_PROVIDER_METADATA');
      providerListCount++;
      try {
        const result=await authClient.functions.invoke('ai-credentials',{body:{action:'list'}});
        if(result.error) throw new Error('CREDENTIALS_LIST_FAILED');
        assertConnectedDeepSeekMetadata(result.data);
        return {deepseekPresent:true,deepseekStatus:'connected',metadataSafe:true};
      } catch(error) {
        if(error instanceof PositionScaleGateError) throw error;
        throw new PositionScaleGateError('POSITION_SCALE_PROVIDER_METADATA');
      }
    },
    async openEditor(authSession=session,reportStage=()=>{}) {
      assert.equal(guardArmed,true);
      if(!authSession?.access_token || !authSession?.user?.id) throw new PositionScaleGateError('POSITION_SCALE_AUTH');
      const {chromium}=await resolvePositionScalePlaywright(env,dependencies);
      const supabaseOrigin=new URL(projectUrl).origin;
      browser=await chromium.launch({headless:true}); context=await browser.newContext();
      await context.addInitScript(({key,draftKey,sessionValue})=>{
        localStorage.setItem(key,JSON.stringify(sessionValue));
        localStorage.removeItem(draftKey);
      },{key:`sb-${supabaseRef}-auth-token`,draftKey:PROJECT_KEY,sessionValue:authSession});
      await context.route('**/*',async route=>{
        const req=route.request(),url=new URL(req.url());
        if(!['http:','https:'].includes(url.protocol)) return route.continue();
        const requestClass=classifyPositionScaleRequest(req.url(),req.method(),base.origin);
        if(requestClass==='LOCAL') return route.continue();
        if(requestClass==='AI_TASKS') {
          requestCount++;
          let body; try { body=req.postDataJSON(); } catch { unexpected=true; return route.abort(); }
          let actualContext;
          try { actualContext=JSON.parse(body.input?.editorContext); } catch { actualContext=null; }
          const activeClipValid=!actualContext?.currentClipId || ownedFixture?.preLiveContext?.expectedClipIds?.includes(actualContext.currentClipId);
          if(!guardArmed || !armed || requestCount!==1 || body.task!=='editor.requirements_parse' || body.provider!=='deepseek'
            || body.input?.editingRequirement!==REASON_REQUIREMENT || !expectedContext || !activeClipValid
            || contextWithoutActiveClip(body.input.editorContext)!==contextWithoutActiveClip(expectedContext)) {
            unexpected=true; return route.abort();
          }
          reportStage('POSITION_SCALE_GENERATION_INTERCEPT');
          reportStage('POSITION_SCALE_RESPONSE_INTERCEPT');
          const synthetic=createPositionScaleSyntheticResponse(targetId);
          assertPositionScaleSyntheticResponse(synthetic,targetId);
          await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(synthetic)});
          syntheticResponsesSent++;
          return;
        }
        if(requestClass==='AI_CREDENTIALS') {
          let body; try { body=req.postDataJSON(); } catch { unexpected=true; return route.abort(); }
          if(body.action==='list' && url.origin===supabaseOrigin && req.headers()['authorization']?.startsWith('Bearer ')) return route.continue();
          unexpected=true; return route.abort();
        }
        if(requestClass==='BLOCKED_FUNCTION') { unexpected=true; return route.abort(); }
        if(url.origin===supabaseOrigin && url.pathname==='/auth/v1/user' && req.method()==='GET') return route.continue();
        if(url.origin===supabaseOrigin && url.pathname==='/auth/v1/token' && req.method()==='POST') return route.continue();
        if(url.origin===supabaseOrigin && url.pathname.startsWith('/storage/v1/')) return route.continue();
        // Editor-side media/model fetches may target external hosts. Block them
        // offline, but do not classify them as provider-generation calls.
        return route.abort();
      });
      page=await context.newPage();
      const credentialsResponse=page.waitForResponse(response=>{
        const request=response.request(),requestUrl=new URL(response.url());
        if(requestUrl.origin!==supabaseOrigin || !requestUrl.pathname.endsWith('/functions/v1/ai-credentials') || request.method()!=='POST') return false;
        try { return request.postDataJSON()?.action==='list'; } catch { return false; }
      },{timeout:30_000});
      const response=await page.goto(new URL('/editor',base).href);
      editorHttpStatus=response?.status();assert.equal(editorHttpStatus,200);await page.locator('main.app-shell').waitFor();
      assert.equal(new URL(page.url()).pathname,'/editor');
      reportStage('POSITION_SCALE_PROVIDER_METADATA');
      let credentialResponse,credentialPayload;
      try { credentialResponse=await credentialsResponse;assert.equal(credentialResponse.ok(),true);credentialPayload=await credentialResponse.json(); }
      catch { throw new PositionScaleGateError('POSITION_SCALE_PROVIDER_METADATA'); }
      assertConnectedDeepSeekMetadata(credentialPayload);
      const deepSeek=page.getByRole('radio',{name:/DeepSeek/i});
      if(!await deepSeek.isEnabled()) throw new PositionScaleGateError('POSITION_SCALE_PROVIDER_SELECT');
      tracker=createAITaskNetworkTracker(page,90_000);
      return {httpStatus:editorHttpStatus};
    },
    async fixture(setSubstage=()=>{}) {
      const fixtureStage = value => {
        const map={
          VIDEO_A_REGISTRATION:'POSITION_SCALE_FIXTURE_ASSET_A',
          VIDEO_B_REGISTRATION:'POSITION_SCALE_FIXTURE_ASSET_B',
          VIDEO_C_REGISTRATION:'POSITION_SCALE_FIXTURE_ASSET_C',
          AUDIO_REGISTRATION:'POSITION_SCALE_FIXTURE_MEDIA_INPUTS',
          SUBTITLE_PREPARATION:'POSITION_SCALE_FIXTURE_MEDIA_INPUTS',
          CONSENT_CONFIRMATION:'POSITION_SCALE_FIXTURE_MEDIA_INPUTS',
          GENERATE_READINESS:'POSITION_SCALE_FIXTURE_MEDIA_INPUTS',
          PROJECT_GENERATION:'POSITION_SCALE_FIXTURE_PROJECT_RESET',
          PROJECT_PERSISTENCE_WAIT:'POSITION_SCALE_FIXTURE_PERSISTENCE',
          PROJECT_OPEN:'POSITION_SCALE_FIXTURE_PROJECT_RESET',
          THREE_CLIP_SETUP:'POSITION_SCALE_FIXTURE_PROJECT_RESET',
          ASSET_REPLACEMENT:'POSITION_SCALE_FIXTURE_ORDER',
          PROJECT_STATE_VALIDATION:'POSITION_SCALE_FIXTURE_PERSISTENCE',
          OWNERSHIP_VALIDATION:'POSITION_SCALE_FIXTURE_ORDER',
        };
        const mapped=value==='POSITION_SCALE_FIXTURE_MEDIA_INPUTS' ? value : map[value] ?? 'POSITION_SCALE_FIXTURE_ORDER';
        setSubstage(mapped);
      };
      fixtureStage('POSITION_SCALE_FIXTURE_MEDIA_INPUTS');
      const [a,b,c,audio]=await Promise.all([
        media(mediaNames[0],'A','video/mp4'),media(mediaNames[1],'B','video/mp4'),media(mediaNames[2],'C','video/mp4'),media(mediaNames[3],'audio','audio/wav')]);
      ownedFixture=await buildOwnedAssetAcceptanceFixtureThroughEditor(page,{video:a,additionalVideos:[b,c],audio,
        diagnosticStage:fixtureStage,
        diagnosticSubstage:fixtureStage,
        subtitleText:'0\n00:00:00,000 --> 00:00:02,000\nProvider-free preflight fixture.',
        prepareGeneratedProject:async()=>{
          fixtureStage('PROJECT_OPEN');
          await waitForAutoOpenedProjectEditor(page);
          const readProject=()=>readPersistedEditorProject(page);
          let p=await readProject();
          const clips=project=>ordered(project);
          assert.ok(clips(p).length>0 && clips(p).length<=3);
          fixtureStage('THREE_CLIP_SETUP');
          while(clips(p).length<3) {
            const list=clips(p),longest=list.reduce((x,y)=>y.timelineEndMs-y.timelineStartMs>x.timelineEndMs-x.timelineStartMs?y:x);
            assert.ok(longest.timelineEndMs-longest.timelineStartMs>=400);
            await page.locator('.timeline-clip').nth(list.indexOf(longest)).dispatchEvent('click');
            await page.locator('.timeline-editor-shell').getByRole('slider',{name:/播放进度/}).evaluate((input,value)=>{
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(value));
              input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
            },Math.round((longest.timelineStartMs+longest.timelineEndMs)/20)*10);
            await page.locator('.timeline-editor-shell').getByRole('button',{name:/分割/}).click();
            await page.waitForFunction(count=>JSON.parse(localStorage.getItem('medclip-editor-draft-v1')).tracks.flatMap(t=>t.clips).length===count,list.length+1);
            p=await readProject();
          }
          fixtureStage('ASSET_REPLACEMENT');
          await replaceChronologicalClipAssetsAndClose(page,[a,b,c]);
        }});
      fixtureStage('PROJECT_STATE_VALIDATION');
      await page.locator('.continue-edit-button').waitFor({state:'visible',timeout:60_000});
      const state=await readEditorState(page); const clips=ordered(state.project);
      assert.equal(unexpected,false); assert.equal(requestCount,0);
      fixtureStage('OWNERSHIP_VALIDATION');
      assert.deepEqual(new Set(state.ownedIds),new Set(ownedFixture.registeredAssets.map(a=>a.id)));
      assert.deepEqual(clips.map(c=>c.assetId),ownedFixture.registeredAssets.map(a=>a.id));
      const helperClips=ordered(ownedFixture.project);
      assert.deepEqual(helperClips.map(clip=>clip.id),clips.map(clip=>clip.id));
      assert.deepEqual(helperClips.map(clip=>clip.trackId),clips.map(clip=>clip.trackId));
      targetId=clips[2].id;
      assert.equal(ownedFixture.preLiveContext.expectedTargetClipId,targetId);
      assert.deepEqual(ownedFixture.preLiveContext.expectedClipIds,clips.map(clip=>clip.id));
      const serializedContext=createSafeEditorAIContext(state.project,new Set(state.ownedIds),state.project.audioSelection.sourceDurationMs);
      expectedContext=serializedContext;
      const contextValue=JSON.parse(serializedContext);
      assert.deepEqual(contextValue.clips.map(c=>c.id),clips.map(c=>c.id));
      assert.equal(contextValue.clips[2].id,targetId);
      assert.equal(contextValue.clips[2].trackId,clips[2].trackId);
      assert.equal(contextValue.clips[2].positionScaleEligible,true);
      assert.deepEqual({x:clips[2].transform.x,y:clips[2].transform.y,scale:clips[2].transform.scale},{x:0,y:0,scale:1});
      baselineProject=state.project;
      positionScaleFixture={project:baselineProject,clipIds:clips.map(c=>c.id),expectedClipIds:clips.map(c=>c.id),assetIds:ownedFixture.registeredAssets.map(a=>a.id),
        contextOrder:['A','B','C'],contextTransform:{x:0,y:0,scale:1}};
      return positionScaleFixture;
    },
    async captureProject() {
      if(!appliedProject) return baselineProject;
      if(historyObservedProject) return historyObservedProject;
      let project;
      try { project=await readCommittedPositionScaleProject(page,positionScaleFixture.expectedClipIds); }
      catch { project=null; }
      if(project && inspectPositionScaleCommittedState(project,positionScaleFixture.expectedClipIds,targetId,{x:25,y:-25,scale:0.8}).transformMatches)
        return project;
      const persisted=await page.evaluate(key=>{try{return JSON.parse(localStorage.getItem(key));}catch{return null;}},PROJECT_KEY);
      if(!persisted) throw new PositionScaleGateError('POSITION_SCALE_PRODUCT_APPLY_OBSERVER_CONFLICT');
      return persisted;
    },
    async applyCanonicalAction(action,requirement,reportStage=()=>{}) {
      assert.equal(action.targetId,targetId); assert.equal(action.type,'SET_CLIP_POSITION_SCALE');
      reportStage('POSITION_SCALE_ACTION_TARGET');
      const providerRadio=page.getByRole('radio',{name:/DeepSeek/i});
      assertPositionScaleApplyEntryReady({targetTrusted:action.targetId===targetId,providerEnabled:await providerRadio.isEnabled()});
      reportStage('POSITION_SCALE_PROVIDER_SELECT');
      await providerRadio.click();
      await page.locator('.requirement-advanced summary').click();
      await page.locator('.requirement-trigger').click();
      reportStage('POSITION_SCALE_REQUIREMENT_INPUT');
      await page.locator('#requirement-text').fill(requirement);
      armed=true;
      const responsePromise=page.waitForResponse(response=>{
        const request=response.request(),requestUrl=new URL(response.url());
        return requestUrl.pathname.endsWith('/functions/v1/ai-tasks') && request.method()==='POST';
      },{timeout:90_000});
      await page.locator('.ai-apply-button').click();
      let generationResponse;
      try { generationResponse=await responsePromise; }
      catch { throw new PositionScaleGateError('POSITION_SCALE_RESPONSE_INTERCEPT'); }
      if(requestCount!==1 || syntheticResponsesSent!==1 || providerCalls!==0 || unexpected)
        throw new PositionScaleGateError('POSITION_SCALE_PROVIDER_COUNT');
      assert.equal(generationResponse.status(),200);
      reportStage('POSITION_SCALE_RESPONSE_ENVELOPE');
      let envelope;
      try { envelope=await generationResponse.json(); }
      catch { throw new PositionScaleGateError('POSITION_SCALE_RESPONSE_ENVELOPE'); }
      try { assertPositionScaleSyntheticResponse(envelope,targetId); }
      catch { throw new PositionScaleGateError('POSITION_SCALE_RESPONSE_ENVELOPE'); }
      try {
        await page.waitForFunction(()=>Boolean(document.querySelector('.editor-ai-apply-summary'))
          || Boolean(document.querySelector('.editor-ai-dialog-error[role="alert"]')),undefined,{timeout:90_000});
      } catch { throw new PositionScaleGateError('POSITION_SCALE_RESPONSE_CONSUMED'); }
      reportStage('POSITION_SCALE_RESPONSE_CONSUMED');
      const surface=await readEditorSpecificSurface(page);
      const validationMessage=String.fromCodePoint(65,73,32,36820,22238,30340,21098,36753,35745,21010,26410,36890,36807,23433,20840,26657,39564,65292,26102,38388,32447,27809,26377,20462,25913,12290);
      const knownPlanRejection=surface.errorVisible && surface.errorText===validationMessage;
      if(knownPlanRejection || surface.successVisible) reportStage('POSITION_SCALE_RESPONSE_EXTRACT');
      if(knownPlanRejection) throw new PositionScaleGateError('POSITION_SCALE_PLAN_REJECTED_BEFORE_APPLY');
      if(surface.errorVisible) throw new PositionScaleGateError('POSITION_SCALE_RESPONSE_OR_PRODUCT_ERROR');
      if(!surface.successVisible) throw new PositionScaleGateError('POSITION_SCALE_RESPONSE_CONSUMED');
      const evidence={interceptMatched:true,responseSent:syntheticResponsesSent===1,envelopeValid:true,responseConsumed:true,
        planAccepted:surface.successVisible,targetResolved:true,providerGuardViolated:providerCalls!==0 || unexpected || requestCount!==1};
      reportStage('POSITION_SCALE_PLAN_ACCEPTED');
      const expectedTransform={x:25,y:-25,scale:0.8};
      const closeDialog=page.getByRole('button',{name:'\u5173\u95ed\u9700\u6c42\u5bf9\u8bdd\u6846',exact:true});
      let targetClip,timeline,fiberProject,fiberMatches=false;
      const postPlan=await runPositionScalePostPlanFlow({reportStage,
        confirmTarget:async()=>{
          targetClip=ordered(positionScaleFixture.project).find(clip=>clip.id===targetId);assert.ok(targetClip);
        },
        selectTarget:async()=>{
          reportStage('UI_SELECTION_DIALOG_READY');
          if(await closeDialog.isVisible()) {
            await closeDialog.click();
            await closeDialog.waitFor({state:'hidden',timeout:15_000});
          }
          reportStage('UI_SELECTION_EDITOR_READY');
          const continueButton=page.locator('.continue-edit-button');
          await continueButton.waitFor({state:'visible',timeout:15_000});
          await continueButton.click();
          reportStage('UI_SELECTION_TIMELINE_READY');
          timeline=page.locator('.timeline-editor-shell');
          await timeline.waitFor({state:'visible',timeout:15_000});
          assert.equal(await timeline.count(),1);
          const selected=await selectTrustedTarget(reportStage,{
            mapping:'UI_SELECTION_MAPPING',projectTrack:'UI_SELECTION_MAPPING_PROJECT_TRACK',
            postPlanId:'UI_SELECTION_MAPPING_PROJECT_TRACK_POST_PLAN_ID',
            trackContainer:'UI_SELECTION_MAPPING_TRACK_CONTAINER',localIndex:'UI_SELECTION_MAPPING_LOCAL_INDEX',
            domCount:'UI_SELECTION_MAPPING_DOM_COUNT',click:'UI_SELECTION_CLICK',
            selectedState:'UI_SELECTION_SELECTED_STATE',propertyGrid:'UI_SELECTION_PROPERTY_GRID',
          });
          targetClip=selected.targetClip;
        },
        observeUI:async()=>{
          const uiValues=await timeline.evaluate(shell=>{
            const selected=[...shell.querySelectorAll('.timeline-clip.selected')];
            const grids=[...shell.querySelectorAll('.editor-properties .property-grid')];
            const transformGrid=grids.find(grid=>{
              const inputs=[...grid.querySelectorAll('input[type="number"]')];
              return inputs.length===4 && inputs[0].min==='-100' && inputs[1].min==='-100'
                && inputs[2].min==='0.25' && inputs[2].max==='3';
            });
            const inputs=transformGrid ? [...transformGrid.querySelectorAll('input[type="number"]')] : [];
            const assetSelect=[...shell.querySelectorAll('.editor-properties select')]
              .find(select=>[...select.options].some(option=>option.value));
            return {selectedCount:selected.length,selectedAssetId:assetSelect?.value,
              x:inputs[0]?.value,y:inputs[1]?.value,scale:inputs[2]?.value};
          });
          const observation=inspectPositionScaleUIValues(uiValues,expectedTransform);
          observation.matches=observation.matches && uiValues.selectedCount===1
            && uiValues.selectedAssetId===positionScaleFixture.assetIds[2];
          return observation;
        },
        observePreview:async()=>observeTrustedTargetPreview(expectedTransform,reportStage),
        observeFiber:async()=>{
          fiberProject=await readCommittedPositionScaleProject(page,positionScaleFixture.expectedClipIds);
          const fiberTarget=fiberProject && ordered(fiberProject).find(clip=>clip.id===targetId);
          fiberMatches=Boolean(fiberTarget && inspectPositionScaleUIValues(fiberTarget.transform,expectedTransform).matches);
          return !fiberProject?'NOT_USED':fiberMatches?'MATCH':'STALE';
        }});
      const uiObservation=postPlan.ui,previewObservation=postPlan.preview;
      const fiberDiagnostic=postPlan.fiber;
      const undoButton=timeline.getByRole('button',{name:POSITION_SCALE_UNDO_CONTROL_NAME,exact:true});
      reportStage('HISTORY_UNDO_CONTROL_FOUND');
      evidence.historyUndoControlFound=await undoButton.count()===1;
      if(!evidence.historyUndoControlFound) throw new PositionScaleGateError('HISTORY_UNDO_CONTROL_FOUND');
      reportStage('HISTORY_UNDO_CONTROL_ENABLED');
      evidence.historyUndoControlEnabled=await undoButton.isEnabled();
      evidence.historyAvailable=evidence.historyUndoControlEnabled;
      if(!evidence.historyUndoControlEnabled) throw new PositionScaleGateError('HISTORY_UNDO_CONTROL_ENABLED');
      reportStage('HISTORY_PRE_EDIT_SNAPSHOT');
      applySignals={commitCallbackInvoked:true,uiMatches:uiObservation.matches,previewMatches:previewObservation.matches,
        fiberReadable:fiberDiagnostic!=='NOT_USED',fiberMatches,historyAvailable:evidence.historyAvailable,
        fiberDiagnostic};
      const applyOutcome=classifyPositionScaleApplySignals(applySignals);
      if(applyOutcome.result!=='PASS') throw new PositionScaleGateError(applyOutcome.substage ?? 'POSITION_SCALE_PRODUCT_APPLY');
      evidence.projectMutated=true;
      appliedProject=true;
      const evidenceOutcome=classifyPositionScaleEvidence({...evidence,persistenceChecked:false});
      if(evidenceOutcome.result!=='PASS') throw new PositionScaleGateError(evidenceOutcome.substage ?? 'POSITION_SCALE_HISTORY');
    },
    async assertPreview(project,target) {
      assert.equal(applySignals?.previewMatches,true);
      assert.deepEqual(ordered(project).find(c=>c.id===target)?.transform.x,25);
    },
    async assertRenderPlan(project,target) {
      const state=await readEditorState(page);const segment=state.segments.find(s=>s.id===target);
      assert.ok(segment);assert.deepEqual({x:segment.transform.x,y:segment.transform.y,scale:segment.transform.scale},{x:25,y:-25,scale:0.8});
      assert.deepEqual(segment.transform,ordered(project).find(c=>c.id===target).transform);
    },
    async assertPersistence(project,target) {
      const persisted=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),PROJECT_KEY);
      assert.deepEqual(persisted,project);
      const roundTrip=JSON.parse(JSON.stringify(persisted));
      const clip=ordered(roundTrip).find(c=>c.id===target), original=ordered(project).find(c=>c.id===target);
      assert.deepEqual({x:clip.transform.x,y:clip.transform.y,scale:clip.transform.scale},{x:25,y:-25,scale:0.8});
      assert.equal(clip.transform.crop,original.transform.crop);assert.equal(clip.transform.fit,original.transform.fit);
    },
    async observeHistoryTransform(expected, direction, reportStage=()=>{}) {
      const prefix=direction==='undo'?'UNDO':'REDO';
      const projectStage=`${prefix}_PROJECT_TRANSITION`;
      const reselectionStage=`${prefix}_C_RESELECTION`;
      const uiStage=`${prefix}_UI_OBSERVATION`;
      const previewBindingStage=`${prefix}_PREVIEW_BINDING`;
      const previewObservationStage=`${prefix}_PREVIEW_OBSERVATION`;
      reportStage(projectStage);
      try {
        await page.waitForFunction(({key,expected,expectedClipIds,targetId,redoName,direction})=>{
          let project;
          try { project=JSON.parse(localStorage.getItem(key)); } catch { return false; }
          const clips=project?.tracks?.filter(track=>['video','broll'].includes(track.type))
            .flatMap(track=>track.clips).sort((a,b)=>a.timelineStartMs-b.timelineStartMs) ?? [];
          const target=clips.find(clip=>clip.id===targetId);
          const shell=document.querySelector('.timeline-editor-shell');
          const redo=[...shell?.querySelectorAll('button') ?? []]
            .find(button=>button.textContent?.trim()===redoName);
          const historyControlTransitioned=direction==='undo' ? redo?.disabled===false : redo?.disabled===true;
          return historyControlTransitioned && clips.length===expectedClipIds.length
            && clips.every((clip,index)=>clip.id===expectedClipIds[index])
            && target?.transform?.x===expected.x && target?.transform?.y===expected.y
            && target?.transform?.scale===expected.scale;
        },{key:PROJECT_KEY,expected,expectedClipIds:positionScaleFixture.expectedClipIds,
          targetId,redoName:POSITION_SCALE_REDO_CONTROL_NAME,direction},{timeout:15_000});
      } catch { throw new PositionScaleGateError(projectStage); }
      historyObservedProject=await readPersistedEditorProject(page);
      const transition=inspectPositionScaleCommittedState(historyObservedProject,
        positionScaleFixture.expectedClipIds,targetId,expected);
      if(!transition.targetResolved || !transition.transformMatches)
        throw new PositionScaleGateError(projectStage);

      reportStage(reselectionStage);
      try { await selectTrustedTarget(); }
      catch { throw new PositionScaleGateError(reselectionStage); }
      const timeline=page.locator('.timeline-editor-shell');
      reportStage(uiStage);
      try {
        await page.waitForFunction(({expected,assetId})=>{
          const shell=document.querySelector('.timeline-editor-shell');
          const selected=[...shell?.querySelectorAll('.timeline-clip.selected') ?? []];
          const grids=[...shell?.querySelectorAll('.editor-properties .property-grid') ?? []];
          const transformGrid=grids.find(grid=>{
            const inputs=[...grid.querySelectorAll('input[type="number"]')];
            return inputs.length===4 && inputs[0].min==='-100' && inputs[1].min==='-100'
              && inputs[2].min==='0.25' && inputs[2].max==='3';
          });
          const inputs=transformGrid ? [...transformGrid.querySelectorAll('input[type="number"]')] : [];
          const assetSelect=[...shell?.querySelectorAll('.editor-properties select') ?? []]
            .find(select=>[...select.options].some(option=>option.value===assetId));
          return selected.length===1 && assetSelect?.value===assetId && inputs.length===4
            && Number(inputs[0].value)===expected.x && Number(inputs[1].value)===expected.y
            && Number(inputs[2].value)===expected.scale;
        },{expected,assetId:positionScaleFixture.assetIds[2]},{timeout:15_000});
      } catch { throw new PositionScaleGateError(uiStage); }
      const uiValues=await timeline.evaluate(shell=>{
        const selected=[...shell.querySelectorAll('.timeline-clip.selected')];
        const grids=[...shell.querySelectorAll('.editor-properties .property-grid')];
        const grid=grids.find(item=>{
          const inputs=[...item.querySelectorAll('input[type="number"]')];
          return inputs.length===4 && inputs[0].min==='-100' && inputs[1].min==='-100'
            && inputs[2].min==='0.25' && inputs[2].max==='3';
        });
        const inputs=grid ? [...grid.querySelectorAll('input[type="number"]')] : [];
        const assetSelect=[...shell.querySelectorAll('.editor-properties select')]
          .find(select=>[...select.options].some(option=>option.value));
        return {selectedCount:selected.length,selectedAssetId:assetSelect?.value,
          x:inputs[0]?.value,y:inputs[1]?.value,scale:inputs[2]?.value};
      });
      const ui=inspectPositionScaleHistoryUI(uiValues,expected,positionScaleFixture.assetIds[2]);
      if(!ui.matches) throw new PositionScaleGateError(uiStage);

      const preview=await observeTrustedTargetPreview(expected,reportStage,{
        binding:previewBindingStage,element:previewObservationStage,transform:previewObservationStage,
      });
      if(!preview.matches) throw new PositionScaleGateError(previewObservationStage,undefined,preview.actual);
      return {ui:ui.actual,preview:preview.actual};
    },
    async undo(reportStage=()=>{}) {
      if(!await page.locator('.timeline-editor-shell').isVisible().catch(()=>false)) await page.locator('.continue-edit-button').click();
      const timeline=page.locator('.timeline-editor-shell');
      const undoButton=timeline.getByRole('button',{name:POSITION_SCALE_UNDO_CONTROL_NAME,exact:true});
      reportStage('HISTORY_UNDO_CONTROL_FOUND');
      if(await undoButton.count()!==1) throw new PositionScaleGateError('HISTORY_UNDO_CONTROL_FOUND');
      reportStage('HISTORY_UNDO_CONTROL_ENABLED');
      if(!await undoButton.isEnabled()) throw new PositionScaleGateError('HISTORY_UNDO_CONTROL_ENABLED');
      reportStage('UNDO_CLICK');
      await undoButton.click();
      const observation=await this.observeHistoryTransform({x:0,y:0,scale:1},'undo',reportStage);
      reportStage('HISTORY_UNDO_RESULT');
      return observation;
    },
    async redo(reportStage=()=>{}) {
      const redoButton=page.locator('.timeline-editor-shell').getByRole('button',{name:POSITION_SCALE_REDO_CONTROL_NAME,exact:true});
      reportStage('HISTORY_REDO_CONTROL_FOUND');
      if(await redoButton.count()!==1) throw new PositionScaleGateError('HISTORY_REDO_CONTROL_FOUND');
      reportStage('HISTORY_REDO_CONTROL_ENABLED');
      if(!await redoButton.isEnabled())
        throw new PositionScaleGateError('HISTORY_REDO_CONTROL_ENABLED');
      reportStage('REDO_CLICK');
      await redoButton.click();
      const observation=await this.observeHistoryTransform({x:25,y:-25,scale:0.8},'redo',reportStage);
      reportStage('HISTORY_REDO_RESULT');
      return observation;
    },
    async providerCounts() {
      assert.equal(guardArmed,true);assert.equal(unexpected,false);assert.equal(requestCount,1);assert.equal(syntheticResponsesSent,1);
      return {remote:providerCalls,deepseek:0,kimi:0,doubao:0,tokenhub:0};
    },
    async close() { if(browser) await browser.close(); authClient?.auth?.stopAutoRefresh?.(); },
  };
}
