# Runtime contract

Version 1 uses one send, deferred collection and one read per collection request.
Validated environment: Codex desktop on Windows, a supported Chrome browser
control session, and the official Chat reader. The skill does not provide a
browser extension, login session, Chat API, or automatic completion notification.
If either required tool is absent, report that prerequisite; do not improvise
private endpoints, install a browser driver or scan application state.

## Prepare and send

Use scripts/prepare-job.cjs with --task, --project-root, --output-dir and --skill-dir
(all absolute paths). Use --sources false for ordinary transfer-only jobs; keep the
user's evidence requirements in the task itself. --mode defaults to artifact;
decision/full are available when the complete prose is needed in local context.
--minutes (default 25) limits sending, not later collection. The new output
directory contains task.md, prompt.md and job.json, with no worker or ledger.

Load --load-job <job.json> once for the validated prompt and send fields. Do not
print the task or recheck its hash after validation. Runtime instructions need
loading only on first use; reuse them and live browser bindings thereafter.

Follow the actual browser tool's first-call and documentation contract. When
multiple Chrome instances/profiles are present, identify the intended session
from the exposed inventory; the generic "chrome" alias may select another
instance. Browser IDs are session-local. Reuse a verified binding until it is
disconnected, and never hardcode someone else's browser ID or profile.

Create a new agent-owned tab and name its group/session when supported, for
example "🌐 Web Stand-in". Do not take over an existing user Chat or GitHub tab.
The tested advanced interface was browser.tabs.new(), tab.goto(), and
tab.playwright.domSnapshot(), after the browser tools exposed those methods.
Use equivalent currently documented APIs if the runtime differs.

Confirm Regular Chat and the requested model/effort. Default to GPT-5.6 Sol / 极高;
retain user confirmation unless contradicted. Do not silently choose Pro. If the
model is unavailable, report the mismatch instead of claiming an equivalent run.

Resolve the textbox and send button from one current DOM snapshot. Fill the exact
validated prompt, then verify its visible content and the send control. On the
tested Chinese UI the roles were textbox "与 ChatGPT 聊天" and button "发送提示词";
these are observations, not locale-independent selectors.

Keep browser operations bounded: in the tested session new+goto+snapshot and
fill+snapshot each took about 43 seconds; click+snapshot about 46 seconds. A
single 60-second call must not contain an arbitrarily long serial batch. The
job's 180000 ms browser allowance is a historical upper allowance, not a product
guarantee or a reason to keep extending timeouts. Use the host's actual limits.

Initialize woSubmission with this new job's requestTag, sendDeadlineMs as
deadlineMs, and sendAttempted=false; woPrompt is the validated prompt. After the
composer has been verified, use the following guard with the observed locator.
woTab is the existing new Chat tab, not a fresh tab created by this snippet.

<!-- submit-batch-example -->
```javascript
if (woSubmission.sendAttempted) throw new Error("Inspect the existing send; do not repeat it.");
if (!woSubmission.requestTag || !woPrompt.includes(woSubmission.requestTag) ||
    !Number.isFinite(woSubmission.deadlineMs) || Date.now() >= woSubmission.deadlineMs)
  throw new Error("Restore the current request and unexpired deadline; nothing sent.");
if (woSubmission.deadlineMs - Date.now() < 60000)
  throw new Error("deadline_too_close; nothing sent.");
woSubmission.sendAttempted = true;
await woTab.playwright.getByRole("button", {name:"发送提示词", exact:true}).click({timeoutMs:10000});
const submitted = await woTab.playwright.domSnapshot();
nodeRepl.write({url:await woTab.url(), requestObserved:submitted.includes(woSubmission.requestTag)});
```

Require this request's post-send evidence and a formal /c/UUID. A temporary
/c/WEB:... URL is not a Chat ID. Save the formal ID using
--bind-chat <job.json> <observed UUID>. Binding is not sending: it can record a
verified late send, is idempotent for the same Chat, rejects another Chat, and
prevents the send loader from resending. Persist it before ending the turn.

An uncertain click, lost binding or kernel reset does not prove nothing was sent.
Make at most one bounded inspection of the original request; then hand off the
specific blocker to the user. Do not create more Chats or start a browser repair
project during ordinary use. In-app browser use is an explicit alternative when
requested and supported, not an automatic retry after an uncertain Chrome send.

## Deferred collection

After binding, return the Chat link and pending state; end local waiting and leave
web generation running. No active worker, timer, automatic task or heartbeat is
needed. User completion/collection input starts a new receive operation.

