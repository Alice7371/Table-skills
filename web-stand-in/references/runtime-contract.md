# Runtime contract

The raw-file flow uses one send, deferred collection and one read per collection request.
Validated environment: Codex desktop on Windows, a supported Chrome browser
control session, and the official Chat reader. The skill does not provide a
browser extension, login session, Chat API, or automatic completion notification.
It also requires tools.apply_patch for programmatic packet writing and local
PowerShell 7 / Node.js. If any required tool is absent, report it; do not improvise
private endpoints, install a browser driver or scan application state.

## Prepare and send

Use scripts/prepare-job.cjs with --task, --project-root, --output-dir and --skill-dir
(all absolute paths). Research and source requirements come from the task itself.
No sources/mode option is needed: all results are saved verbatim with paths only
returned. Legacy --sources true/false and --mode artifact/decision/full are
accepted as deprecated no-ops; neither changes the prompt or return format.
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

In the 2026-09-06 paired text sample, both Chrome and the in-app browser sent once
and the official reader saved identical answers in one read each. The in-app
combined create/open/AX call timed out; getting the already-created tab and using
separate DOM/fill/click calls then worked. Prefer bounded documented calls and
reuse an observed tab after a timeout rather than opening another one. This one
pair does not establish an efficiency winner or explain the internal timeout.

## Deferred collection

After binding, return the Chat link and pending state; end local waiting and leave
web generation running. No active worker, timer, automatic task or heartbeat is
needed. User completion/collection input starts a new receive operation.

The receiver loads the same job from disk. Its fresh read deadline is independent
of sendDeadlineMs. Never modify a send deadline to make a receive pass. This flow
creates v3 jobs and accepts published v2 jobs without changing their saved prompt,
task hash, Chat identity or send window. Earlier trial schemas are not migrated.

Run --receive-job <job.json> [readMs] to validate identity and get a request; the
default read budget is 60000 ms and the permitted range is 1000–180000 ms.
It returns already_saved for a matching answer.md + receipt, or an existing v2
three-file save, without reading Chat. Legacy saves return their raw original.
For an unsaved job it reserves answer.packet.json with a request-specific seed.
The file-writing tool replaces that exact seed once. Partial/mismatched saves,
including a filled packet from an interrupted transfer, are not overwritten.
A missing Chat binding must be repaired from observed evidence, not guessed.

Use the following program in functions, supplying the actual skill directory and
job path. It combines request loading and receive; do not first print a full job
or separately read Chat. The source bundle stays inside the program.

<!-- receive-example -->
```javascript
// @exec: {"yield_time_ms": 55000, "max_output_tokens": 1200}
const base = "RESOLVED_SKILL_DIRECTORY";
const jobPath = "ACTUAL_PROJECT_JOB_JSON";
const quote = value => "'" + value.replace(/'/g, "''") + "'";
const prepared = await tools.exec_command({
  cmd: "& node " +
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
  let bundle = load("webStandInBundleV5:" + base);
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
        !bundle.waiter?.startsWith("// web-stand-in-waiter-v5") ||
        !bundle.receiver?.startsWith("// web-stand-in-receiver-v5"))
      throw new Error("Incomplete trusted runtime.");
    store("webStandInBundleV5:" + base, bundle);
  }
  const run = new Function(bundle.waiter + "\n" + bundle.receiver + "\nreturn receiveChat;")();
  await run(received.request, {tools, store, load, text, setTimeout, clearTimeout, skillDirectory:base});
}
```

Node must be available on PATH; do not assume the user's install directory.
If the host yields during one read, resume the same cell; never launch another
receiver. A read can outlast its requested deadline because the current reader
has no assumed abort API. Do not promise an exact timeout or zero model re-entry.

An unfinished reply returns pending without scheduling another read. An explicit
later collection can read it again with a fresh budget. A complete reply at the
reader cap permits one larger same-reply read; this is capacity recovery, not
another generation. Explicit cancellation prevents automatic recovery.

## Save and deliver

The program updates the reserved packet using tools.apply_patch inside functions,
then calls chat-files.ps1 -PacketPath <path>. The answer is a JSON value, never
shell code or part of command arguments. The script creates .md and .receipt.json
without overwriting, then removes only its validated temporary packet on success.
Whitespace, markers, brief (if any) and citation codes remain exact. Only status
and paths are emitted: no extraction, URL checks, review flags or automatic
full-text return. On failure, partial files and the packet remain available.

A 10,000-character request budget fits below previously observed 12,000/20,000
reader capacities; these are local observations, not a product guarantee. A saved
oversized answer remains complete; it does not trigger a quality review. A capacity-cut answer is
never accepted as complete. Do not shorten needed substance to force it through.

Return the saved original's path and completion status; do not open the report,
check sources, grade content or write an acceptance note during normal delivery.
No brief or citation metadata is produced. User-requested quality testing is
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
