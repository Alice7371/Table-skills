'use strict';
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.join(__dirname,'../.test-output/web-stand-in'), skill=path.resolve(__dirname,'../web-stand-in');
fs.mkdirSync(root,{recursive:true});
const helpers=require('../web-stand-in/scripts/prepare-job.cjs');
const fixture=fs.mkdtempSync(path.join(root,'fixtures-'));
const task=path.join(fixture,'input.md');
const source='中文独立调研任务\r\n保留  空格、引号\'与 $(literal)。\r\n';
fs.writeFileSync(task,source,'utf8');
const runtime=fs.readFileSync(path.join(skill,'references/runtime-contract.md'),'utf8');
const code=fs.readFileSync(path.join(skill,'scripts/wait-for-chat.js'),'utf8')+'\n'+fs.readFileSync(path.join(skill,'scripts/receive-chat.js'),'utf8');
const {receiveChat,waitForChat,selectChatView}=new Function(code+'\nreturn {receiveChat,waitForChat,selectChatView};')();
const chatId='11111111-2222-3333-4444-555555555555';
const results=[];
async function test(name,fn) { await fn(); results.push({name,passed:true}); }
function prepare(name) { return helpers.prepareJob({task,projectRoot:root,outputDir:path.join(fixture,name),skillDir:skill}); }
function packet(request,answer,status='completed') { return {thread:{id:chatId,kind:'chatgpt'},page:{order:'newest_first'},turns:[{id:'turn-1',status,items:[{type:'userMessage',content:request.requestTag},{type:'agentMessage',id:'answer-1',text:answer}]}]}; }
function complete(request) { return '[WO_BRIEF_BEGIN:'+request.briefId+']\n结论待核实。\n[WO_BRIEF_END:'+request.briefId+']\nREPORT_BODY 中文  原文\' $(literal)。\nhttps://example.com/source\n[WEB_OFFLOAD_DONE]\n'; }
function shell(args) { const r=spawnSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe',['-NoProfile','-Command',args.cmd],{encoding:'utf8',timeout:30000}); return {exit_code:r.status,output:r.stdout.trim(),error:r.stderr.trim()}; }
function hostFor(request,replies,failSave=false) {
  const state=new Map(), output=[], calls={read:0,save:0,exec:0,timer:0};
  const host={skillDirectory:skill,store:(k,v)=>state.set(k,v),load:k=>state.get(k),text:v=>output.push(v),
    setTimeout:(fn,ms)=>{calls.timer++;return setTimeout(fn,ms);},clearTimeout,
    tools:{mcp__codex_app__read_thread:async()=>{const i=calls.read++;return packet(request,replies[Math.min(i,replies.length-1)].answer,replies[Math.min(i,replies.length-1)].status);},
      exec_command:async args=>{calls.exec++;if(args.cmd.includes(' -PacketJson ')){calls.save++;if(failSave)return {exit_code:1,output:'save failure fixture'};}return shell(args);}}};
  return {host,calls,output};
}
function bound(name) { const p=prepare(name);helpers.bindChat(p.jobPath,chatId);return {jobPath:p.jobPath,request:helpers.receiveJob(p.jobPath).request}; }
(async()=>{
  const first=prepare('prepare');
  await test('Preparation preserves one exact standalone input and creates no worker',()=>{
    const loaded=helpers.loadJob(first.jobPath);assert.ok(loaded.prompt.endsWith(source));assert.equal(loaded.runtimeContract,undefined);
    assert.deepEqual(fs.readdirSync(path.dirname(first.jobPath)).sort(),['job.json','prompt.md','task.md']);
    assert.equal(loaded.job.waitPolicy,'deferred');assert.equal(loaded.job.modelPreference.web,'GPT-5.6 Sol / 极高');
    assert.ok(helpers.loadJob(first.jobPath,Date.now(),true).runtimeContract);
  });
  await test('Prompt mutation prevents dispatch',()=>{
    const loaded=helpers.loadJob(first.jobPath);fs.appendFileSync(loaded.job.promptPath,'changed');assert.throws(()=>helpers.loadJob(first.jobPath),/integrity/);fs.writeFileSync(loaded.job.promptPath,loaded.prompt,'utf8');
  });
  const late=prepare('late');let lateJob=JSON.parse(fs.readFileSync(late.jobPath,'utf8'));lateJob.sendDeadlineMs=Date.now()-3600000;fs.writeFileSync(late.jobPath,JSON.stringify(lateJob),'utf8');
  await test('Expired send blocks sending but confirmed late binding remains valid',()=>{
    assert.throws(()=>helpers.loadJob(late.jobPath),/expired/);assert.equal(helpers.bindChat(late.jobPath,chatId).status,'awaiting_result');
  });
  await test('Binding is idempotent and prevents changed identity or re-sending',()=>{
    assert.equal(helpers.bindChat(late.jobPath,chatId).status,'awaiting_result');assert.throws(()=>helpers.bindChat(late.jobPath,'99999999-2222-3333-4444-555555555555'),/another Chat/);assert.throws(()=>helpers.loadJob(late.jobPath),/never resend/);
  });
  await test('Later receive uses its own time budget and original identity',()=>{
    const now=Date.now()+86400000, received=helpers.receiveJob(late.jobPath,5000,now);assert.equal(received.request.deadlineMs,now+5000);assert.equal(received.request.chatId,chatId);assert.equal(received.request.readMode,'once');assert.equal(received.request.recordProgress,false);
  });
  const resumed=bound('resume'), answer=complete(resumed.request), flow=hostFor(resumed.request,[{answer:'',status:'in_progress'},{answer,status:'completed'}]);
  await test('Unfinished collection performs one read and no sleep or save',async()=>{
    const result=await receiveChat(resumed.request,flow.host);assert.equal(result.status,'pending');assert.deepEqual(flow.calls,{read:1,save:0,exec:0,timer:0});
  });
  await test('Explicit later collection resumes after a new read budget and saves exact UTF-8',async()=>{
    const result=await receiveChat({...resumed.request,deadlineMs:Date.now()+90000},flow.host);assert.equal(result.status,'ready');assert.equal(flow.calls.read,2);assert.equal(flow.calls.save,1);assert.equal(flow.calls.timer,0);
    assert.equal(fs.readFileSync(result.rawPath,'utf8'),answer);assert.ok(fs.readFileSync(result.bodyPath,'utf8').includes("REPORT_BODY 中文  原文' $(literal)。"));assert.equal(result.viewMode,'brief');
  });
  await test('Saved receipt survives a program reset and avoids another Chat read',()=>{
    const result=helpers.receiveJob(resumed.jobPath);assert.equal(result.status,'already_saved');assert.equal(result.quality,'unreviewed');
  });
  await test('Same in-memory completed request with a new read budget is not fetched again',async()=>{
    const before={...flow.calls};await receiveChat({...resumed.request,deadlineMs:Date.now()+100000},flow.host);assert.deepEqual(flow.calls,before);
  });
  for(const variant of ['missing','too-long','unmarked']) await test('Artifact '+variant+' handoff saves full text without emitting the body',async()=>{
    const item=bound(variant);let text='REPORT_BODY_'+variant+' 中文报告\nhttps://example.com/source\n[WEB_OFFLOAD_DONE]\n';
    if(variant==='too-long')text='[WO_BRIEF_BEGIN:'+item.request.briefId+']\n'+'概'.repeat(2001)+'\n[WO_BRIEF_END:'+item.request.briefId+']\n'+text;
    if(variant==='unmarked')text='REPORT_BODY_unmarked 中文报告';
    const ctx=hostFor(item.request,[{answer:text,status:'completed'}]), result=await receiveChat(item.request,ctx.host);
    assert.equal(result.viewMode,'receipt');assert.equal(fs.readFileSync(result.rawPath,'utf8'),text);assert.ok(fs.readFileSync(result.bodyPath,'utf8').includes('REPORT_BODY_'+variant));assert.ok(!JSON.stringify(ctx.output).includes('REPORT_BODY_'));assert.equal(ctx.calls.read,1);
  });
  await test('Explicit full mode still returns complete prose',()=>{
    const body='全文中文\n[WEB_OFFLOAD_DONE]\n';const view=selectChatView(body,{returnMode:'full'},'ready');assert.equal(view.viewMode,'full');assert.ok(view.view.includes('全文中文'));
  });
  await test('Wrong latest request is rejected before saving',async()=>{
    const item=bound('wrong'),ctx=hostFor(item.request,[{answer:complete(item.request),status:'completed'}]);
    ctx.host.tools.mcp__codex_app__read_thread=async()=>packet({...item.request,requestTag:'[WO_REQUEST:other]'},'wrong');
    const result=await receiveChat(item.request,ctx.host);assert.equal(result.status,'request_mismatch');assert.equal(ctx.calls.save,0);
  });
  await test('Save failure retains the body and blocks automatic reread or overwrite',async()=>{
    const item=bound('failed-save'),ctx=hostFor(item.request,[{answer:complete(item.request),status:'completed'}],true);
    await assert.rejects(receiveChat(item.request,ctx.host),/Save failed/);const before={...ctx.calls};await assert.rejects(receiveChat({...item.request,deadlineMs:Date.now()+90000},ctx.host),/previous save failure/);assert.deepEqual(ctx.calls,before);
  });
  await test('Partial existing disk save stops before another receive',()=>{
    const item=bound('partial');fs.writeFileSync(item.request.outputBase+'.raw.md','partial','utf8');assert.throws(()=>helpers.receiveJob(item.jobPath),/Partial existing save/);
  });
  await test('One-shot read allows one capacity expansion but never accepts a capped answer',async()=>{
    const request={chatId,requestTag:'[WO_REQUEST:capacity]',deadlineMs:Date.now()+10000,readMode:'once',initialCap:40};const caps=[];
    const result=await waitForChat(request,{read:async args=>{caps.push(args.maxOutputCharsPerItem);return packet(request,'x'.repeat(args.maxOutputCharsPerItem));},sleep:async()=>{throw Error('unexpected sleep');}});
    assert.deepEqual(caps,[40,20000]);assert.equal(result.status,'truncated');
  });
  await test('Requested automatic polling remains program-owned and opt-in',async()=>{
    const request={chatId,requestTag:'[WO_REQUEST:poll]',deadlineMs:60000,readMode:'poll'};let now=0,reads=0,sleeps=0;
    const result=await waitForChat(request,{now:()=>now,read:async()=>packet(request,++reads===1?'':'complete\n[WEB_OFFLOAD_DONE]\n',reads===1?'in_progress':'completed'),sleep:async ms=>{now+=ms;sleeps++;}});
    assert.equal(result.status,'ready');assert.equal(reads,2);assert.ok(sleeps>0);
  });
  await test('Changed read budget cannot start a second receiver while the first is active',async()=>{
    const item=bound('concurrent'),ctx=hostFor(item.request,[{answer:complete(item.request),status:'completed'}]);let release;
    ctx.host.tools.mcp__codex_app__read_thread=()=>new Promise(resolve=>{ctx.calls.read++;release=resolve;});
    const active=receiveChat(item.request,ctx.host);await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(receiveChat({...item.request,deadlineMs:Date.now()+90000},ctx.host),/existing receiver/);
    release(packet(item.request,complete(item.request)));await active;assert.equal(ctx.calls.read,1);assert.equal(ctx.calls.save,1);
  });
  const sendCode=runtime.split('<!-- submit-batch-example -->')[1].split('```javascript')[1].split('```')[0];
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const send=new AsyncFunction('woSubmission','woPrompt','woInputIndex','woTab','nodeRepl',sendCode);
  await test('Actual documented send batch guards time and duplicate sends',async()=>{
    let clicks=0, reads=0;
    const prompt='[WO_REQUEST:test] task';
    const tab={
      playwright:{
        getByRole:(role,opts)=>{assert.equal(role,'button');assert.equal(opts.name,'发送提示词');return {click:async()=>clicks++};},
        domSnapshot:async()=>{reads++;return prompt;}
      },
      url:async()=>'https://chatgpt.com/c/'+chatId
    };
    await assert.rejects(send({requestTag:'[WO_REQUEST:test]',deadlineMs:Date.now()+30000},prompt,83,tab,{write(){}}),/deadline_too_close/);
    assert.equal(clicks,0);assert.equal(reads,0);
    const state={requestTag:'[WO_REQUEST:test]',deadlineMs:Date.now()+240000,sendAttempted:false};
    await send(state,prompt,83,tab,{write(){}});
    await assert.rejects(send(state,prompt,83,tab,{write(){}}),/do not repeat/);
    assert.equal(clicks,1);assert.equal(reads,1);
  });
  await test('Documented functions example loads helpers privately and reuses disk receipt',async()=>{
    const item=bound('documented'),ctx=hostFor(item.request,[{answer:complete(item.request),status:'completed'}]);
    const example=runtime.split('<!-- receive-example -->')[1].split('```javascript')[1].split('```')[0].replace('"RESOLVED_SKILL_DIRECTORY"',JSON.stringify(skill)).replace('"ACTUAL_PROJECT_JOB_JSON"',JSON.stringify(item.jobPath));
    const run=new AsyncFunction('tools','load','store','text','setTimeout','clearTimeout',example);
    await run(ctx.host.tools,ctx.host.load,ctx.host.store,ctx.host.text,setTimeout,clearTimeout);assert.equal(ctx.calls.read,1);assert.equal(ctx.calls.save,1);assert.ok(!JSON.stringify(ctx.output).includes('function receiveChat'));
    await run(ctx.host.tools,ctx.host.load,ctx.host.store,ctx.host.text,setTimeout,clearTimeout);assert.equal(ctx.calls.read,1);assert.equal(ctx.output.at(-1).status,'already_saved');
  });
  await test('Entrypoint metadata and all relative Markdown references are valid',()=>{
    const md=fs.readFileSync(path.join(skill,'SKILL.md'),'utf8');assert.ok(md.startsWith('---\nname: web-stand-in\n'));assert.ok(md.includes('description: >-'));
    for(const file of ['SKILL.md',...fs.readdirSync(path.join(skill,'references')).filter(x=>x.endsWith('.md')).map(x=>'references/'+x)]) {
      const text=fs.readFileSync(path.join(skill,file),'utf8');for(const m of text.matchAll(/\]\(([^)]+\.md)(?:#[^)]*)?\)/g))if(!/^https?:/.test(m[1]))assert.ok(fs.existsSync(path.resolve(skill,path.dirname(file),m[1])),file+': '+m[1]);
    }
  });
  fs.writeFileSync(path.join(root,'validation.json'),JSON.stringify({at:new Date().toISOString(),status:'passed',checks:results,fixture,liveBrowserTest:false,usageSavingsMeasured:false},null,2)+'\n','utf8');
  console.log(JSON.stringify({status:'passed',checks:results.length,fixture,liveBrowserTest:false}));
})().catch(error=>{fs.writeFileSync(path.join(root,'validation.json'),JSON.stringify({status:'failed',checks:results,error:error.stack,fixture},null,2),'utf8');console.error(error.stack);process.exitCode=1;});
