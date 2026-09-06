// web-stand-in-waiter-v5
// Pure JavaScript: all external access is supplied through io.read.
// Tool output is parsed as data, never executed.
// Decode one Markdown escape layer only for protocol-label comparisons.
// The original answer and URLs remain unchanged in the archive.
function decodeProtocolLabel(text) {
  return text.replace(/\\([_:\[\]-])/g, "$1");
}

function inspectCompletion(text, marker = "[WEB_OFFLOAD_DONE]") {
  const lines = text.trimEnd().split(/\r?\n/);
  let fence = null, writing = null, markerLine = -1;
  const wrappers = new Set();
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length &&
               !match[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^ {0,3}:::writing\{[^\r\n]+\}[ \t]*$/.test(lines[i])) {
      if (writing !== null) return null;
      writing = i;
    } else if (/^ {0,3}:::[ \t]*$/.test(lines[i]) && writing !== null) {
      wrappers.add(writing);
      wrappers.add(i);
      writing = null;
    } else if (decodeProtocolLabel(lines[i].replace(/^ {0,3}/, "").trimEnd()) === marker) markerLine = i;
  }
  if (fence || writing !== null || markerLine < 0 ||
      !lines.slice(0, markerLine).some((line, i) => !wrappers.has(i) && line.trim())) return null;
  const tail = lines.slice(markerLine + 1)
    .filter((line, offset) => line.trim() && !wrappers.has(markerLine + 1 + offset));
  // Supported clipboard suffix: one-line Markdown URL reference definitions.
  // Unknown suffixes require review; do not accept arbitrary text after a marker.
  const reference = /^ {0,3}\[[^\]\r\n]+\]:[ \t]+(?:<https?:\/\/[^>\s]+>|https?:\/\/\S+)(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^\)\r\n]*\)))?[ \t]*$/;
  if (!tail.every(line => reference.test(line))) return null;
  // Only a closing writing fence may follow the marker. A new empty writing
  // block is still unexpected trailing content, even though it is balanced.
  if ([...wrappers].some(i => i > markerLine && lines[i].includes(":::writing"))) return null;
  return {evidence: wrappers.size ? "marker_with_writing_blocks" :
    tail.length ? "marker_then_references" : "terminal_marker", markerLine, wrappers};
}

function inspectAnswerEnd(text, marker = "[WEB_OFFLOAD_DONE]") {
  return inspectCompletion(text, marker)?.evidence ?? null;
}

