---
name: web-stand-in
description: >-
  Delegate substantial self-contained research, comparisons or critique to a
  fresh regular ChatGPT Chat when its result can replace meaningful local work.
  Keep trivial work, implementation and ongoing local execution loops local.
---

# 网页替身 · Web Stand-in

Replace substantial unfinished local work with a usable independent Chat result.
Count preparation, browser handling and collection, plus any explicitly requested
review or repair. Consider once at intake,
before researching locally; a heavy task is not automatically worth offloading.

## Prepare

Use only the research question, material scope/date, required evidence and desired
deliverable. Preserve the user's supplied requirements; clarify only consequential
gaps. Do not research the answer merely to prepare its prompt or reconstruct
unrelated conversation/project history. No local data bridge is needed for public
research. Small authorized excerpts may accompany a self-contained task.

Ask for usable output in one generation, without a separate handoff summary.
Whether to research externally, use supplied materials or include sources comes
from the user's task, never from a receipt-checking preference.

Normal use needs no benchmark, budget ledger, worker report or extra coordinator.
Do not automatically spawn agents. Only for explicitly authorized delegation read
[execution-contract.md](references/execution-contract.md).

## Send

On first browser use read [runtime-contract.md](references/runtime-contract.md).
Reuse current bindings and already-read guidance. Require the actual supported
browser and official Chat reader. Prefer a fresh agent-owned tab in the user's
supported Chrome session; leave their existing tabs alone. Use **Regular Chat**, never Work, and
**GPT-5.6 Sol / 极高**; retained user confirmation remains valid unless contradicted.

The helper adds request identity, delivery markers and project output paths.
Send once and bind the observed formal Chat ID. An uncertain send is not permission
to resend. Make at most one bounded recovery inspection, then use a user-assisted
handoff; routine offloading must not turn into browser troubleshooting.

Use one fresh Chat and at most two messages per main goal. Reserve the second
for a material missing answer, not cosmetic formatting or compression. This limit
does not reset on a continuation or change of executor; extra work needs user scope.

## Wait

Default long tasks to deferred collection: save the Chat binding, report the link
and pending state, then end local waiting while the web task continues. When the
user says it is done or asks to collect, check the same Chat once. An unfinished
answer returns pending and ends that receive operation, without more polling.

A send window limits sending; each later receive gets its own bounded read window.
Never change task identity, resend or cancel the web task because local waiting
ended. Explicit cancellation is different. Keep no timer, heartbeat or monitor
running during a deferred handoff. Optional automatic waiting uses the existing
fixed receiver only when requested; count any host-required model resumptions.

## Retrieve

Use the fixed program to bind the right request, retrieve, detect obvious cuts,
and save exact raw text as answer.md with a small receipt. Reuse a saved result
instead of rereading Chat. Scripts and intermediate tool data stay inside functions.

Return only the saved path and completion status. Do not extract a brief, strip
markers, create a second body, rewrite or automatically open the answer. Read the
saved original only when the user's subsequent work actually needs its content.
The receiver uses the file-writing tool for a temporary packet; the save command
contains only its path, never the answer. Require the supported file-writing tool.

For explicitly requested web images or complete downloadable files, use
[file-return.md](references/file-return.md) instead of the text-only receiver.
Keep the original file bytes and return the project path. Do not automatically
expand research routing to every image request based on one successful test.

The default total answer budget is 10,000 characters, based on the tested text
reader path, not a model limit. Never silently clip an answer. If the requested
deliverable cannot fit, use a verified complete-file return path or a user-assisted
file handoff; otherwise keep the task local. Markdown alone does not bypass limits.

## Deliver

Normal offloading ends with sending, deferred collection and delivery of the saved
result. Keep only programmatic checks for the matching request/Chat, completion,
obvious truncation and successful saving. Do not browse sources, inspect content
for correctness, grade quality, rewrite the answer or create an acceptance report
by default. Missing source URLs or unresolved citation codes do not block delivery
and must not start another research pass or a browser citation-recovery loop.

Deliver the saved original's path. Say it was
retrieved, not independently fact-checked. Content/source review is opt-in: perform
it only when the user explicitly requests review or a quality test, and count that
extra work separately. Ordinary reception performs no URL/citation inspection
and emits no content-review flags. Legacy --sources and --mode options are
accepted but do not alter the task or raw-file delivery.

For actual identity, completion or saving failures, read only the needed part of
[recovery-contract.md](references/recovery-contract.md). A pending deferred result
is not a failure. Maintenance checks belong in
[eval-cases.md](references/eval-cases.md), never in ordinary dispatch.
The Windows Chrome send and official-reader return path has completed a real
independent research task. Equal-quality savings and cross-platform support remain
unverified; do not promise a fixed saving or treat browser access as universally available.
