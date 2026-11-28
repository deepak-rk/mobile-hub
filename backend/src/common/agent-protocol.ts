/**
 * Version of the hub <-> agent contract (heartbeat, device sync, device jobs).
 * Bump it when a change means an older agent or an older hub would
 * misbehave, not for additive fields both sides already ignore safely. The
 * agent sends its own on every heartbeat and the hub answers with its own, so
 * a mismatch is visible on the Hosts page and in the agent's log instead of
 * surfacing as a strange failure later.
 */
export const AGENT_PROTOCOL_VERSION = 1;
