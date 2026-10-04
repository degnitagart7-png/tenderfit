import { describe, it, expect, vi, beforeEach } from "vitest";
import { downloadDocument } from "./documentDownloader";

describe("downloadDocument", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("downloads a document and returns buffer + metadata", async () => {
    const fakeBuffer = new Uint8Array([1, 2, 3, 4]);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => fakeBuffer.buffer,
      headers: new Headers({
        "content-type": "application/pdf",
        "content-length": "4",
      }),
    } as unknown as Response);

    const result = await downloadDocument("https://example.com/doc.pdf");

    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.mimeType).toBe("application/pdf");
    expect(result.fileSize).toBe(4);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.com/doc.pdf",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("throws on non-OK response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as Response);

    await expect(downloadDocument("https://example.com/missing.pdf")).rejects.toThrow("404");
  });

  it("throws on network error", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("Network error"));

    await expect(downloadDocument("https://example.com/doc.pdf")).rejects.toThrow("Network error");
  });
});
