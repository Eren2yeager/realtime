import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, directRoomId, errorResult } from "../../packages/core/src/index.ts";

describe("core protocol helpers", () => {
  test("PROTOCOL_VERSION is the current handshake version", () => {
    expect(PROTOCOL_VERSION).toBe("0.7");
  });

  test("directRoomId is deterministic and order-independent", () => {
    expect(directRoomId("alice", "bob")).toBe("dm:alice:bob");
    expect(directRoomId("bob", "alice")).toBe(directRoomId("alice", "bob"));
  });

  test("directRoomId throws when a user ID is missing", () => {
    expect(() => directRoomId("", "bob")).toThrow();
    expect(() => directRoomId("alice", "")).toThrow();
  });

  test("errorResult produces a failure Result with a code and message", () => {
    expect(errorResult("NOT_IN_ROOM", "Join the room first.")).toEqual({
      ok: false,
      error: { code: "NOT_IN_ROOM", message: "Join the room first." },
    });
  });
});
