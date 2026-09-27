---
name: grill-me
description: Grill code for Martin Fowler's classic code smells — Long Method, Duplicated Code, Feature Envy, Data Clumps, Shotgun Surgery, Divergent Change, Primitive Obsession, Long Parameter List, Large Class, Message Chains, Speculative Generality, Dead Code — and report real instances with file:line, evidence and a concrete refactor, worst first. Use this whenever the user says "grill me", "grill this code", asks for a code smell review, a refactoring review, a quality or technical-debt pass, asks "what's wrong with this code", "where is this code ugly", "what should I refactor", or points at a file or module and asks how to clean it up. Use it too when they share a code-smell list or a Refactoring/Fowler reference and imply they want it applied to their own code.
---

# Grill me

A smell review is only worth reading if every line of it survives the question
"show me". The failure mode is a wall of plausible, generic advice — *this
function is long, consider extracting helpers* — that costs the reader more
time than it saves and, worse, teaches them to ignore the next review. What
makes this useful is the opposite: few findings, each with the file and line,
the evidence, and the change you would actually make.

## The bar for a finding

Report something only if you can answer all four:

1. **Where** — `path/file.ext:line`, read and verified, not inferred from a name.
2. **What** — the concrete evidence. Not "this is complex" but "these 40 lines
   appear again at `other.js:210` with two identifiers changed".
3. **So what** — the cost, in terms of change: what will break, what has to be
   edited in three places, what a newcomer will misread. A smell with no cost
   is a preference, and preferences do not go in the report.
4. **Then what** — the specific refactor, named (Extract Function, Introduce
   Parameter Object, Move Function, Replace Temp with Query…), not "consider
   refactoring".

If a finding fails any of these, drop it. Ten defensible findings beat forty.

## What is not a smell

This is where most reviews go wrong. Before reporting, rule these out:

- **Deliberate parallelism.** Ports kept line-by-line in step with another
  language, generated files, and code pinned by golden/approval tests are
  duplicated *on purpose*. Refactoring one side breaks the property the
  duplication exists to maintain. Read the neighbouring code and the tests
  before calling it Duplicated Code — and if a change here would need the same
  change elsewhere to stay in step, say so in the finding.
- **Flat, readable length.** A long function that is a dispatch table, a
  switch over cases, or a top-to-bottom DOM/view build is not a Long Method.
  Length is a symptom; the smell is *mixed levels of abstraction* or state
  threaded through branches. Say which it is.
- **Framework shape.** SwiftUI `body`, React render, reducers and config
  objects are long because the framework says so.
- **A parameter list that is honest.** Six parameters that are genuinely six
  independent things beat an options bag that hides them. Data Clumps is about
  the *same group* travelling together repeatedly.
- **Code that is merely old.** Working, tested, untouched-for-a-year code with
  no pending change against it is not debt. Rank by the change people actually
  make.

State the near-misses you rejected and why, briefly, at the end. That section
is what tells the reader you looked rather than pattern-matched.

## How to work

1. **Size it up first.** `wc -l`, the directory layout, the test command. Know
   what is generated, vendored or ported before reading anything — those are
   the places a naive review wastes its whole budget.
2. **Go where change happens.** If git is available, `git log --format= --name-only -n 200 | sort | uniq -c | sort -rn | head` shows the files people actually edit. A smell in a file nobody touches costs nothing; the same smell in this week's file costs every time.
3. **Read the hot files properly**, not in fragments. Smells like Divergent
   Change and Shotgun Surgery are invisible in a grep — they are about *which
   reasons* make a file change, which you can only see whole, and across the
   history.
4. **Verify every claim.** Grep the exported name before calling it Dead Code
   (tests, scripts, docs and other languages count as callers). Open both sites
   before calling it duplication.
5. **Rank by cost**, not by severity-sounding words: what is dangerous to
   change first, what is merely untidy last.

For a large codebase, split the reading across parallel subagents by area, give
each one this same bar, and collate — but verify the findings yourself before
they reach the user. An unverified subagent claim is exactly the generic noise
this skill exists to prevent.

## The report

Lead with the two or three findings that matter, in prose, so the reader gets
the point without a table. Then, per finding:

**Smell — `file.ext:line`** *(severity: high/medium/low; fix: safe/needs-care)*
What is there, what it costs, and the named refactor. Two to four sentences.

Close with **Not flagged**: the plausible-looking things you deliberately left,
one line each. And if the codebase is genuinely in good shape, say so plainly
and keep the report short — inventing findings to look thorough is the one
outcome worse than saying nothing.

## Fixing

Only if asked. Then:

- **Safe first, and separately**: pure-local extractions, dead code removal,
  a parameter object behind an unchanged signature. Run the tests after *each*
  one, not at the end, so a failure names its own cause.
- **Behaviour must not move.** If a refactor changes output, ordering, or a
  serialised byte, it is not a refactor — stop and ask.
- **Leave the structural ones for the user's call**: anything that moves a
  module boundary, changes a public API, or touches code pinned by parity or
  golden tests. Propose those; don't perform them.
- Report what you changed, what you skipped, and why — and never claim green
  tests you did not watch run.
