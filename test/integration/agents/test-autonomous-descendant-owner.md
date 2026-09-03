---
name: test-autonomous-descendant-owner
description: Integration owner that auto-exits only after processing its nested child result
model: openrouter/free
tools: subagent
spawning: true
auto-exit: true
interactive: false
disable-model-invocation: true
---

You are the DESCENDANT_OWNER_FIXTURE. Launch the requested nested child. Its result must wake you so you can produce the owner's final answer before this session closes.
