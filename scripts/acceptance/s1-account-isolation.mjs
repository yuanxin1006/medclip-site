// Real Edge UI with synthetic Auth/credential fixtures; never contacts a Provider.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
const args=process.argv.slice(2),arg=(n)=>{const i=args.indexOf(n);return i<0?undefined:args[i+1]};
const output=path.resolve(arg("--output")??"test-artifacts/s1-browser.json");
const baseline=args.includes("--baseline");
const {chromium}=await import(process.env.MEDCLIP_PLAYWRIGHT_MODULE??"playwright");
let server,target=arg("--url");
if(args.includes("--out")){
  const dir=path.resolve(arg("--out"));
  server=createServer((req,res)=>{
    let p=path.resolve(dir,"."+decodeURIComponent(new URL(req.url,"http://localhost").pathname));
    if(!p.startsWith(dir+path.sep)&&p!==dir){res.writeHead(403).end();return}
    if(fs.existsSync(p+".html"))p+=".html";
    else if(fs.existsSync(p)&&fs.statSync(p).isDirectory())p=path.join(p,"index.html");
    if(!fs.existsSync(p)){res.writeHead(404).end();return}
    const mime={".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".woff2":"font/woff2"};
    res.setHeader("Content-Type",mime[path.extname(p)]??"application/octet-stream");res.end(fs.readFileSync(p));
  });
  await new Promise(r=>server.listen(0,"127.0.0.1",r));target="http://127.0.0.1:"+server.address().port;
}
assert.ok(target,"--url or --out is required");
const siteOrigin=new URL(target).origin;
assert.ok(siteOrigin.includes("127.0.0.1")||siteOrigin==="https://deploy-preview-1--medclip-studio-2026.netlify.app","Use isolated local site or PR #1 only");
let supabaseOrigin="https://s1-audit.invalid";
if(!args.includes("--out")){
  const html=await(await fetch(siteOrigin+"/ai-services")).text();
  for(const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)){
    const t=await(await fetch(new URL(m[1],siteOrigin))).text();
    const host=t.match(/https:\/\/[a-z0-9]+\.supabase\.co/);
    if(host){supabaseOrigin=host[0];break}
  }
}
const storageKey="sb-"+new URL(supabaseOrigin).hostname.split(".")[0]+"-auth-token";
const A="00000000-0000-4000-8000-000000000001",B="00000000-0000-4000-8000-000000000002";
const session=(id)=>{const user={id,aud:"authenticated",role:"authenticated",email:(id===A?"a":"b")+"@example.invalid",app_metadata:{provider:"email"},user_metadata:{},created_at:"2026-01-01T00:00:00Z"};
return{access_token:Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url")+"."+Buffer.from(JSON.stringify({sub:id,role:"authenticated",exp:Math.floor(Date.now()/1000)+3600})).toString("base64url")+".c3ludGhldGljLW9ubHk",refresh_token:"synthetic-refresh-only",expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:"bearer",user}};
const metadata=(id,provider,last4)=>({id:"00000000-0000-4000-8000-000000000003",user_id:id,provider,provider_resource_id:provider==="doubao"?"apikey-s1-fixture":null,key_last4:last4,status:"connected",last_validated_at:"2026-01-01T00:00:00Z",created_at:"2026-01-01T00:00:00Z",updated_at:"2026-01-01T00:00:00Z"});
fs.mkdirSync(path.dirname(output),{recursive:true});
const context=await chromium.launchPersistentContext(output+".profile",{executablePath:process.env.MEDCLIP_EDGE_PATH??"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",headless:true,acceptDownloads:false,viewport:{width:1280,height:900}});
let releaseA,releaseMutation,heldMutation=false,holdMutation=false,aHeld=false,blockedExternal=0;
const aGate=new Promise(r=>releaseA=r),store=new Map();
const validation=(provider)=>({ok:true,provider,status:"VALID",message:"连接验证成功。",validatedAt:"2026-01-01T00:00:00Z"});
await context.addInitScript(({storageKey,seed})=>{if(!localStorage.getItem("__s1_seeded")){localStorage.setItem(storageKey,JSON.stringify(seed));localStorage.setItem("__s1_seeded","true")}}, {storageKey,seed:session(A)});
await context.route("**/*",async route=>{
  const req=route.request(),u=new URL(req.url());
  if(u.origin===supabaseOrigin){
    const headers={"Content-Type":"application/json","Access-Control-Allow-Origin":siteOrigin,"Access-Control-Allow-Headers":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS"};
    const send=async value=>{try{await route.fulfill({status:200,headers,body:JSON.stringify(value)})}catch{}};
    if(req.method()==="OPTIONS"){await route.fulfill({status:204,headers});return}
    let owner=A;try{owner=JSON.parse(Buffer.from((req.headers().authorization??"").split(".")[1],"base64url")).sub}catch{}
    if(u.pathname.endsWith("/user")){await send(session(owner).user);return}
    if(u.pathname.includes("/profiles")){const id=(u.searchParams.get("id")??"").replace("eq.","");await send({id,display_name:id===A?"S1-A":"S1-B",avatar_url:null,created_at:"2026-01-01"});return}
    if(u.pathname.endsWith("/logout")){await send({});return}
    if(u.pathname.endsWith("/ai-credentials")){
      const body=req.postDataJSON(),key=owner+":"+body.provider;
      if(body.action==="list"){
        if(owner===A&&!aHeld){aHeld=true;await aGate;await send({ok:true,connections:[metadata(A,"deepseek","A001")]});return}
        await send({ok:true,connections:[...store.values()].filter(c=>c.user_id===owner)});return;
      }
      if(body.action==="test"){await send({ok:true,validation:validation(body.provider)});return}
      if(body.action==="delete"){store.delete(key);await send({ok:true,status:"DELETED"});return}
      if(body.action==="save"||body.action==="update"){
        if(holdMutation){holdMutation=false;heldMutation=true;await new Promise(r=>releaseMutation=r)}
        const connection=metadata(owner,body.provider,body.apiKey.slice(-4));store.set(key,connection);
        await send({ok:true,connection,validation:validation(body.provider)});return;
      }
    }
    await send({});return;
  }
  if(u.origin===siteOrigin){await route.continue();return}
  blockedExternal++;await route.abort();
});
const page=context.pages()[0]??await context.newPage(),result={mode:"real Edge; synthetic Auth and API fixtures",baseline,realProviderCalls:0,checks:{}};
const input=p=>page.locator('input[name="'+p+'-api-key"]');
async function switchTo(id){
  await page.evaluate(({storageKey,next})=>{
    if(next)localStorage.setItem(storageKey,JSON.stringify(next));else localStorage.removeItem(storageKey);
    const channel=new BroadcastChannel(storageKey);channel.postMessage({event:next?"SIGNED_IN":"SIGNED_OUT",session:next});channel.close();
  },{storageKey,next:id?session(id):null});
  if(id)await page.locator(".platform-user-name").filter({hasText:id===A?"S1-A":"S1-B"}).waitFor();
  else await page.locator('input[name="deepseek-api-key"]').waitFor({state:"detached"});
}
try{
  await page.goto(siteOrigin+"/ai-services");await input("deepseek").waitFor();
  await page.waitForFunction(()=>document.querySelector(".platform-user-name")?.textContent==="S1-A");
  await input("deepseek").fill("synthetic-A-pending-1001");await input("kimi").fill("synthetic-A-pending-1002");
  await switchTo(B);await input("deepseek").waitFor();
  result.checks.directAccountSwitchClearsInputs=(await input("deepseek").inputValue())===""&&(await input("kimi").inputValue())==="";
  releaseA();await page.waitForTimeout(350);
  result.checks.oldListCannotWriteNewAccount=!(await page.locator("body").innerText()).includes("•••• •••• •••• A001");
  if(!baseline){
    assert.ok(result.checks.directAccountSwitchClearsInputs,"Account input state survived switch");
    assert.ok(result.checks.oldListCannotWriteNewAccount,"Old list response crossed account boundary");
    for(const next of [A,B,A,B]){
      await input("deepseek").fill("synthetic-switch-2001");
      await switchTo(next);await input("deepseek").waitFor();
      assert.equal(await input("deepseek").inputValue(),"","Repeated switch retained input");
    }result.checks.repeatedSwitches=true;
    await input("deepseek").fill("synthetic-logout-2002");await switchTo(null);await switchTo(A);
    assert.equal(await input("deepseek").inputValue(),"");result.checks.logoutAndRelogin=true;
    await input("deepseek").fill("synthetic-provider-2003");assert.equal(await input("kimi").inputValue(),"");assert.equal(await input("doubao").inputValue(),"");result.checks.providerInputSeparation=true;
    for(const provider of ["deepseek","kimi","doubao"]){
      const card=page.locator('[data-provider="'+provider+'"]');
      await input(provider).fill("synthetic-workflow-3001");
      if(provider==="doubao")await card.locator("input").first().fill("apikey-s1-fixture");
      await card.getByRole("button",{name:"测试连接",exact:true}).click();
      await card.getByText("连接测试通过；凭证尚未保存。",{exact:true}).waitFor();
      await card.getByRole("button",{name:"保存并连接",exact:true}).click();await card.getByRole("button",{name:"更换 API Key",exact:true}).waitFor();
      await card.getByRole("button",{name:"测试已保存连接",exact:true}).click();await card.getByText("已保存连接验证通过。",{exact:true}).waitFor();
      await card.getByRole("button",{name:"更换 API Key",exact:true}).click();assert.equal(await input(provider).inputValue(),"");
      await input(provider).fill("synthetic-replacement-3002");await card.getByRole("button",{name:"更新连接",exact:true}).click();await card.getByRole("button",{name:"删除连接",exact:true}).waitFor();
      await card.getByRole("button",{name:"删除连接",exact:true}).click();await card.getByRole("button",{name:"确认删除",exact:true}).click();await input(provider).waitFor();assert.equal(await input(provider).inputValue(),"");
      result.checks[provider+"AddTestReplaceDelete"]=true;
    }
    holdMutation=true;await input("deepseek").fill("synthetic-old-mutation-4001");await page.locator('[data-provider="deepseek"]').getByRole("button",{name:"保存并连接",exact:true}).click();
    await page.waitForTimeout(100);assert.ok(heldMutation);await switchTo(B);releaseMutation();await page.waitForTimeout(250);
    assert.equal(await input("deepseek").inputValue(),"");assert.ok(!(await page.locator("body").innerText()).includes("•••• •••• •••• 4001"));result.checks.oldMutationCannotWriteNewAccount=true;
  }else{
    assert.equal(result.checks.directAccountSwitchClearsInputs,false,"Baseline did not reproduce the original input defect");
  }
  result.status="PASS";
}catch(e){result.status="FAIL";result.error=e.name+": "+e.message;process.exitCode=1}
finally{releaseA();releaseMutation?.();result.blockedExternalRequests=blockedExternal;fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await context.close();await new Promise(r=>server?server.close(r):r())}
