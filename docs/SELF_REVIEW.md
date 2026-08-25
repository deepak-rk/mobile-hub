# Self-Review Checklist

Run this at every major completion — finishing a module, closing out a significant chunk of work, or before ending a session. It's short by design: a real check, not a ceremony. See root `CLAUDE.md` § Self-review for the trigger rule.

## 1. Drift check

Compare what you actually built against what was stated:

- Does it match root `CLAUDE.md`'s locked decisions and "Do this, not that" rules, and the relevant package `CLAUDE.md`?
- Does it match `docs/architecture-blueprint.md` for anything that touches an area it covers (schema shape, config model, provider interfaces)?
- Did anything creep in that wasn't asked for — an abstraction the task didn't need, a dependency not discussed, a refactor bundled into an unrelated change?
- Did you duplicate a pattern that already exists elsewhere in the repo instead of reusing it?

If something drifted, fix it now or flag it to the user — don't let it quietly become precedent.

## 2. Verification check

- Everything you're about to mark "built" or "tested" in `TODO.md` — is the status actually earned? Typecheck/lint passing is "built." Only an actual run (server boot, endpoint hit, real test execution) earns "tested."
- Any claim in this session's summary that isn't backed by something you actually ran?

## 3. Practice harvest

- Did a pattern emerge this session worth generalizing — a convention, a way of testing something, a structural choice — that would help future sessions if it were a standing rule instead of a one-off?
- If yes: propose adding it to the relevant `CLAUDE.md` (root or package) explicitly, in a sentence the next session can follow without re-deriving the reasoning. Don't bake it in silently — say what you're proposing and why, since it changes how future work gets judged.
- Small, low-stakes conventions (e.g. "new pure-function modules get a `.test.ts` alongside them") can just be added. Anything that changes architecture, adds a dependency, or contradicts an existing rule needs the user's sign-off first, same as any other locked decision.

## 4. Mistake capture

- Did anything break, get built wrong, or get missed and have to be fixed this session?
- If yes, add an entry to `LESSONS.md`: what happened, why it was invisible until it broke, and the resulting rule. Concrete and specific — "we forgot to schedule the function we wrote" beats "be more careful."
- Skip this step only if nothing actually went wrong — don't manufacture an entry to fill the section.

## 5. Checklist sync

- Update `TODO.md` so it reflects reality before you stop — this is the last step, not a separate task to remember later.
