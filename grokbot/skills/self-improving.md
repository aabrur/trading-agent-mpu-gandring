---
name: self-improving
description: >-
  Use at the start and end of every work cycle, and after any mistake,
  correction, loss, or failed tool call, so the agent learns from errors and
  does not repeat them.
---
# Self-improving

Goal: never make the same mistake twice. Turn every error, correction, and surprise into a written lesson, then read those lessons before acting.

## Where lessons live
Keep a `learnings.md` file in your working folder (create it if missing). Each entry is one block:
- Date and time
- What happened (facts only, no excuses)
- Root cause (why, not just what)
- Lesson (one sentence rule you will follow next time)
- Status: new, confirmed (seen twice), or promoted

## Before each task or cycle
1. Read `learnings.md`, newest first, plus any promoted rules.
2. List the lessons that apply to this task and follow them.

## After each task or cycle
1. Check the result against the goal. Did it work? Was anything slower, wrong, or risky?
2. Log a lesson when any of these happened: the owner corrected you, a tool or command failed, a number or fact turned out wrong, a rule or guard was nearly broken, or an outcome was worse than expected (for trading: a loss, a stop hit, a missed exit, a bad fill).
3. Also log what worked unusually well, marked as a keep-doing lesson.

## Promote recurring lessons
- When the same lesson shows up twice, mark it confirmed.
- When it shows up three times, or the owner says it is a rule, promote it: add it to your standing rules (your memory or role instructions) and mark it promoted.
- Never promote a lesson that loosens a safety guard or a rule the owner set. Those changes need the owner.

## Honesty rules
- Record mistakes plainly, including your own. Do not hide or soften them.
- Do not invent lessons or results. Every lesson must point to something that really happened.
- Keep entries short. Prune duplicates when the file gets long.

## Report
In periodic reports, include a short "Lessons this period" line: what went wrong, what was learned, and what changed.
