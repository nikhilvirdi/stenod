# Stenod

## The Problem

You're deep in a session with an AI coding assistant. It's been going well — you explained the project, worked through a few architectural decisions together, hit a bug, fixed it, tried an approach that didn't pan out and moved past it. You're in flow, and the AI actually *gets* what you're building.

Then you hit your rate limit. Or the provider has an outage. Or the model just gets stuck on something and you need to try a different one. Either way — the conversation's over, and everything that AI understood about your project disappears with it.

So you open a new chat. And now you're the one doing all the work: "Okay, we're using Postgres, not Mongo — that was a deliberate call. There's a bug in `auth.ts` I was in the middle of fixing. Don't touch the payment logic, it's fragile for reasons I don't have the energy to re-explain right now. Also we tried an approach with Redis caching earlier and abandoned it, so don't suggest that again." You type all of this from memory, under time pressure, hoping you remembered the important parts.

And even if you get it all down — long, dense context dumps are exactly what these models handle worst. Stuff buried in the middle of a big prompt gets weighted less than stuff at the start or end. So the new AI skims past the one line that actually mattered, quietly ignores the constraint you just told it, and you don't find out until it suggests Redis caching again twenty minutes later.

This isn't a rare, edge-case annoyance. It's the default outcome every time a session breaks unexpectedly — and sessions break unexpectedly *often*: usage caps, provider outages, a model getting stuck mid-task, switching tools because one just isn't working for this particular problem. Every one of those moments costs you the same thing: fifteen, twenty, thirty minutes of re-establishing context you already had, badly, from memory, while the actual momentum you were building just evaporates.

Here's the part that makes it sting more: none of that context was ever really *gone*. Your code is still on disk, exactly as you left it. Your terminal history still shows the error you were chasing. Nothing about your actual work was lost — only the AI's understanding of it. The one thing that shouldn't be fragile is the one thing that's completely at the mercy of a conversation window.

## What stenod is ?

Picture a black box flight recorder — the kind planes carry. It doesn't fly the plane, it doesn't talk to air traffic control, it doesn't do anything glamorous. It just quietly, continuously records what's actually happening. And critically: if something goes wrong with the plane, the recorder isn't affected, because it was never depending on the plane staying airborne in the first place. That's the whole idea, borrowed almost exactly.

Stenod is a small program that runs quietly in the background on your own machine while you code. It doesn't watch your AI conversation — it watches *your actual work*. Every time you save a file, it notices. Every time you run a command in your terminal and it succeeds or fails, it notices that too. It's not recording video or keystrokes — it's building something closer to a timeline of cause and effect: you tried this, it broke, you changed that, it worked, this rule was established and hasn't changed since.

It also gives you a way to explicitly mark things that matter — a comment in your code, or a quick command, that says "this is a hard constraint, don't let a new AI session suggest otherwise." Those get remembered with extra weight, specifically so they survive into whatever comes next.

Here's the part that makes it different from just... taking notes: it never talks to the AI. Not during normal operation, not ever, unless you explicitly ask it to. It's not plugged into Claude's API or watching your ChatGPT tab. It's a completely separate process, sitting on your machine, that would keep running exactly the same way whether your AI session is healthy, rate-limited, or down entirely. Nothing about it depends on the thing it's helping you recover from.

Then comes the moment that actually matters: your session gets cut off. You type one command — `stenod handoff`. Stenod looks at everything it's been quietly building, and it does two things well. First, it filters — the dead ends you abandoned, the errors you already fixed, none of that clutters the output; only what's still actually true and relevant survives. Second, it organizes what's left deliberately, not just dumps it — the non-negotiable rules go first, the messy middle detail goes in the middle, and the exact next step goes last, because that's the order that actually gets read and used well, not just the order it happened to occur in.

The result gets copied straight to your clipboard. You paste it into a brand new AI session — could be Claude again, could be ChatGPT, could be whatever's actually available right now — and it picks up close to where you were, because what you handed it wasn't a frantic re-explanation typed from memory under pressure. It was a clean, deliberate summary, built the whole time you were working, by something that was never at risk of losing it.