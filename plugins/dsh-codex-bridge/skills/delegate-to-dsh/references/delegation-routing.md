# Delegation routing

Use this reference when the user has not explicitly chosen a single- or multi-Agent DSH run.

## Decision order

1. Preserve an explicit user choice of `single` or `multi`.
2. Identify independently completable workstreams, not merely the number of steps.
3. Compare expected parallel or review benefit with coordination cost.
4. Resolve ambiguity to `single`; DSH can still perform a sequential task well without child overhead.

Choose `single` when the change is local, tightly coupled, sequential, or comfortably fits one context. Typical examples are a focused bug fix, one configuration edit, a small test addition, or one documentation update.

Choose `multi` when at least one condition is met:

- two or more workstreams can proceed without sharing mutable intermediate state;
- distinct specialties are useful, such as implementation plus security or test review;
- independent exploration of separate modules or competing hypotheses materially reduces elapsed time;
- a high-risk change benefits from an independent reviewer;
- the user requests cross-model verification and suitable profiles are available.

Do not choose multi merely because a task is long, has several sequential steps, or sounds important.

## Execution shapes

- One cohesive workspace: submit one Bridge task with `multi` and bounded child roles so the DSH Root Agent coordinates children in the same worktree.
- Independent deliverables: submit separate Bridge tasks, one per workstream or model profile. Keep their acceptance criteria and worktrees independent; Codex reviews and integrates the patches.
- Implementation plus review: finish the implementation task first, then give the reviewer the immutable patch Artifact or an equivalent bounded input. Do not assume a separate worktree can see another task's uncommitted changes.

## Roles and limits

Name roles by outcome, such as `implementation`, `tests`, `security-review`, or `alternative-analysis`. Do not prescribe more children than the selected Profile allows. Keep child objectives self-contained and avoid having two children edit the same files concurrently.

For different child models, use separate named Profiles unless the selected DSH Profile explicitly declares role-to-model routes. Never invent a model route.

## Evidence and fallback

A multi-Agent result is valid only when observed child-call evidence satisfies the requested minimum. If DSH completes the code but does not produce that evidence, report the mismatch or continue the same task with precise feedback. Do not silently relabel it as a single-Agent success.

If no eligible multi-Agent Profile exists, fail clearly or use single only after telling the user; never silently switch models or weaken an explicit multi-Agent request.