The receiver loads the same job from disk. Its fresh read deadline is independent
of sendDeadlineMs. Never modify a send deadline to make a receive pass. This flow
supports new v2 jobs only; historical trial jobs are not silently migrated.

Run --receive-job <job.json> [readMs] to validate identity and get a request; the
default read budget is 60000 ms and the permitted range is 1000–180000 ms.
It returns already_saved if the three matching output files exist, with no Chat
read. Partial or mismatched saves stop for inspection and are never overwritten.
A missing Chat binding must be repaired from observed evidence, not guessed.

Use the following program in functions, supplying the actual skill directory and
job path. It combines request loading and receive; do not first print a full job
or separately read Chat. The source bundle stays inside the program.

<!-- receive-example -->
```javascript
// @exec: {"yield_time_ms": 55000, "max_output_tokens": 4000}
const base = "RESOLVED_SKILL_DIRECTORY";
const jobPath = "ACTUAL_PROJECT_JOB_JSON";
const quote = value => "'" + value.replace(/'/g, "''") + "'";
const prepared = await tools.exec_command({
  cmd: "& 'C:\\Program Files\\nodejs\\node.exe' " +
    quote(base + "/scripts/prepare-job.cjs") + " --receive-job " + quote(jobPath),
  shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", login: false,
  max_output_tokens: 2000
});
if (prepared.exit_code !== 0) throw new Error("Inspect the job/save error; do not resend.");
const received = JSON.parse(prepared.output);
if (received.status === "already_saved") {
  text(received);
} else {
  if (received.status !== "ready_to_receive") throw new Error("Receive is not ready.");
  let bundle = load("webOffloadBundleV4:" + base);
  if (!bundle) {
    const file = await tools.exec_command({
      cmd: "& " + quote(base + "/scripts/chat-files.ps1") + " -Load",
      shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", login: false,
      max_output_tokens: 18000
    });
    if (file.exit_code !== 0) throw new Error("Trusted runtime load failed.");
    bundle = JSON.parse(file.output);
    if (bundle.waiter?.length !== bundle.waiterChars ||
        bundle.receiver?.length !== bundle.receiverChars ||
        !bundle.waiter?.startsWith("// web-offload-waiter-v4") ||
        !bundle.receiver?.startsWith("// web-offload-receiver-v4"))
      throw new Error("Incomplete trusted runtime.");
    store("webOffloadBundleV4:" + base, bundle);
  }
  const run = new Function(bundle.waiter + "\n" + bundle.receiver + "\nreturn receiveChat;")();
  await run(received.request, {tools, store, load, text, setTimeout, clearTimeout, skillDirectory:base});
}
```

Use a larger outer output budget (for example 12000) when requesting decision/full.
If the host yields during one read, resume the same cell; never launch another
receiver. A read can outlast its requested deadline because the current reader
has no assumed abort API. Do not promise an exact timeout or zero model re-entry.

An unfinished reply returns pending without scheduling another read. An explicit
later collection can read it again with a fresh budget. A complete reply at the
reader cap permits one larger same-reply read; this is capacity recovery, not
another generation. Explicit cancellation prevents automatic recovery.

## Save and deliver

The program creates .raw.md, .md and .receipt.json without overwriting. Artifact
mode preserves the complete deliverable and returns the existing brief, normally
at most 2000 characters. Missing, ambiguous, empty or longer briefs return a small
review notice plus paths, never a default full-text fallback. needs_review also
stays compact in artifact mode. decision/full intentionally return complete prose.

A 10,000-character request budget fits below previously observed 12,000/20,000
reader capacities; these are local observations, not a product guarantee. A saved
oversized answer remains complete and is delivered with its size notice. A capacity-cut answer is
never accepted as complete. Do not shorten needed substance to force it through.

Return the saved result/path and existing brief; do not open the report, check
sources, grade content or write an acceptance note during normal delivery. Reader
fields such as reviewRequired/needs_review do not authorize a source or content
audit. Missing citations do not block delivery. User-requested quality testing is
a separate activity. Follow only the needed recovery section for actual identity,
completion, truncation or saving problems.

## Optional automatic waiting

Only when requested, use readMode:"poll" instead of "once" and a deliberately
chosen read deadline. A long active run uses recordProgress:true; the existing
receiver records .heartbeat.jsonl every 45 seconds without model-authored patches.
Report its path. Resume only the same functions cell when required; count those
model resumptions. Do not poll through the browser or another agent too.

Returning pending in the default deferred mode requires no remote Stop. If the
user explicitly cancels, use the supported Stop action once when applicable and
disclose an unconfirmed remote stop.
