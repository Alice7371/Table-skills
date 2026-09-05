// web-offload-receiver-v4
// Loaded together with the trusted waiter, inside functions. Never eval Chat text.
function selectChatView(answer, request, bodyStatus) {
  const full = {delivery: answer, view: answer, viewMode: "full", viewReason: bodyStatus};
  const compactFallback = reason => ({delivery: full.delivery,
    view: "完整答复已保存；未提取到可靠的简短交接。请按验收要求读取本地正文，质量尚未验收。",
    viewMode: "receipt", viewReason: reason});
  if (bodyStatus !== "ready")
    return request.returnMode === "artifact" ? compactFallback(bodyStatus) : full;
  full.delivery = prepareChatDelivery(answer, request.endMarker);
  full.view = full.delivery;
  full.viewReason = "requested_full_answer";
  if (request.returnMode !== "artifact") return full;
  const begin = `[WO_BRIEF_BEGIN:${request.briefId}]`;
  const end = `[WO_BRIEF_END:${request.briefId}]`;
  const lines = full.delivery.split(/\r?\n/);
  let fence = null;
  const starts = [], ends = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null;
      continue;
    }
    if (fence || /^(?: {4}|\t)/.test(lines[i])) continue;
    if (decodeProtocolLabel(lines[i].trim()) === begin) starts.push(i);
    if (decodeProtocolLabel(lines[i].trim()) === end) ends.push(i);
  }
  const first = lines.findIndex(line => line.trim());
  if (starts.length !== 1 || ends.length !== 1 || starts[0] !== first || ends[0] <= starts[0])
    return compactFallback("brief_format_needs_review");
  const newline = full.delivery.includes("\r\n") ? "\r\n" : "\n";
  const brief = lines.slice(starts[0] + 1, ends[0]).join(newline).trim();
  const body = lines.slice(ends[0] + 1).join(newline);
  if (!brief || !body.trim()) return compactFallback("brief_or_body_missing");
  if (brief.length > (request.maxBriefChars ?? 2000))
    return compactFallback("brief_too_long_saved");
  // The brief is model-authored text, not proof that all material facts survived.
  // Preserve its complete accompanying artifact and exact original separately.
  return {delivery: body, view: brief, viewMode: "brief", viewReason: "unreviewed_handoff"};
}

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
  if (!request || !["decision", "artifact", "full"].includes(request.returnMode))
    throw new Error("Select decision, artifact or full before dispatch.");
  if (request.returnMode === "artifact" && !/^[A-Za-z0-9_-]{1,80}$/.test(request.briefId || ""))
    throw new Error("An artifact needs the briefId chosen before sending.");
  if (request.maxBriefChars !== undefined && (!Number.isInteger(request.maxBriefChars) || request.maxBriefChars < 1))
    throw new Error("Invalid brief view size; answers are never silently truncated.");
  const maxAnswerChars = request.maxAnswerChars ?? 10000;
  if (!Number.isInteger(maxAnswerChars) || maxAnswerChars < 1 || maxAnswerChars > 10000 ||
      (request.requireSourceLinks !== undefined && typeof request.requireSourceLinks !== "boolean") ||
      (request.recordProgress !== undefined && typeof request.recordProgress !== "boolean"))
    throw new Error("Choose a 1–10000 character answer budget and a boolean source-link requirement.");
  if (![request.projectRoot, request.outputBase, host.skillDirectory].every(path =>
      typeof path === "string" && /^[A-Za-z]:[\\/]/.test(path) && !/[\r\n]/.test(path)))
    throw new Error("Preselect absolute project, output base and trusted skill paths.");
  const key = "webOffloadRunV4:" + JSON.stringify([request.chatId, request.requestTag, request.expectedTurnId]);
  if (!Number.isFinite(request.deadlineMs)) throw new Error("Choose a deadline for this receive operation.");
  const {deadlineMs: readDeadline, readMode, recordProgress, ...deliveryIdentity} = request;
  const signature = JSON.stringify(deliveryIdentity);
  let state = host.load(key);
  if (state && state.signature !== signature)
    throw new Error("Resume the original request, deadline and output choices.");
  if (state?.running) throw new Error("The existing receiver owns this request; resume its cell.");
  if (state?.saveAttempted && !state.saved)
    throw new Error("Inspect the previous save failure; raw answer is retained, no reread or overwrite.");
  if (!state) state = {signature, running: false, result: null, saved: null, saveAttempted: false};
  state.running = true;
  host.store(key, state);
  let heartbeat = null;
  try {
    // A later explicit receive gets its own read budget, but keeps the original task.
    // Never restart an active cell or replay a saved answer.
    if (state.result && !state.saved && ["pending", "timeout", "read_error"].includes(state.result.status))
      state.result = null;
    if (!state.result) {
      heartbeat = await startChatHeartbeat(request, host, state);
      state.result = await waitForChat({...request, readMode: request.readMode ?? "once"}, {
        read: args => host.tools.mcp__codex_app__read_thread(args),
        sleep: ms => new Promise(resolve => host.setTimeout(resolve, ms)),
        onProgress: value => {
          host.store("webOffloadProgress", {status:value.status, lastState:value.lastState, reads:value.reads});
          heartbeat?.update(value);
        },
        ...(host.isCancelled ? {isCancelled: host.isCancelled} : {})
      });
      host.store(key, state);
    }
    const result = state.result;
    host.store("webOffloadResult", result);
    const usableBody = ["ready", "needs_review"].includes(result.status) && typeof result.answer === "string";
    if (!usableBody) {
      if (heartbeat) { state.progress = await heartbeat.finish(result.status); heartbeat = null; }
      host.text({status: result.status, chatUrl: result.chatUrl, reads: result.reads,
        afterDeadline: result.afterDeadline, recovery: result.recovery, quality: "unreviewed",
        partialAnswerChars: result.answer?.length ?? 0, partialRetainedIn: "webOffloadResult", progress:state.progress});
      return result;
    }
    const selected = selectChatView(result.answer, request, result.status);
    const citations = result.citationTransport ?? inspectCitationTransport(result.answer);
    const deliveryChecks = {maxAnswerChars, answerChars: result.answer.length,
      withinBudget: result.answer.length <= maxAnswerChars,
      sourceLinksRequired: request.requireSourceLinks === true,
      plainUrlCount: citations.plainUrlCount, citationState: citations.state};
    deliveryChecks.reviewRequired = !deliveryChecks.withinBudget || citations.state === "unresolved" ||
      (deliveryChecks.sourceLinksRequired && !deliveryChecks.plainUrlCount);
    if (!state.saved) {
      const packet = {projectRoot: request.projectRoot, outputBase: request.outputBase,
        raw: result.answer, delivery: selected.delivery,
        receipt: {schemaVersion: 1, chatId: result.chatId, turnId: result.turnId,
          requestTag: result.requestTag, bodyStatus: result.status,
          answerChars: result.answerChars, viewMode: selected.viewMode,
          viewReason: selected.viewReason, quality: "unreviewed", deliveryChecks}};
      const quote = value => "'" + value.replace(/'/g, "''") + "'";
      state.saveAttempted = true;
      host.store(key, state);
      const saved = await host.tools.exec_command({
        cmd: "& " + quote(host.skillDirectory + "/scripts/chat-files.ps1") + " -PacketJson " + quote(JSON.stringify(packet)),
        shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", login: false, max_output_tokens: 1200
      });
      if (saved.exit_code !== 0) throw new Error("Save failed; inspect existing paths, retain raw answer and do not resend.");
      const paths = JSON.parse(saved.output);
      if (paths.status !== "saved") throw new Error("Save is unconfirmed; raw answer remains in the receiver state.");
      state.saved = paths;
      host.store(key, state);
    }
    if (heartbeat) { state.progress = await heartbeat.finish(result.status); heartbeat = null; }
    const receipt = {status: result.status, chatUrl: result.chatUrl, reads: result.reads,
      afterDeadline: result.afterDeadline, ...state.saved, viewMode: selected.viewMode,
      viewReason: selected.viewReason, quality: "unreviewed", deliveryChecks, progress:state.progress};
    receipt.status = result.status;
    host.text(receipt);
    host.text(selected.view);
    return receipt;
  } finally {
    if (heartbeat) state.progress = await heartbeat.finish('failed');
    state.running = false;
    host.store(key, state);
  }
}
