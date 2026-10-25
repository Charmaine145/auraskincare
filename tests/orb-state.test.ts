import { test } from "node:test";
import assert from "node:assert/strict";
import { orbStateFor, type OrbStateInput } from "../src/lib/voice/orbState";

const input = (overrides: Partial<OrbStateInput> = {}): OrbStateInput => ({
  phase: "live",
  agentState: "Listening",
  interrupted: false,
  problem: null,
  ...overrides,
});

test("orb: outside a call it is idle and never implies a live microphone", () => {
  assert.equal(orbStateFor(input({ phase: "idle", agentState: "Idle" })), "idle");
  assert.equal(orbStateFor(input({ phase: "idle", agentState: "Listening" })), "idle");
  assert.equal(orbStateFor(input({ phase: "idle", agentState: "Speaking" })), "idle");
  assert.equal(orbStateFor(input({ phase: "idle", interrupted: true })), "idle");
});

test("orb: connecting and wrapping up show processing", () => {
  assert.equal(orbStateFor(input({ phase: "starting", agentState: "Idle" })), "processing");
  assert.equal(orbStateFor(input({ phase: "ending", agentState: "Idle" })), "processing");
});

test("orb: a live call maps listening, thinking and speaking honestly", () => {
  assert.equal(orbStateFor(input({ agentState: "Listening" })), "listening");
  assert.equal(orbStateFor(input({ agentState: "Thinking" })), "processing");
  assert.equal(orbStateFor(input({ agentState: "Speaking" })), "speaking");
  assert.equal(orbStateFor(input({ agentState: "Idle" })), "idle");
});

test("orb: a barge-in shows interrupted while Aria listens again", () => {
  assert.equal(orbStateFor(input({ agentState: "Listening", interrupted: true })), "interrupted");
});

test("orb: a newer request overrides the interruption cue", () => {
  assert.equal(orbStateFor(input({ agentState: "Thinking", interrupted: true })), "processing");
  assert.equal(orbStateFor(input({ agentState: "Speaking", interrupted: true })), "speaking");
});

test("orb: a real failure wins over every call state", () => {
  const states: OrbStateInput["agentState"][] = ["Idle", "Listening", "Thinking", "Speaking"];
  for (const agentState of states) {
    assert.equal(orbStateFor(input({ agentState, interrupted: true, problem: "connection" })), "error");
  }
  assert.equal(orbStateFor(input({ phase: "starting", problem: "microphone" })), "error");
  assert.equal(orbStateFor(input({ phase: "idle", problem: "speech" })), "error");
});

test("orb: clearing the problem returns the orb to the real state", () => {
  assert.equal(orbStateFor(input({ problem: "speech" })), "error");
  assert.equal(orbStateFor(input({ problem: null })), "listening");
});
