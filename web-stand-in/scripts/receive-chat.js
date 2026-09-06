// web-stand-in-receiver-v5
// Loaded with the trusted waiter inside functions. Chat text is data, never code.
async function startChatHeartbeat(request, host, state) {
  if (!request.recordProgress) return null;
  if (!host.clearTimeout) throw new Error('Program heartbeats require setTimeout and clearTimeout.');
  let stopped = false, timer = null, pending = Promise.resolve(), warning = null;
  let status = 'receiving';
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  async function write(value) {
    if (warning) return;
    try {
      const packet = {projectRoot:request.projectRoot, outputBase:request.outputBase,
        chatId:request.chatId, requestTag:request.requestTag, status:value, start:!state.progressCreated};
      const result = await host.tools.exec_command({
        cmd:'& ' + quote(host.skillDirectory + '/scripts/chat-files.ps1') + ' -ProgressJson ' + quote(JSON.stringify(packet)),
        shell:'C:\\Program Files\\PowerShell\\7\\pwsh.exe', login:false, max_output_tokens:300
      });
      if (result.exit_code !== 0 || JSON.parse(result.output).status !== 'progress_saved') throw new Error('progress');
      state.progressCreated = true;
    } catch { warning = 'progress_log_failed'; }
  }
  function schedule() {
    if (stopped || warning) return;
    timer = host.setTimeout(() => {
      pending = write(status).then(schedule);
    }, 45000);
  }
  await write(status);
  schedule();
  return {
    update(value) { status = value.lastState || value.status || 'waiting'; },
    async finish(value) {
      stopped = true;
      if (timer !== null) host.clearTimeout(timer);
      await pending;
      await write(value);
      return {path:state.progressCreated ? request.outputBase + '.heartbeat.jsonl' : null, warning};
    }
  };
}
async function receiveChat(request, host) {
  const maxAnswerChars = request?.maxAnswerChars ?? 10000;
  if (!request || !Number.isInteger(maxAnswerChars) || maxAnswerChars < 1 || maxAnswerChars > 10000 ||
      (request.recordProgress !== undefined && typeof request.recordProgress !== "boolean"))
    throw new Error("Choose a 1–10000 character answer budget.");
  if (![request.projectRoot, request.outputBase, request.packetPath, host.skillDirectory].every(path =>
      typeof path === "string" && /^[A-Za-z]:[\\/]/.test(path) && !/[\r\n\0]/.test(path)))
    throw new Error("Preselect absolute project, output and trusted skill paths.");
  const pathKey = path => path.replace(/\\/g, "/").toLowerCase();
  if (pathKey(request.packetPath) !== pathKey(request.outputBase + ".packet.json") ||
      request.packetSeed !== JSON.stringify({pending:request.requestTag}))
    throw new Error("Use the packet reserved by the job loader.");
  if (typeof host.tools.apply_patch !== "function")
    throw new Error("The file-writing tool is required; do not put the answer in a shell command.");
  const key = "webStandInRunV5:" + JSON.stringify([request.chatId, request.requestTag, request.expectedTurnId]);
  if (!Number.isFinite(request.deadlineMs)) throw new Error("Choose a deadline for this receive operation.");
  const {deadlineMs, readMode, recordProgress, ...deliveryIdentity} = request;
  const signature = JSON.stringify(deliveryIdentity);
  let state = host.load(key);
  if (state && state.signature !== signature)
    throw new Error("Resume the original request and output choices.");
  if (state?.running) throw new Error("The existing receiver owns this request; resume its cell.");
  if (state?.saveAttempted && !state.saved)
    throw new Error("Inspect the previous save failure; raw answer is retained, no reread or overwrite.");
  if (!state) state = {signature, running:false, result:null, saved:null, saveAttempted:false};
  state.running = true;
  host.store(key, state);
  let heartbeat = null;
  try {
    if (state.result && !state.saved && ["pending", "timeout", "read_error"].includes(state.result.status))
      state.result = null;
    if (!state.result) {
      heartbeat = await startChatHeartbeat(request, host, state);
      const readChat = typeof waitForChat === "function" ? waitForChat : require("./wait-for-chat.js").waitForChat;
      state.result = await readChat({...request, readMode:request.readMode ?? "once"}, {
        read: args => host.tools.mcp__codex_app__read_thread(args),
        sleep: ms => new Promise(resolve => host.setTimeout(resolve, ms)),
        onProgress: value => {
          host.store("webOffloadProgress", {status:value.status, lastState:value.lastState, reads:value.reads});
          heartbeat?.update(value);
        },
        ...(host.isCancelled ? {isCancelled:host.isCancelled} : {})
      });
      host.store(key, state);
    }
    const result = state.result;
    host.store("webOffloadResult", result);
    if (result.status !== "ready" || typeof result.answer !== "string") {
      if (heartbeat) { state.progress = await heartbeat.finish(result.status); heartbeat = null; }
      host.text({status:result.status, chatUrl:result.chatUrl, reads:result.reads,
        afterDeadline:result.afterDeadline, recovery:result.recovery,
        partialAnswerChars:result.answer?.length ?? 0, partialRetainedIn:"webOffloadResult",
        ...(state.progress ? {progress:state.progress} : {})});
      return result;
    }
    if (!state.saved) {
      const packet = {projectRoot:request.projectRoot, outputBase:request.outputBase, raw:result.answer,
        receipt:{schemaVersion:2, chatId:result.chatId, turnId:result.turnId,
          requestTag:result.requestTag, bodyStatus:"ready", answerChars:result.answer.length,
          quality:"unreviewed"}};
      state.saveAttempted = true;
      host.store(key, state);
      // One JSON line preserves every original newline/quote/Unicode character.
      // Update the reserved seed instead of adding/overwriting an arbitrary file.
      const patch = "*** Begin Patch\n*** Update File: " + request.packetPath.replace(/\\/g, "/") +
        "\n@@\n-" + request.packetSeed + "\n+" + JSON.stringify(packet) + "\n*** End Patch";
      const staged = await host.tools.apply_patch(patch);
      if (staged?.isError) throw new Error("Save failed writing the packet; retain the answer and do not reread.");
      const quote = value => "'" + value.replace(/'/g, "''") + "'";
      const saved = await host.tools.exec_command({
        cmd:"& " + quote(host.skillDirectory + "/scripts/chat-files.ps1") + " -PacketPath " + quote(request.packetPath),
        shell:"C:\\Program Files\\PowerShell\\7\\pwsh.exe", login:false, max_output_tokens:600
      });
      if (saved.exit_code !== 0) throw new Error("Save failed; inspect existing paths, retain raw answer and do not resend.");
      const paths = JSON.parse(saved.output);
      if (paths.status !== "saved") throw new Error("Save is unconfirmed; raw answer remains in the receiver state.");
      state.saved = paths;
      host.store(key, state);
    }
    if (heartbeat) { state.progress = await heartbeat.finish("ready"); heartbeat = null; }
    const receipt = {status:"ready", chatUrl:result.chatUrl, reads:result.reads,
      ...state.saved, quality:"unreviewed", afterDeadline:result.afterDeadline,
      ...(state.progress ? {progress:state.progress} : {})};
    receipt.status = "ready";
    host.text(receipt);
    return receipt;
  } finally {
    if (heartbeat) state.progress = await heartbeat.finish("failed");
    state.running = false;
    host.store(key, state);
  }
}
if (typeof module !== "undefined" && module.exports) module.exports = {receiveChat};
