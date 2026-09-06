# Bounded recovery

Normal deferred collection is in [runtime-contract.md](runtime-contract.md).
Pending is not a failure: end local collection and leave the web task running.
A later user collection request creates a new local read budget, while preserving
the original Chat and request identity. Do not revive an expired send window.

## Original answer delivery

A completed answer is saved verbatim, including any brief, markers and citation
codes. Return paths and status only. Do not extract a summary, open the report for
content review, reread Chat, output all prose or ask for a new summary.

## Reader failure or capacity cut

Keep the same request and any already held body. A body at the configured reader
cap can require one larger read, up to the observed 20,000-character capacity.
If it still looks cut, do not report complete transport or silently shorten it.

Use at most one browser recovery inspection of the existing Chat and corresponding
latest reply. Identify both from observed URL/request evidence, not an older Copy
button, a sidebar spinner or a title. No new Chat, resend, second polling surface
or exploratory browser repair loop. If it cannot be resolved, request one manual
handoff of the original result and say which step is incomplete.

A complete reply's own ending and response controls can support manual retrieval.
Use only the currently documented copy/download interface, and inspect its
documentation before a new upload/download route. Do not assume that a Markdown
extension creates a complete-file transfer path. Distinguish a truncated tool
display from a genuinely incomplete retrieved body.

## Save failure

The receiver retains its answer in program state and reports the failed save.
Any partial files and the temporary packet remain evidence. Do not overwrite them, reread the source or
retry a save automatically; identify the filesystem error and recover the held
body into an authorized new output location when appropriate. A matching saved
receipt and files are reused rather than fetched again.

## Evidence problems

Missing links and unresolved citation codes do not trigger recovery in ordinary
transfer-only use. Preserve them in the original archive and deliver it without
an independent quality claim. Do not browse sources, walk citation cards or ask
Chat to regenerate formatting. Only an explicit review or quality-test request
starts a bounded source/content check; record its cost separately.

For a material missing answer use at most the task's remaining second message,
after confirming the same Chat and applicable scope. Never reset the message
allowance because collection happened in another turn.

## Cancellation

User cancellation prevents automatic recovery and local replacement work in the
cancelled scope. Attempt a supported remote Stop once when applicable, and disclose
an unconfirmed stop. A normal deferred handoff is not a cancellation; never stop
ongoing web generation merely because the local turn ends.
