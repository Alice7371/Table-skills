'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
function realInside(root, value, name) {
  const resolved = path.resolve(value);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))
    throw new Error(`${name} must be strictly inside project root`);
  let cursor = resolved;
  while (pathKey(cursor) !== pathKey(root)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
      throw new Error(`${name} contains a junction or symbolic link`);
    const parent = path.dirname(cursor);
    if (pathKey(parent) === pathKey(cursor)) throw new Error(`${name} project boundary could not be verified`);
    cursor = parent;
  }
  return resolved;
}
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function prepareJob(options) {
  const {task, projectRoot, outputDir, skillDir, minutes = 25,
    requireSourceLinks, returnMode, maxAnswerChars = 10000} = options;
  for (const [key, value] of Object.entries({task, projectRoot, outputDir, skillDir})) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\0]/.test(value) ||
        (process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(value) || value.slice(2).includes(':'))))
      throw new Error('Absolute local path required: ' + key);
  }
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) throw new Error('Send minutes must be in (0,60]');
  // Accept old CLI options without letting transport preferences change the task.
  if ((requireSourceLinks !== undefined && typeof requireSourceLinks !== 'boolean') ||
      (returnMode !== undefined && !['artifact','decision','full'].includes(returnMode)) ||
      !Number.isInteger(maxAnswerChars) || maxAnswerChars < 1 || maxAnswerChars > 10000) throw new Error('Invalid delivery options');
  const root = path.resolve(projectRoot);
  if (!fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('Invalid project root');
  const input = realInside(root, task, 'Task'), out = realInside(root, outputDir, 'Output');
  if (fs.existsSync(out)) throw new Error('Output directory already exists; nothing overwritten');
  if (pathKey(path.resolve(skillDir)) !== pathKey(path.resolve(__dirname, '..'))) throw new Error('Use this helper with its own skill directory');
  const source = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(fs.readFileSync(input));
  if (!source.replace(/^\uFEFF/, '').trim()) throw new Error('Empty task');
  if (/\[WO_(?:REQUEST|BRIEF_BEGIN|BRIEF_END):|\[WEB_OFFLOAD_DONE\]/.test(source)) throw new Error('Task contains reserved transport labels');
  const id = crypto.randomUUID(), requestTag = '[WO_REQUEST:' + id + ']', now = Date.now();
  const protocol = requestTag + '\n任务标记仅用于匹配，不要在答复中重复。\n' +
    '一次生成完整、可直接使用的 Markdown 答复。是否联网、使用哪些材料以及来源要求，以以下任务为准。\n' +
    '整份答复不超过 ' + maxAnswerChars + ' 字符，包含链接；不要为了篇幅省略必要结论，也不要另做一轮压缩。\n' +
    '最后以 [WEB_OFFLOAD_DONE] 独占一行结束。\n\n';
  const prompt = protocol + source;
  const job = {
    schema:'web-offload-job-v3', status:'prepared_not_started', jobId:id,
    createdAtUtc:new Date(now).toISOString(), sendDeadlineMs:now + minutes * 60000,
    requestTag, maxAnswerChars,
    projectRoot:root, outputBase:path.join(out,'answer'), skillDirectory:path.resolve(skillDir),
    taskPath:path.join(out,'task.md'), promptPath:path.join(out,'prompt.md'),
    taskSha256:hash(source), promptSha256:hash(prompt), waitPolicy:'deferred',
    maximumNewChats:1, maximumSends:1, modelPreference:{web:'GPT-5.6 Sol / 极高'},
    browserCallTimeoutMs:180000, recordProgress:false
  };
  fs.mkdirSync(out,{recursive:true});
  for (const [name,text] of Object.entries({'task.md':source,'prompt.md':prompt,'job.json':JSON.stringify(job,null,2)+'\n'}))
    fs.writeFileSync(path.join(out,name),text,{encoding:'utf8',flag:'wx'});
  return {status:job.status, jobPath:path.join(out,'job.json'), taskChars:source.length, promptChars:prompt.length, sendDeadlineMs:job.sendDeadlineMs};
}
function readRecord(jobPath) {
  if (typeof jobPath !== 'string' || !path.isAbsolute(jobPath)) throw new Error('Absolute job path required');
  const job = JSON.parse(fs.readFileSync(jobPath,'utf8').replace(/^\uFEFF/,''));
  if (!['web-offload-job-v2','web-offload-job-v3'].includes(job.schema) || !uuidPattern.test(job.jobId || '') ||
      !Number.isFinite(job.sendDeadlineMs)) throw new Error('Invalid job; legacy trials are not silently migrated');
  const root=path.resolve(job.projectRoot), dir=path.dirname(path.resolve(jobPath));
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Project root is a junction');
  realInside(root,jobPath,'Job');
  for (const [field,name] of [['taskPath','task.md'],['promptPath','prompt.md'],['outputBase','answer']]) {
    if (typeof job[field] !== 'string' || pathKey(path.resolve(job[field])) !== pathKey(path.join(dir,name))) throw new Error('Job file layout mismatch');
    realInside(root,job[field],field);
  }
  const decode=file=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(fs.readFileSync(file));
  const task=decode(job.taskPath), prompt=decode(job.promptPath);
  if (hash(task)!==job.taskSha256 || hash(prompt)!==job.promptSha256 || !prompt.endsWith(task)) throw new Error('Task or prompt integrity mismatch');
  if (job.requestTag !== '[WO_REQUEST:'+job.jobId+']' || !prompt.startsWith(job.requestTag+'\n')) throw new Error('Request identity mismatch');
  if (pathKey(path.resolve(job.skillDirectory))!==pathKey(path.resolve(__dirname,'..'))) throw new Error('Skill directory mismatch');
  return {job,prompt};
}
function loadJob(jobPath, now=Date.now(), includeRuntime=false) {
  const {job,prompt}=readRecord(jobPath);
  if (job.chatId || job.status!=='prepared_not_started') throw new Error('Already bound; receive the original Chat, never resend');
  if (job.sendDeadlineMs<=now) throw new Error('Send window expired; do not silently reset or send');
  const result={status:'validated_not_sent',job,remainingMs:job.sendDeadlineMs-now,browserCallTimeoutMs:job.browserCallTimeoutMs,prompt};
  if (includeRuntime) result.runtimeContract=fs.readFileSync(path.join(__dirname,'../references/runtime-contract.md'),'utf8');
  return result;
}
function bindChat(jobPath,chatId,now=Date.now()) {
  const {job}=readRecord(jobPath);
  if (!uuidPattern.test(chatId || '')) throw new Error('Observed formal Chat UUID required');
  if (job.chatId && job.chatId!==chatId) throw new Error('Already bound to another Chat; do not replace');
  if (!job.chatId) {
    if (job.status!=='prepared_not_started') throw new Error('Unexpected job state');
    job.chatId=chatId; job.status='awaiting_result'; job.sentAtUtc=new Date(now).toISOString();
    const temp=jobPath+'.'+crypto.randomUUID()+'.tmp';
    fs.writeFileSync(temp,JSON.stringify(job,null,2)+'\n',{encoding:'utf8',flag:'wx'});
    fs.renameSync(temp,jobPath);
  }
  return {status:job.status,jobPath,chatUrl:'https://chatgpt.com/c/'+job.chatId,waitPolicy:'deferred'};
}
function receiveJob(jobPath,readMs=60000,now=Date.now()) {
  const {job}=readRecord(jobPath);
  if (!uuidPattern.test(job.chatId || '') || job.status!=='awaiting_result') throw new Error('Bind the verified sent Chat before receiving');
  if (!Number.isFinite(readMs) || readMs<1000 || readMs>180000) throw new Error('Read budget must be 1000–180000 ms');
  const rawPath=job.outputBase+'.raw.md', answerPath=job.outputBase+'.md', receiptPath=job.outputBase+'.receipt.json';
  const present=[rawPath,answerPath,receiptPath].filter(p=>fs.existsSync(p));
  if (present.length) {
    if (!fs.existsSync(answerPath) || !fs.existsSync(receiptPath)) throw new Error('Partial existing save; inspect it without rereading or overwriting');
    for (const p of present) realInside(job.projectRoot,p,'Saved result');
    const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
    const legacy = receipt.schemaVersion === 1 && job.schema === 'web-offload-job-v2';
    if (legacy && present.length!==3) throw new Error('Partial existing save; inspect it without rereading or overwriting');
    const layoutMatches = legacy
      ? pathKey(receipt.rawPath || '')===pathKey(rawPath) && pathKey(receipt.bodyPath || '')===pathKey(answerPath)
      : receipt.schemaVersion===2 && present.length===2 && pathKey(receipt.answerPath || '')===pathKey(answerPath);
    if (receipt.chatId!==job.chatId || receipt.requestTag!==job.requestTag ||
        !(legacy ? ['ready','needs_review'] : ['ready']).includes(receipt.bodyStatus) || !layoutMatches)
      throw new Error('Saved result identity mismatch');
    return {status:'already_saved',answerPath:legacy ? rawPath : answerPath,receiptPath,quality:'unreviewed'};
  }
  // Reserve a replace-once packet. The file tool updates this exact seed, so an
  // interrupted save cannot be silently overwritten by a later receive.
  const packetPath=realInside(job.projectRoot,job.outputBase+'.packet.json','Packet');
  const packetSeed=JSON.stringify({pending:job.requestTag});
  if (!fs.existsSync(packetPath)) fs.writeFileSync(packetPath,packetSeed+'\n',{encoding:'utf8',flag:'wx'});
  else if (fs.readFileSync(packetPath,'utf8')!==packetSeed+'\n')
    throw new Error('Partial existing save packet; retain it without rereading or overwriting');
  return {status:'ready_to_receive',request:{
    chatId:job.chatId,requestTag:job.requestTag,maxAnswerChars:job.maxAnswerChars,packetPath,packetSeed,
    projectRoot:job.projectRoot,outputBase:job.outputBase,deadlineMs:now+readMs,readMode:'once',recordProgress:false
  }};
}
if (require.main===module) {
  try {
    const args=process.argv.slice(2); let result;
    if (args[0]==='--load-job') {
      if (args.length!==2 && !(args.length===3 && args[2]==='--include-runtime')) throw new Error('Expected job path and optional --include-runtime');
      result=loadJob(args[1],Date.now(),args[2]==='--include-runtime');
    } else if (args[0]==='--bind-chat') {
      if (args.length!==3) throw new Error('Expected job path and observed Chat UUID');
      result=bindChat(args[1],args[2]);
    } else if (args[0]==='--receive-job') {
      if (args.length!==2 && args.length!==3) throw new Error('Expected job path and optional read budget in milliseconds');
      result=receiveJob(args[1],args[2]===undefined?60000:Number(args[2]));
    } else {
      const options={}, names={'--task':'task','--project-root':'projectRoot','--output-dir':'outputDir','--skill-dir':'skillDir','--minutes':'minutes','--sources':'requireSourceLinks','--mode':'returnMode'};
      for(let i=0;i<args.length;i+=2) {
        if(!names[args[i]] || args[i+1]===undefined) throw new Error('Expected named option and value');
        options[names[args[i]]]=args[i+1];
      }
      if(options.minutes!==undefined) options.minutes=Number(options.minutes);
      if(options.requireSourceLinks!==undefined) {
        if(!['true','false'].includes(options.requireSourceLinks)) throw new Error('--sources must be true or false');
        options.requireSourceLinks=options.requireSourceLinks==='true';
      }
      result=prepareJob(options);
    }
    process.stdout.write(JSON.stringify(result)+'\n');
  } catch(error) { process.stderr.write(error.message+'\n'); process.exitCode=1; }
}
module.exports={prepareJob,loadJob,bindChat,receiveJob};
