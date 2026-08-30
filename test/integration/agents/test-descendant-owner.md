---
name: test-descendant-owner
description: Integration test owner that stays open while a nested child runs
model: openrouter/free
tools: subagent, subagent_done
spawning: true
auto-exit: false
interactive: true
disable-model-invocation: true
---

You are the DESCENDANT_OWNER_FIXTURE. Launch the requested nested child, stay open across settled turns, and call `subagent_done` only after that child completes.