async function waitForChat(options, io) {
  const now = io.now || Date.now;
  const {chatId, deadlineMs, expectedTurnId, requestTag} = options;
  const marker = options.endMarker || "[WEB_OFFLOAD_DONE]";
  const readMode = options.readMode ?? "poll";
  if (!["once", "poll"].includes(readMode)) throw new Error("Choose once or poll.");
  const pollMs = options.pollMs ?? 30000;
  const maxPollMs = options.maxPollMs ?? Math.max(pollMs, 60000);
  let cap = options.initialCap ?? 12000;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(chatId || ""))
    throw new Error("A formal Chat ID is required.");
  if (!(typeof expectedTurnId === "string" && expectedTurnId) &&
      !(typeof requestTag === "string" && requestTag))
    throw new Error("Bind the request by expectedTurnId or a unique requestTag.");
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(pollMs) ||
      pollMs < 1000 || pollMs > 60000 || !Number.isFinite(maxPollMs) ||
      maxPollMs < pollMs || maxPollMs > 60000 || !Number.isInteger(cap) ||
      cap < 1 || cap > 20000 || typeof marker !== "string" || !marker.trim() ||
      /[\r\n]/.test(marker))
    throw new Error("Invalid deadline, polling interval, capacity, or marker.");
  const started = now();
  let turnId = expectedTurnId || null;
  let reads = 0, errors = 0, widened = false, nextRead = started;
  let heartbeat = started + 45000;
  let lastState = "not_read";
  let previousProgress = null, interval = pollMs;
  const result = (status, extra = {}) => ({
    status, chatId, chatUrl: `https://chatgpt.com/c/${chatId}`,
    turnId, requestTag: requestTag ?? null, reads, errors, widened,
    elapsedMs: now() - started, deadlineMs,
    afterDeadline: now() > deadlineMs, ...extra
  });
  const recover = (status, extra = {}) => result(status, {
    lastState, remoteState: "unknown",
    recovery: "recover_current_reply", ...extra
  });
  function pending(state, signature) {
    lastState = state;
    interval = signature === previousProgress ? Math.min(maxPollMs, interval * 1.5) : pollMs;
    previousProgress = signature;
    nextRead = now() + interval;
  }
  function payload(raw) {
    if (raw?.isError) throw new Error("Official reader returned an error.");
    if (raw?.thread && Array.isArray(raw.turns)) return raw;
    if (raw?.structuredContent?.thread &&
        Array.isArray(raw.structuredContent.turns)) return raw.structuredContent;
    for (const item of raw?.content || []) {
      if (item.type !== "text") continue;
      try {
        const parsed = JSON.parse(item.text);
        if (parsed?.thread && Array.isArray(parsed.turns)) return parsed;
      } catch {}
    }
    throw new Error("Unrecognized official return shape.");
  }
  while (true) {
    if (io.isCancelled?.()) return result("cancelled", {remoteState: "unknown"});
    if (now() >= deadlineMs)
      return recover("timeout");
    if (now() >= heartbeat) {
      await io.onProgress?.(result("waiting", {lastState}));
      heartbeat = now() + 45000;
    }
    if (now() < nextRead) {
      await io.sleep(Math.min(nextRead - now(), heartbeat - now(),
                              deadlineMs - now(), 45000));
      continue;
    }
    let data;
    try {
      reads++;
      data = payload(await io.read({
        threadId: chatId, turnLimit: 1, includeOutputs: false,
        maxOutputCharsPerItem: cap
      }));
    } catch {
      errors++;
      if (readMode === "once" || errors >= 2) return recover("read_error");
      lastState = "read_error";
      nextRead = now() + pollMs;
      continue;
    }
    // A read may outlast the local deadline or a cancellation request. The
    // injected reader has no assumed abort API; do not claim remote stopping.
    if (io.isCancelled?.()) return result("cancelled", {remoteState: "unknown"});
    if (data.thread.id !== chatId || data.thread.kind !== "chatgpt")
      return result("identity_mismatch");
    if (data.page?.order && data.page.order !== "newest_first")
      return result("order_mismatch");
    const turn = data.turns[0];
    if (!turn) {
      pending("no_turn", "no_turn");
      if (readMode === "once") return result("pending", {lastState, remoteState:"unknown"});
      continue;
    }
    if (typeof turn.id !== "string" || !turn.id || !Array.isArray(turn.items))
      return recover("unsupported_return");
    if (turn.items.some(x => !x || typeof x !== "object"))
      return recover("unsupported_return");
    if (turnId && turn.id !== turnId)
      return result("turn_mismatch", {observedTurnId: turn.id});
    if (!turnId) {
      const users = turn.items.filter(x => x.type === "userMessage");
      if (users.some(x => typeof x.content !== "string" &&
          (!Array.isArray(x.content) || x.content.some(y => !y || typeof y !== "object"))))
        return recover("unsupported_return");
      const userText = users
        .map(x => typeof x.content === "string" ? x.content :
          (x.content || []).filter(y => y.type === "text").map(y => y.text).join("\n"))
        .join("\n");
      if (!decodeProtocolLabel(userText).includes(requestTag))
        return result("request_mismatch", {observedTurnId: turn.id});
      turnId = turn.id;
    }
    if (turn.error || ["failed", "cancelled", "interrupted"].includes(turn.status))
      return result("remote_error", {remoteStatus: turn.status});
    const agent = (turn.items || []).filter(x => x.type === "agentMessage").at(-1);
    const answer = typeof agent?.text === "string" ? agent.text : "";
    if (turn.status !== "completed" || !answer.trim()) {
      pending(!answer.trim() ? (turn.status === "completed" ?
        "completed_without_answer" : "answer_not_retrieved") : "in_progress",
        JSON.stringify([turn.id, turn.status, agent?.id, answer]));
      if (readMode === "once") return result("pending", {lastState, remoteState:"unknown"});
      continue;
    }
    const answerResult = {answer, answerChars: answer.length, messageId: agent.id};
    // Capacity takes priority even if a cut happens to land on the marker:
    // reference definitions or other content may still be missing.
    if (answer.length >= cap) {
      if (cap < 20000 && !widened) {
        cap = 20000;
        widened = true;
        nextRead = now();
        continue;
      }
      return recover("truncated", answerResult);
    }
    const endEvidence = inspectAnswerEnd(answer, marker);
    const completedAnswer = {...answerResult, endEvidence,
      remoteState: "completed"};
    // The reader reports completion; missing markers do not request a review.
    // The exact answer (including any markers or citation codes) is preserved.
    return result("ready", completedAnswer);
  }
}
if (typeof module !== "undefined" && module.exports)
  module.exports = {waitForChat, inspectAnswerEnd};
