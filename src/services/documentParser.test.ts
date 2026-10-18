import { describe, it, expect } from "vitest";
import { computeContentHash, splitIntoChunks } from "./documentParser";

describe("computeContentHash", () => {
  it("returns a SHA-256 hex string", () => {
    const hash = computeContentHash("Hello, world!");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns the same hash for the same input", () => {
    const hash1 = computeContentHash("test content");
    const hash2 = computeContentHash("test content");
    expect(hash1).toBe(hash2);
  });

  it("returns different hashes for different inputs", () => {
    const hash1 = computeContentHash("content A");
    const hash2 = computeContentHash("content B");
    expect(hash1).not.toBe(hash2);
  });
});

describe("splitIntoChunks", () => {
  it("returns single chunk for short text", () => {
    const chunks = splitIntoChunks("Short text", 100000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Short text");
  });

  it("splits long text into chunks by max size", () => {
    const text = "a".repeat(250000);
    const chunks = splitIntoChunks(text, 100000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100000);
    }
  });

  it("preserves all text across chunks", () => {
    const text = "x".repeat(150000);
    const chunks = splitIntoChunks(text, 100000);
    const joined = chunks.join("");
    expect(joined).toBe(text);
  });
});
