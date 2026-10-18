import { afterEach, describe, expect, it } from "vitest";

import {
  CHUNK_RELOAD_DELAYS_MS,
  clearChunkReloadAttempts,
  isChunkLoadError,
  nextChunkReloadDelay,
} from "@/lib/chunkReload";

describe("isChunkLoadError", () => {
  it("узнаёт недогруженный файл сборки", () => {
    const named = Object.assign(new Error("x"), { name: "ChunkLoadError" });
    expect(isChunkLoadError(named)).toBe(true);
    expect(isChunkLoadError(new Error("Loading chunk 4137 failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Loading CSS chunk app-layout failed"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: /x.js"))).toBe(true);
  });

  it("обычный сбой кода — не устаревшая вкладка", () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError("Loading chunk 1 failed")).toBe(false);
  });
});

describe("nextChunkReloadDelay", () => {
  afterEach(() => window.sessionStorage.clear());

  it("переживает окно сборки: несколько попыток с растущими паузами, потом стоп", () => {
    const now = 1_000_000;
    const delays = CHUNK_RELOAD_DELAYS_MS.map((_, i) => nextChunkReloadDelay(now + i * 1000));
    expect(delays).toEqual([...CHUNK_RELOAD_DELAYS_MS]);
    expect(nextChunkReloadDelay(now + 60_000)).toBeNull();
  });

  it("старая серия забывается, удачное открытие её сбрасывает", () => {
    expect(nextChunkReloadDelay(0)).toBe(0);
    expect(nextChunkReloadDelay(1_000)).toBe(5_000);
    expect(nextChunkReloadDelay(11 * 60_000)).toBe(0);
    clearChunkReloadAttempts();
    expect(nextChunkReloadDelay(11 * 60_000 + 1)).toBe(0);
  });
});
