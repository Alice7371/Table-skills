# Maintenance validation

Run only when maintaining this skill. Ordinary dispatch does not collect cost
ledgers, author benchmark reports, create synthetic jobs or start evaluation agents.

## Required behavior

- A public independent research question produces one standalone prompt, with
  preserved user requirements and no preliminary local research.
- A new v2 job has task/prompt snapshots and one manifest; no worker or coordinator.
- Loading for send validates its original send window and exact task identity.
- Binding accepts a verified late send, is idempotent, and rejects a different Chat.
- A sent job cannot become a new send through the loader.
- Receiving hours after the send window uses a fresh read budget and the same Chat.
- One-shot collection of an unfinished reply performs one read, no sleep and no save.
- A later collection can obtain the result, without resending or parallel waiting.
- A real file save preserves raw text and the complete deliverable.
- Missing/malformed/oversized briefs and unmarked complete answers stay compact in
  artifact mode; decision/full deliberately retain full output.
- A matching already-saved receipt reuses local files after a program reset.
- Identity changes, partial saves and failed saves cannot silently overwrite files.
- A capped answer permits one capacity expansion, then refuses incomplete delivery.
- The documented send batch rejects duplicate attempts and insufficient time.
- The actual normal functions example loads trusted helpers, performs one receive,
  keeps helper source internal and reuses matching files on its next invocation.
- Explicit polling remains opt-in; its timers/logs are program-owned.

Use saved local replies and temporary project-contained output directories for
these checks. Do not run live web research merely to test a string parser.

## Live evidence and comparison

Local checks do not establish browser availability, real Chat compatibility or
usage savings. Live acceptance needs one authorized useful independent research
task, one observed send, a matching complete returned answer, and quality checks
appropriate to its intended use. User completion input may replace polling.

For requested cost comparisons, collect existing runtime counters after execution.
Include normal cold-start guidance, dispatch, host resumptions, collection, review
and repair. Separate one-time development/evaluation administration; it still
belongs in the overall experiment bill. Do not turn the work itself into a series
of budget checks or benchmark-status updates.

Compare equivalent tasks and deliverables at matched quality. Distinguish workflow
savings from model-price differences. A rounded account percentage or leaf-only
cost is not a complete-work saving estimate. Report unmeasured quantities as such.

Keep automatic routing unchanged until evidence warrants expansion. Preparing a
candidate is not installing it. Follow the user's applicable installation/config
authorization and active-rule regression requirements when promoting it.
