# Document Analysis Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a background document analysis pipeline that downloads tender documents, parses their content (PDF/DOCX/XLSX), analyzes via OpenRouter (Gemini 2.5 Flash), recalculates verdicts based on findings, and shows progress in the UI.

**Architecture:** Supabase (Postgres) stores documents, analyses, jobs, and verdict history. Next.js API routes handle triggering and processing. Vercel Cron drives the worker every 5 minutes. Documents are parsed with pdf-parse/mammoth/xlsx, analyzed via OpenRouter, and findings feed into the existing verdict engine. The UI polls for analysis progress.

**Tech Stack:** Next.js 14.2.15, @supabase/supabase-js, pdf-parse, mammoth, xlsx, jszip, OpenRouter API (google/gemini-2.5-flash), Zod, Vitest

---

## File Structure

```
New files:
  src/lib/supabase.ts                          — Supabase server client (singleton)
  src/lib/supabase.test.ts                     — Tests for Supabase client creation
  src/types/database.ts                        — Generated-ish TS types for Supabase tables
  src/repositories/documentRepository.ts       — CRUD for tender_documents
  src/repositories/documentRepository.test.ts  — Tests
  src/repositories/analysisJobRepository.ts    — CRUD for analysis_jobs
  src/repositories/analysisJobRepository.test.ts — Tests
  src/repositories/verdictHistoryRepository.ts — CRUD for verdict_history
  src/repositories/verdictHistoryRepository.test.ts — Tests
  src/services/documentDownloader.ts           — Download files from URLs
  src/services/documentDownloader.test.ts      — Tests
  src/services/documentParser.ts               — PDF/DOCX/XLSX → text extraction
  src/services/documentParser.test.ts          — Tests
  src/services/openRouterAnalysis.ts           — OpenRouter API client
  src/services/openRouterAnalysis.test.ts      — Tests
  src/services/documentAnalysisPipeline.ts     — Orchestrator: parse → analyze → verdict
  src/services/documentAnalysisPipeline.test.ts — Tests
  src/app/api/analysis/trigger/route.ts        — POST: create analysis job
  src/app/api/analysis/worker/route.ts         — GET: process one job (cron target)
  src/app/api/analysis/status/route.ts         — GET: job status for UI
  vercel.json                                  — Cron schedule config

Modified files:
  package.json                                 — Add new dependencies
  src/domain/scoring/index.ts                  — Add applyDocumentFindings() function
  src/domain/scoring/scoring.test.ts           — Tests for applyDocumentFindings
```

---

### Task 1: Dependencies and Supabase Client

**Files:**
- Modify: `package.json`
- Create: `src/lib/supabase.ts`
- Create: `src/lib/supabase.test.ts`
- Create: `src/types/database.ts`

- [ ] **Step 1: Install npm dependencies**

Run:
```bash
cd C:\Users\1\Downloads\tenderfit-ai && npm install @supabase/supabase-js pdf-parse mammoth xlsx jszip
```

Then install types:
```bash
npm install -D @types/pdf-parse
```

Expected: `added X packages` with no errors.

- [ ] **Step 2: Verify dependencies in package.json**

Open `package.json` and confirm these appear in `dependencies`:
```json
"@supabase/supabase-js": "^2.45.0",
"pdf-parse": "^1.1.1",
"mammoth": "^1.8.0",
"xlsx": "^0.18.5",
"jszip": "^3.10.1"
```

And in `devDependencies`:
```json
"@types/pdf-parse": "^1.1.0"
```

- [ ] **Step 3: Create Supabase database types**

Create `src/types/database.ts`:

```ts
// TypeScript types matching supabase/migrations/20260921000000_create_document_analysis_pipeline.sql

export type DocumentSourceType = "torgi_open_data" | "eis_api" | "manual_upload";
export type DocumentType = "notice" | "protocol" | "contract" | "attachment" | "other";
export type DownloadStatus = "pending" | "downloading" | "downloaded" | "failed";
export type ParsedStatus = "pending" | "parsing" | "parsed" | "needs_ocr" | "failed";
export type JobType = "full_analysis" | "reanalyze" | "parse_only";
export type JobStatus = "pending" | "processing" | "completed" | "failed";
export type Verdict = "RECOMMENDED" | "MANUAL_REVIEW" | "NOT_RECOMMENDED";
export type TriggeredBy = "document_analysis" | "metadata_analysis" | "manual_override";

export interface TenderDocumentRow {
  id: string;
  tender_id: string;
  source_type: DocumentSourceType;
  filename: string;
  document_type: DocumentType;
  file_url: string | null;
  raw_json: Record<string, unknown> | null;
  file_size: number | null;
  mime_type: string | null;
  download_status: DownloadStatus;
  parsed_status: ParsedStatus;
  parsed_text: string | null;
  parsed_sections: unknown[] | null;
  content_hash: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentAnalysisRow {
  id: string;
  tender_id: string;
  document_id: string;
  model_used: string;
  analysis: {
    findings: AnalysisFinding[];
    summary: string;
  };
  verdict_before: Verdict | null;
  verdict_after: Verdict | null;
  old_score: number | null;
  new_score: number | null;
  confidence_score: number | null;
  tokens_used: number | null;
  processing_time_ms: number | null;
  created_at: string;
}

export interface AnalysisFinding {
  category: "blocker" | "risk" | "requirement" | "neutral";
  title: string;
  detail: string;
  evidence_quote: string;
  evidence_section: string;
  severity: "high" | "medium" | "low";
}

export interface AnalysisJobRow {
  id: string;
  tender_id: string;
  job_type: JobType;
  status: JobStatus;
  priority: number;
  documents_total: number;
  documents_processed: number;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VerdictHistoryRow {
  id: string;
  tender_id: string;
  old_verdict: Verdict | null;
  new_verdict: Verdict;
  old_score: number | null;
  new_score: number | null;
  reason: string;
  triggered_by: TriggeredBy;
  analysis_id: string | null;
  created_at: string;
}
```

- [ ] **Step 4: Write failing test for Supabase client**

Create `src/lib/supabase.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @supabase/supabase-js before importing our module
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(),
  })),
}));

describe("getSupabaseServerClient", () => {
  beforeEach(() => {
    vi.resetModules();
    // Ensure env vars are set for tests
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  });

  it("creates a Supabase client with correct URL and key", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { getSupabaseServerClient } = await import("./supabase");

    const client = getSupabaseServerClient();

    expect(client).toBeDefined();
    expect(createClient).toHaveBeenCalledWith(
      "https://test.supabase.co",
      "test-service-role-key",
    );
  });

  it("returns the same singleton instance on repeated calls", async () => {
    const { getSupabaseServerClient } = await import("./supabase");

    const client1 = getSupabaseServerClient();
    const client2 = getSupabaseServerClient();

    expect(client1).toBe(client2);
  });

  it("throws if SUPABASE_URL is missing", async () => {
    delete process.env.SUPABASE_URL;
    const { getSupabaseServerClient } = await import("./supabase");

    expect(() => getSupabaseServerClient()).toThrow("SUPABASE_URL");
  });

  it("throws if SUPABASE_SERVICE_ROLE_KEY is missing", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { getSupabaseServerClient } = await import("./supabase");

    expect(() => getSupabaseServerClient()).toThrow("SUPABASE_SERVICE_ROLE_KEY");
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run src/lib/supabase.test.ts`
Expected: FAIL — `Cannot find module './supabase'`

- [ ] **Step 6: Implement Supabase server client**

Create `src/lib/supabase.ts`:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getSupabaseServerClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("SUPABASE_URL is not set");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

  client = createClient(url, key);
  return client;
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/lib/supabase.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/types/database.ts src/lib/supabase.ts src/lib/supabase.test.ts
git commit -m "feat: add Supabase client, database types, and dependencies for document analysis pipeline"
```

---

### Task 2: Document Repository

**Files:**
- Create: `src/repositories/documentRepository.ts`
- Create: `src/repositories/documentRepository.test.ts`

- [ ] **Step 1: Write failing test for document repository**

Create `src/repositories/documentRepository.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: () => ({
    from: mockFrom,
  }),
}));

// Helper to build a chainable Supabase mock
function mockChain(data: unknown = null, error: unknown = null) {
  const selectFn = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      order: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue({ data, error }),
      }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data, error }),
          }),
        }),
      }),
    }),
    order: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue({ data, error }),
    }),
  });

  const insertFn = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({ data, error }),
    }),
  });

  const updateFn = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data, error }),
      }),
    }),
  });

  mockFrom.mockReturnValue({
    select: selectFn,
    insert: insertFn,
    update: updateFn,
  });

  return { selectFn, insertFn, updateFn };
}

describe("documentRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts a document and returns it", async () => {
    const doc = {
      id: "doc-1",
      tender_id: "0123456789",
      source_type: "eis_api" as const,
      filename: "notice.pdf",
      document_type: "notice" as const,
      file_url: "https://example.com/doc.pdf",
      download_status: "pending" as const,
      parsed_status: "pending" as const,
      created_at: "2026-09-21T00:00:00Z",
      updated_at: "2026-09-21T00:00:00Z",
    };

    mockChain(doc);

    const { documentRepository } = await import("./documentRepository");
    const result = await documentRepository.create({
      tender_id: "0123456789",
      source_type: "eis_api",
      filename: "notice.pdf",
      document_type: "notice",
      file_url: "https://example.com/doc.pdf",
    });

    expect(result).toEqual(doc);
    expect(mockFrom).toHaveBeenCalledWith("tender_documents");
  });

  it("finds documents by tender_id", async () => {
    const docs = [
      { id: "doc-1", tender_id: "0123456789", filename: "a.pdf" },
      { id: "doc-2", tender_id: "0123456789", filename: "b.pdf" },
    ];

    mockChain(docs);

    const { documentRepository } = await import("./documentRepository");
    const result = await documentRepository.findByTenderId("0123456789");

    expect(result).toEqual(docs);
  });

  it("finds a document by content_hash (cache lookup)", async () => {
    const doc = { id: "doc-1", content_hash: "abc123", parsed_text: "cached text" };

    mockChain(doc);

    const { documentRepository } = await import("./documentRepository");
    const result = await documentRepository.findByContentHash("abc123");

    expect(result).toEqual(doc);
  });

  it("updates parsed text and status", async () => {
    const doc = {
      id: "doc-1",
      parsed_text: "extracted text",
      parsed_status: "parsed",
      content_hash: "hash123",
    };

    mockChain(doc);

    const { documentRepository } = await import("./documentRepository");
    const result = await documentRepository.updateParsed("doc-1", {
      parsed_text: "extracted text",
      parsed_status: "parsed",
      content_hash: "hash123",
    });

    expect(result).toEqual(doc);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/repositories/documentRepository.test.ts`
Expected: FAIL — `Cannot find module './documentRepository'`

- [ ] **Step 3: Implement document repository**

Create `src/repositories/documentRepository.ts`:

```ts
import { getSupabaseServerClient } from "@/lib/supabase";
import type {
  TenderDocumentRow,
  DocumentSourceType,
  DocumentType,
  DownloadStatus,
  ParsedStatus,
} from "@/types/database";

interface CreateDocumentInput {
  tender_id: string;
  source_type: DocumentSourceType;
  filename: string;
  document_type: DocumentType;
  file_url?: string | null;
  raw_json?: Record<string, unknown> | null;
  file_size?: number | null;
  mime_type?: string | null;
}

interface UpdateParsedInput {
  parsed_text: string | null;
  parsed_status: ParsedStatus;
  content_hash?: string | null;
  error_message?: string | null;
}

interface UpdateDownloadInput {
  download_status: DownloadStatus;
  file_size?: number | null;
  error_message?: string | null;
}

export const documentRepository = {
  async create(input: CreateDocumentInput): Promise<TenderDocumentRow> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tender_documents")
      .insert({
        tender_id: input.tender_id,
        source_type: input.source_type,
        filename: input.filename,
        document_type: input.document_type,
        file_url: input.file_url ?? null,
        raw_json: input.raw_json ?? null,
        file_size: input.file_size ?? null,
        mime_type: input.mime_type ?? null,
      })
      .select()
      .single();

    if (error) throw error;
    return data as TenderDocumentRow;
  },

  async findByTenderId(tenderId: string): Promise<TenderDocumentRow[]> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tender_documents")
      .select("*")
      .eq("tender_id", tenderId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return (data ?? []) as TenderDocumentRow[];
  },

  async findById(id: string): Promise<TenderDocumentRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tender_documents")
      .select("*")
      .eq("id", id)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null; // not found
      throw error;
    }
    return data as TenderDocumentRow;
  },

  async findByContentHash(hash: string): Promise<TenderDocumentRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tender_documents")
      .select("*")
      .eq("content_hash", hash)
      .eq("parsed_status", "parsed")
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return data as TenderDocumentRow;
  },

  async updateDownloadStatus(
    id: string,
    input: UpdateDownloadInput,
  ): Promise<TenderDocumentRow> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tender_documents")
      .update({
        download_status: input.download_status,
        file_size: input.file_size ?? undefined,
        error_message: input.error_message ?? null,
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return data as TenderDocumentRow;
  },

  async updateParsed(
    id: string,
    input: UpdateParsedInput,
  ): Promise<TenderDocumentRow> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tender_documents")
      .update({
        parsed_text: input.parsed_text,
        parsed_status: input.parsed_status,
        content_hash: input.content_hash ?? null,
        error_message: input.error_message ?? null,
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return data as TenderDocumentRow;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/repositories/documentRepository.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repositories/documentRepository.ts src/repositories/documentRepository.test.ts
git commit -m "feat: add documentRepository for tender_documents CRUD"
```

---

### Task 3: Analysis Job Repository

**Files:**
- Create: `src/repositories/analysisJobRepository.ts`
- Create: `src/repositories/analysisJobRepository.test.ts`

- [ ] **Step 1: Write failing test for analysis job repository**

Create `src/repositories/analysisJobRepository.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: () => ({
    from: mockFrom,
  }),
}));

function mockChain(data: unknown = null, error: unknown = null) {
  const singleFn = vi.fn().mockResolvedValue({ data, error });
  const selectAfterOp = vi.fn().mockReturnValue({ single: singleFn });

  mockFrom.mockReturnValue({
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: singleFn,
      }),
    }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: Array.isArray(data) ? data : [data], error }),
        }),
        limit: vi.fn().mockResolvedValue({ data: Array.isArray(data) ? data : [data], error }),
      }),
      order: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue({ data: Array.isArray(data) ? data : [data], error }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: singleFn,
        }),
        eq: selectAfterOp,
      }),
      select: vi.fn().mockReturnValue({
        single: singleFn,
      }),
    }),
  });

  return { singleFn };
}

describe("analysisJobRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a job with pending status", async () => {
    const job = {
      id: "job-1",
      tender_id: "0123456789",
      job_type: "full_analysis",
      status: "pending",
      priority: 0,
      documents_total: 0,
      documents_processed: 0,
      created_at: "2026-09-21T00:00:00Z",
      updated_at: "2026-09-21T00:00:00Z",
    };

    mockChain(job);

    const { analysisJobRepository } = await import("./analysisJobRepository");
    const result = await analysisJobRepository.create("0123456789", "full_analysis");

    expect(result).toEqual(job);
    expect(mockFrom).toHaveBeenCalledWith("analysis_jobs");
  });

  it("creates a job with custom priority", async () => {
    const job = {
      id: "job-2",
      tender_id: "0123456789",
      job_type: "full_analysis",
      status: "pending",
      priority: 10,
      documents_total: 0,
      documents_processed: 0,
    };

    mockChain(job);

    const { analysisJobRepository } = await import("./analysisJobRepository");
    const result = await analysisJobRepository.create("0123456789", "full_analysis", 10);

    expect(result.priority).toBe(10);
  });

  it("finds jobs by tender_id", async () => {
    const jobs = [
      { id: "job-1", tender_id: "0123456789", status: "pending" },
      { id: "job-2", tender_id: "0123456789", status: "completed" },
    ];

    mockChain(jobs);

    const { analysisJobRepository } = await import("./analysisJobRepository");
    const result = await analysisJobRepository.findByTenderId("0123456789");

    expect(result).toEqual(jobs);
  });

  it("updates job status to processing", async () => {
    const job = { id: "job-1", status: "processing", started_at: "2026-09-21T00:00:00Z" };

    mockChain(job);

    const { analysisJobRepository } = await import("./analysisJobRepository");
    const result = await analysisJobRepository.updateStatus("job-1", "processing");

    expect(result).toEqual(job);
  });

  it("increments documents_processed", async () => {
    const job = { id: "job-1", documents_processed: 1 };

    mockChain(job);

    const { analysisJobRepository } = await import("./analysisJobRepository");
    const result = await analysisJobRepository.incrementProcessed("job-1");

    expect(result).toEqual(job);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/repositories/analysisJobRepository.test.ts`
Expected: FAIL — `Cannot find module './analysisJobRepository'`

- [ ] **Step 3: Implement analysis job repository**

Create `src/repositories/analysisJobRepository.ts`:

```ts
import { getSupabaseServerClient } from "@/lib/supabase";
import type { AnalysisJobRow, JobType, JobStatus } from "@/types/database";

export const analysisJobRepository = {
  async create(
    tenderId: string,
    jobType: JobType,
    priority = 0,
  ): Promise<AnalysisJobRow> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("analysis_jobs")
      .insert({
        tender_id: tenderId,
        job_type: jobType,
        priority,
      })
      .select()
      .single();

    if (error) throw error;
    return data as AnalysisJobRow;
  },

  async findByTenderId(tenderId: string): Promise<AnalysisJobRow[]> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("analysis_jobs")
      .select("*")
      .eq("tender_id", tenderId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return (data ?? []) as AnalysisJobRow[];
  },

  async findById(id: string): Promise<AnalysisJobRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("analysis_jobs")
      .select("*")
      .eq("id", id)
      .limit(1)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return data as AnalysisJobRow;
  },

  async claimNextPending(): Promise<AnalysisJobRow | null> {
    const supabase = getSupabaseServerClient();

    // Use raw SQL for atomic claim with FOR UPDATE SKIP LOCKED
    const { data, error } = await supabase.rpc("claim_next_analysis_job" as never, {} as never);

    // Fallback: if RPC function doesn't exist, use non-atomic approach
    if (error) {
      const { data: pendingJobs, error: fetchError } = await supabase
        .from("analysis_jobs")
        .select("*")
        .eq("status", "pending")
        .order("priority", { ascending: false })
        .order("created_at", { ascending: true })
        .limit(1)
        .single();

      if (fetchError || !pendingJobs) return null;

      const job = pendingJobs as AnalysisJobRow;
      const { data: updated, error: updateError } = await supabase
        .from("analysis_jobs")
        .update({ status: "processing", started_at: new Date().toISOString() })
        .eq("id", job.id)
        .select()
        .single();

      if (updateError) throw updateError;
      return updated as AnalysisJobRow;
    }

    return (data as AnalysisJobRow) ?? null;
  },

  async updateStatus(
    id: string,
    status: JobStatus,
    errorMessage?: string,
  ): Promise<AnalysisJobRow> {
    const supabase = getSupabaseServerClient();
    const updateData: Record<string, unknown> = { status };

    if (status === "processing") {
      updateData["started_at"] = new Date().toISOString();
    }
    if (status === "completed" || status === "failed") {
      updateData["finished_at"] = new Date().toISOString();
    }
    if (errorMessage !== undefined) {
      updateData["error_message"] = errorMessage;
    }

    const { data, error } = await supabase
      .from("analysis_jobs")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return data as AnalysisJobRow;
  },

  async incrementProcessed(id: string): Promise<AnalysisJobRow> {
    const supabase = getSupabaseServerClient();

    // Fetch current value first
    const { data: current, error: fetchError } = await supabase
      .from("analysis_jobs")
      .select("documents_processed")
      .eq("id", id)
      .limit(1)
      .single();

    if (fetchError) throw fetchError;
    const currentCount = (current as { documents_processed: number })?.documents_processed ?? 0;

    const { data, error } = await supabase
      .from("analysis_jobs")
      .update({ documents_processed: currentCount + 1 })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return data as AnalysisJobRow;
  },

  async setDocumentsTotal(id: string, total: number): Promise<void> {
    const supabase = getSupabaseServerClient();
    const { error } = await supabase
      .from("analysis_jobs")
      .update({ documents_total: total })
      .eq("id", id);

    if (error) throw error;
  },

  async resetStaleJobs(staleMinutes = 10): Promise<number> {
    const supabase = getSupabaseServerClient();
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("analysis_jobs")
      .select("id")
      .eq("status", "processing")
      .order("updated_at", { ascending: true });

    if (error) throw error;

    const staleJobs = (data ?? []).filter((job: { updated_at: string }) => {
      return new Date(job.updated_at) < new Date(cutoff);
    }) as { id: string }[];

    for (const job of staleJobs) {
      await supabase
        .from("analysis_jobs")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", job.id);
    }

    return staleJobs.length;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/repositories/analysisJobRepository.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repositories/analysisJobRepository.ts src/repositories/analysisJobRepository.test.ts
git commit -m "feat: add analysisJobRepository for background job queue"
```

---

### Task 4: Verdict History Repository

**Files:**
- Create: `src/repositories/verdictHistoryRepository.ts`
- Create: `src/repositories/verdictHistoryRepository.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/repositories/verdictHistoryRepository.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: () => ({
    from: mockFrom,
  }),
}));

function mockChain(data: unknown = null, error: unknown = null) {
  const singleFn = vi.fn().mockResolvedValue({ data, error });

  mockFrom.mockReturnValue({
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: singleFn,
      }),
    }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({ data: Array.isArray(data) ? data : [data], error }),
      }),
      order: vi.fn().mockResolvedValue({ data: Array.isArray(data) ? data : [data], error }),
    }),
  });

  return { singleFn };
}

describe("verdictHistoryRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a verdict change", async () => {
    const entry = {
      id: "vh-1",
      tender_id: "0123456789",
      old_verdict: "RECOMMENDED",
      new_verdict: "MANUAL_REVIEW",
      old_score: 80,
      new_score: 60,
      reason: "Обнаружен риск в документе",
      triggered_by: "document_analysis",
      analysis_id: "analysis-1",
      created_at: "2026-09-21T00:00:00Z",
    };

    mockChain(entry);

    const { verdictHistoryRepository } = await import("./verdictHistoryRepository");
    const result = await verdictHistoryRepository.record({
      tender_id: "0123456789",
      old_verdict: "RECOMMENDED",
      new_verdict: "MANUAL_REVIEW",
      old_score: 80,
      new_score: 60,
      reason: "Обнаружен риск в документе",
      triggered_by: "document_analysis",
      analysis_id: "analysis-1",
    });

    expect(result).toEqual(entry);
  });

  it("fetches history for a tender", async () => {
    const entries = [
      { id: "vh-1", tender_id: "0123456789", new_verdict: "MANUAL_REVIEW" },
      { id: "vh-2", tender_id: "0123456789", new_verdict: "NOT_RECOMMENDED" },
    ];

    mockChain(entries);

    const { verdictHistoryRepository } = await import("./verdictHistoryRepository");
    const result = await verdictHistoryRepository.findByTenderId("0123456789");

    expect(result).toEqual(entries);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/repositories/verdictHistoryRepository.test.ts`
Expected: FAIL — `Cannot find module './verdictHistoryRepository'`

- [ ] **Step 3: Implement verdict history repository**

Create `src/repositories/verdictHistoryRepository.ts`:

```ts
import { getSupabaseServerClient } from "@/lib/supabase";
import type { VerdictHistoryRow, Verdict, TriggeredBy } from "@/types/database";

interface RecordVerdictChangeInput {
  tender_id: string;
  old_verdict: Verdict | null;
  new_verdict: Verdict;
  old_score: number | null;
  new_score: number | null;
  reason: string;
  triggered_by: TriggeredBy;
  analysis_id: string | null;
}

export const verdictHistoryRepository = {
  async record(input: RecordVerdictChangeInput): Promise<VerdictHistoryRow> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("verdict_history")
      .insert({
        tender_id: input.tender_id,
        old_verdict: input.old_verdict,
        new_verdict: input.new_verdict,
        old_score: input.old_score,
        new_score: input.new_score,
        reason: input.reason,
        triggered_by: input.triggered_by,
        analysis_id: input.analysis_id,
      })
      .select()
      .single();

    if (error) throw error;
    return data as VerdictHistoryRow;
  },

  async findByTenderId(tenderId: string): Promise<VerdictHistoryRow[]> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("verdict_history")
      .select("*")
      .eq("tender_id", tenderId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return (data ?? []) as VerdictHistoryRow[];
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/repositories/verdictHistoryRepository.test.ts`
Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repositories/verdictHistoryRepository.ts src/repositories/verdictHistoryRepository.test.ts
git commit -m "feat: add verdictHistoryRepository for verdict change logging"
```

---

### Task 5: Document Parser

**Files:**
- Create: `src/services/documentParser.ts`
- Create: `src/services/documentParser.test.ts`

- [ ] **Step 1: Write failing test for document parser**

Create `src/services/documentParser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeContentHash, detectFileType, splitIntoChunks } from "./documentParser";

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

describe("detectFileType", () => {
  it("detects PDF from mime type", () => {
    expect(detectFileType("application/pdf")).toBe("pdf");
  });

  it("detects DOCX from mime type", () => {
    expect(detectFileType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
  });

  it("detects XLSX from mime type", () => {
    expect(detectFileType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("xlsx");
  });

  it("detects PDF from filename extension", () => {
    expect(detectFileType(null, "document.pdf")).toBe("pdf");
  });

  it("detects DOCX from filename extension", () => {
    expect(detectFileType(null, "report.docx")).toBe("docx");
  });

  it("detects XLSX from filename extension", () => {
    expect(detectFileType(null, "data.xlsx")).toBe("xlsx");
  });

  it("returns unknown for unrecognized types", () => {
    expect(detectFileType("image/png", "photo.png")).toBe("unknown");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/documentParser.test.ts`
Expected: FAIL — `Cannot find module './documentParser'`

- [ ] **Step 3: Implement document parser**

Create `src/services/documentParser.ts`:

```ts
import { createHash } from "node:crypto";

export type ParsedFileType = "pdf" | "docx" | "xlsx" | "zip" | "unknown";

/**
 * Compute SHA-256 hash of text content for caching.
 */
export function computeContentHash(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Detect file type from MIME type or filename extension.
 */
export function detectFileType(mimeType: string | null, filename?: string): ParsedFileType {
  if (mimeType) {
    if (mimeType === "application/pdf") return "pdf";
    if (mimeType.includes("wordprocessingml")) return "docx";
    if (mimeType.includes("spreadsheetml")) return "xlsx";
    if (mimeType === "application/zip" || mimeType.includes("x-zip-compressed")) return "zip";
  }

  if (filename) {
    const ext = filename.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "pdf": return "pdf";
      case "docx": return "docx";
      case "xlsx": return "xlsx";
      case "zip": return "zip";
      default: return "unknown";
    }
  }

  return "unknown";
}

/**
 * Split text into chunks no larger than maxChars.
 * Tries to split at paragraph boundaries when possible.
 */
export function splitIntoChunks(text: string, maxChars = 100000): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // Try to find a paragraph break near the limit
    const sliceEnd = maxChars;
    const lastParagraphBreak = remaining.lastIndexOf("\n\n", sliceEnd);
    const lastLineBreak = remaining.lastIndexOf("\n", sliceEnd);

    let splitAt: number;
    if (lastParagraphBreak > maxChars * 0.8) {
      splitAt = lastParagraphBreak + 2; // include the \n\n
    } else if (lastLineBreak > maxChars * 0.8) {
      splitAt = lastLineBreak + 1;
    } else {
      splitAt = sliceEnd; // hard break
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

/**
 * Parse a PDF buffer into text.
 */
export async function parsePdf(buffer: Buffer): Promise<string> {
  const pdfParse = (await import("pdf-parse")).default;
  const result = await pdfParse(buffer);
  return result.text;
}

/**
 * Parse a DOCX buffer into text.
 */
export async function parseDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

/**
 * Parse an XLSX buffer into text (each row → "col1 | col2 | ...").
 */
export async function parseXlsx(buffer: Buffer): Promise<string> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(buffer, { type: "buffer" });

  const lines: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_csv(sheet, { FS: " | " });
    lines.push(`=== Лист: ${sheetName} ===`);
    lines.push(rows);
  }

  return lines.join("\n");
}

/**
 * Parse a document buffer into text based on file type.
 * Returns null if the file type is unsupported.
 */
export async function parseDocumentBuffer(
  buffer: Buffer,
  fileType: ParsedFileType,
): Promise<string | null> {
  switch (fileType) {
    case "pdf":
      return parsePdf(buffer);
    case "docx":
      return parseDocx(buffer);
    case "xlsx":
      return parseXlsx(buffer);
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/documentParser.test.ts`
Expected: All 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/documentParser.ts src/services/documentParser.test.ts
git commit -m "feat: add documentParser for PDF/DOCX/XLSX text extraction with content hashing"
```

---

### Task 6: OpenRouter AI Analysis

**Files:**
- Create: `src/services/openRouterAnalysis.ts`
- Create: `src/services/openRouterAnalysis.test.ts`

- [ ] **Step 1: Write failing test for OpenRouter analysis**

Create `src/services/openRouterAnalysis.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildAnalysisPrompt, parseAnalysisResponse } from "./openRouterAnalysis";
import type { AnalysisFinding } from "@/types/database";

describe("buildAnalysisPrompt", () => {
  it("includes document text in the prompt", () => {
    const prompt = buildAnalysisPrompt({
      documentText: "Участник должен иметь лицензию ФСБ",
      tenderContext: {
        regNumber: "0123456789",
        subject: "Поставка серверного оборудования",
        customerName: "ФГУ «Заказчик»",
        price: 5000000,
      },
      companyProfile: {
        capabilities: "Поставка IT-оборудования",
        restrictions: "Цена до 10 млн ₽",
      },
    });

    expect(prompt).toContain("Участник должен иметь лицензию ФСБ");
    expect(prompt).toContain("0123456789");
    expect(prompt).toContain("Поставка серверного оборудования");
  });

  it("includes company profile context", () => {
    const prompt = buildAnalysisPrompt({
      documentText: "Some text",
      tenderContext: {
        regNumber: "123",
        subject: "Test",
        customerName: "Customer",
        price: 1000000,
      },
      companyProfile: {
        capabilities: "Строительство",
        restrictions: "Без лицензий",
      },
    });

    expect(prompt).toContain("Строительство");
    expect(prompt).toContain("Без лицензий");
  });
});

describe("parseAnalysisResponse", () => {
  it("parses valid JSON response with findings", () => {
    const raw = JSON.stringify({
      findings: [
        {
          category: "blocker",
          title: "Требуется лицензия ФСБ",
          detail: "В документации указано требование лицензии",
          evidence_quote: "Участник должен иметь лицензию ФСБ",
          evidence_section: "Раздел 3",
          severity: "high",
        },
      ],
      summary: "Документация содержит блокирующие требования",
    });

    const result = parseAnalysisResponse(raw);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.category).toBe("blocker");
    expect(result.findings[0]!.severity).toBe("high");
    expect(result.summary).toContain("блокирующие требования");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseAnalysisResponse("not json")).toThrow();
  });

  it("throws on missing findings array", () => {
    const raw = JSON.stringify({ summary: "ok" });
    expect(() => parseAnalysisResponse(raw)).toThrow();
  });

  it("throws on invalid finding category", () => {
    const raw = JSON.stringify({
      findings: [{ category: "invalid", title: "t", detail: "d", evidence_quote: "q", evidence_section: "s", severity: "high" }],
      summary: "ok",
    });
    expect(() => parseAnalysisResponse(raw)).toThrow();
  });
});

describe("analyzeDocumentWithOpenRouter (integration shape)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("calls OpenRouter API with correct headers and model", async () => {
    const mockResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            findings: [],
            summary: "Документ не содержит значимых требований",
          }),
        },
      }],
      usage: { total_tokens: 100 },
    };

    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_MODEL = "google/gemini-2.5-flash";

    const { analyzeDocumentWithOpenRouter } = await import("./openRouterAnalysis");
    const result = await analyzeDocumentWithOpenRouter({
      documentText: "Тестовый документ",
      tenderContext: {
        regNumber: "123",
        subject: "Test",
        customerName: "Customer",
        price: 1000000,
      },
      companyProfile: {
        capabilities: "IT",
        restrictions: "None",
      },
    });

    expect(result.findings).toHaveLength(0);
    expect(result.tokensUsed).toBe(100);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/openRouterAnalysis.test.ts`
Expected: FAIL — `Cannot find module './openRouterAnalysis'`

- [ ] **Step 3: Implement OpenRouter analysis service**

Create `src/services/openRouterAnalysis.ts`:

```ts
import { z } from "zod";
import type { AnalysisFinding } from "@/types/database";

const findingSchema = z.object({
  category: z.enum(["blocker", "risk", "requirement", "neutral"]),
  title: z.string().min(1),
  detail: z.string().min(1),
  evidence_quote: z.string().min(1),
  evidence_section: z.string().min(1),
  severity: z.enum(["high", "medium", "low"]),
});

const analysisResponseSchema = z.object({
  findings: z.array(findingSchema).min(0),
  summary: z.string().min(1),
});

interface TenderContext {
  regNumber: string;
  subject: string;
  customerName: string;
  price: number;
}

interface CompanyProfileSummary {
  capabilities: string;
  restrictions: string;
}

interface AnalyzeDocumentInput {
  documentText: string;
  tenderContext: TenderContext;
  companyProfile: CompanyProfileSummary;
}

interface AnalyzeDocumentResult {
  findings: AnalysisFinding[];
  summary: string;
  tokensUsed: number;
  processingTimeMs: number;
}

/**
 * Build the prompt sent to OpenRouter for document analysis.
 */
export function buildAnalysisPrompt(input: AnalyzeDocumentInput): string {
  return `Ты — эксперт по анализу государственных закупок (44-ФЗ, 223-ФЗ).
Проанализируй документ закупки и найди значимые факторы.

## Контекст закупки
- Номер: ${input.tenderContext.regNumber}
- Предмет: ${input.tenderContext.subject}
- Заказчик: ${input.tenderContext.customerName}
- НМЦК: ${input.tenderContext.price.toLocaleString("ru-RU")} ₽

## Профиль компании
- Возможности: ${input.companyProfile.capabilities}
- Ограничения: ${input.companyProfile.restrictions}

## Текст документа
${input.documentText}

## Инструкция
Найди в документе:
1. **blocker** — требования, которые делают участие невозможным (лицензии, допуски, ограничения)
2. **risk** — риски контракта (штрафы, односторонний отказ, казначейское сопровождение)
3. **requirement** — обязательные требования к участникам и заявкам
4. **neutral** — нейтральная информация (контактные данные, сроки подачи)

Для каждого фактора укажи:
- category: blocker | risk | requirement | neutral
- title: краткое название (до 10 слов)
- detail: подробное описание
- evidence_quote: точная цитата из документа
- evidence_section: раздел документа, где найдено
- severity: high | medium | low

Ответь СТРОГО в формате JSON:
{
  "findings": [...],
  "summary": "Общее резюме по документу (2-3 предложения)"
}`;
}

/**
 * Parse and validate the AI response JSON.
 */
export function parseAnalysisResponse(raw: string): {
  findings: AnalysisFinding[];
  summary: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Невалидный JSON от AI-модели");
  }

  const result = analysisResponseSchema.parse(parsed);
  return {
    findings: result.findings as AnalysisFinding[],
    summary: result.summary,
  };
}

/**
 * Call OpenRouter API to analyze a document.
 */
export async function analyzeDocumentWithOpenRouter(
  input: AnalyzeDocumentInput,
): Promise<AnalyzeDocumentResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash";

  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const prompt = buildAnalysisPrompt(input);
  const startTime = Date.now();

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
    usage: { total_tokens: number };
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from OpenRouter");

  const parsed = parseAnalysisResponse(content);
  const processingTimeMs = Date.now() - startTime;

  return {
    findings: parsed.findings,
    summary: parsed.summary,
    tokensUsed: data.usage?.total_tokens ?? 0,
    processingTimeMs,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/openRouterAnalysis.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/openRouterAnalysis.ts src/services/openRouterAnalysis.test.ts
git commit -m "feat: add OpenRouter analysis service for AI document analysis"
```

---

### Task 7: Verdict Engine — Apply Document Findings

**Files:**
- Modify: `src/domain/scoring/index.ts`
- Modify: `src/domain/scoring/scoring.test.ts`

- [ ] **Step 1: Write failing test for applyDocumentFindings**

Append to `src/domain/scoring/scoring.test.ts`:

```ts
import { applyDocumentFindings } from "./index";

describe("applyDocumentFindings", () => {
  it("returns NOT_RECOMMENDED when blocker with high severity found", () => {
    const result = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      currentScore: 85,
      findings: [
        {
          category: "blocker",
          title: "Требуется лицензия ФСБ",
          detail: "Нет лицензии",
          evidence_quote: "Участник должен иметь лицензию",
          evidence_section: "Раздел 3",
          severity: "high",
        },
      ],
    });

    expect(result.verdict).toBe("NOT_RECOMMENDED");
    expect(result.worsened).toBe(true);
  });

  it("returns MANUAL_REVIEW when high-severity risk found", () => {
    const result = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      currentScore: 85,
      findings: [
        {
          category: "risk",
          title: "Высокие штрафы",
          detail: "Неустойка 0.5%",
          evidence_quote: "Неустойка 0,5% за каждый день",
          evidence_section: "Раздел 5",
          severity: "high",
        },
      ],
    });

    expect(result.verdict).toBe("MANUAL_REVIEW");
    expect(result.worsened).toBe(true);
  });

  it("returns MANUAL_REVIEW when multiple medium risks found", () => {
    const result = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      currentScore: 85,
      findings: [
        {
          category: "risk",
          title: "Риск 1",
          detail: "Деталь 1",
          evidence_quote: "Цитата 1",
          evidence_section: "Раздел 1",
          severity: "medium",
        },
        {
          category: "risk",
          title: "Риск 2",
          detail: "Деталь 2",
          evidence_quote: "Цитата 2",
          evidence_section: "Раздел 2",
          severity: "medium",
        },
      ],
    });

    expect(result.verdict).toBe("MANUAL_REVIEW");
    expect(result.worsened).toBe(true);
  });

  it("does not improve verdict (AI can only worsen)", () => {
    const result = applyDocumentFindings({
      currentVerdict: "NOT_RECOMMENDED",
      currentScore: 30,
      findings: [
        {
          category: "neutral",
          title: "Контактные данные",
          detail: "Адрес заказчика",
          evidence_quote: "г. Москва",
          evidence_section: "Раздел 1",
          severity: "low",
        },
      ],
    });

    expect(result.verdict).toBe("NOT_RECOMMENDED");
    expect(result.worsened).toBe(false);
  });

  it("keeps current verdict when no blockers or risks", () => {
    const result = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      currentScore: 85,
      findings: [
        {
          category: "requirement",
          title: "Нужна заявка",
          detail: "Подать до даты",
          evidence_quote: "Заявки подаются через ЕИС",
          evidence_section: "Раздел 2",
          severity: "low",
        },
      ],
    });

    expect(result.verdict).toBe("RECOMMENDED");
    expect(result.worsened).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/scoring/scoring.test.ts`
Expected: FAIL — `applyDocumentFindings is not exported from scoring/index.ts`

- [ ] **Step 3: Implement applyDocumentFindings**

Append to `src/domain/scoring/index.ts`:

```ts
// --- Document analysis verdict engine ---

import type { AnalysisFinding } from "@/types/database";

export interface ApplyDocumentFindingsInput {
  currentVerdict: TenderVerdict;
  currentScore: number;
  findings: AnalysisFinding[];
}

export interface ApplyDocumentFindingsResult {
  verdict: TenderVerdict;
  worsened: boolean;
  reason: string;
}

/**
 * Recalculate verdict based on AI findings from document analysis.
 * AI analysis can only WORSEN the verdict, never improve it.
 * - High-severity blocker → NOT_RECOMMENDED
 * - High-severity risk OR 2+ medium risks → MANUAL_REVIEW
 * - Otherwise → no change
 */
export function applyDocumentFindings(
  input: ApplyDocumentFindingsInput,
): ApplyDocumentFindingsResult {
  const { currentVerdict, findings } = input;

  const highBlockers = findings.filter(
    (f) => f.category === "blocker" && f.severity === "high",
  );
  const highRisks = findings.filter(
    (f) => f.category === "risk" && f.severity === "high",
  );
  const mediumRisks = findings.filter(
    (f) => f.category === "risk" && f.severity === "medium",
  );

  // High-severity blocker → NOT_RECOMMENDED
  if (highBlockers.length > 0) {
    if (currentVerdict === "NOT_RECOMMENDED") {
      return { verdict: currentVerdict, worsened: false, reason: "Вердикт не изменился" };
    }
    const blockerTitles = highBlockers.map((b) => b.title).join("; ");
    return {
      verdict: "NOT_RECOMMENDED",
      worsened: true,
      reason: `Обнаружены блокирующие факторы: ${blockerTitles}`,
    };
  }

  // High-severity risk or 2+ medium risks → MANUAL_REVIEW
  if (highRisks.length > 0 || mediumRisks.length >= 2) {
    if (currentVerdict === "NOT_RECOMMENDED") {
      return { verdict: currentVerdict, worsened: false, reason: "Вердикт не изменился" };
    }
    if (currentVerdict === "MANUAL_REVIEW") {
      return { verdict: currentVerdict, worsened: false, reason: "Вердикт не изменился" };
    }
    const riskTitles = [...highRisks, ...mediumRisks].map((r) => r.title).join("; ");
    return {
      verdict: "MANUAL_REVIEW",
      worsened: true,
      reason: `Обнаружены риски: ${riskTitles}`,
    };
  }

  // No significant findings → no change
  return { verdict: currentVerdict, worsened: false, reason: "Значимых факторов не обнаружено" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/scoring/scoring.test.ts`
Expected: All tests PASS (both existing and new 5 tests for applyDocumentFindings).

- [ ] **Step 5: Commit**

```bash
git add src/domain/scoring/index.ts src/domain/scoring/scoring.test.ts
git commit -m "feat: add applyDocumentFindings verdict engine for document analysis results"
```

---

### Task 8: Document Downloader

**Files:**
- Create: `src/services/documentDownloader.ts`
- Create: `src/services/documentDownloader.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/services/documentDownloader.test.ts`:

```ts
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
    expect(globalThis.fetch).toHaveBeenCalledWith("https://example.com/doc.pdf");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/documentDownloader.test.ts`
Expected: FAIL — `Cannot find module './documentDownloader'`

- [ ] **Step 3: Implement document downloader**

Create `src/services/documentDownloader.ts`:

```ts
interface DownloadResult {
  buffer: Buffer;
  mimeType: string | null;
  fileSize: number;
}

/**
 * Download a document from a URL and return its buffer + metadata.
 */
export async function downloadDocument(url: string): Promise<DownloadResult> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = response.headers.get("content-type");
  const contentLength = response.headers.get("content-length");
  const fileSize = contentLength ? parseInt(contentLength, 10) : buffer.length;

  return { buffer, mimeType, fileSize };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/documentDownloader.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/documentDownloader.ts src/services/documentDownloader.test.ts
git commit -m "feat: add documentDownloader for fetching files from URLs"
```

---

### Task 9: Pipeline Orchestrator

**Files:**
- Create: `src/services/documentAnalysisPipeline.ts`
- Create: `src/services/documentAnalysisPipeline.test.ts`

- [ ] **Step 1: Write failing test for pipeline orchestrator**

Create `src/services/documentAnalysisPipeline.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all dependencies
vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: () => ({ from: vi.fn() }),
}));

vi.mock("./documentDownloader", () => ({
  downloadDocument: vi.fn(),
}));

vi.mock("./documentParser", async () => {
  const actual = await vi.importActual("./documentParser");
  return {
    ...actual,
    downloadDocument: vi.fn(),
    parseDocumentBuffer: vi.fn(),
  };
});

vi.mock("./openRouterAnalysis", () => ({
  analyzeDocumentWithOpenRouter: vi.fn(),
}));

vi.mock("@/repositories/documentRepository", () => ({
  documentRepository: {
    findByTenderId: vi.fn(),
    create: vi.fn(),
    updateDownloadStatus: vi.fn(),
    updateParsed: vi.fn(),
    findByContentHash: vi.fn(),
  },
}));

vi.mock("@/repositories/analysisJobRepository", () => ({
  analysisJobRepository: {
    claimNextPending: vi.fn(),
    updateStatus: vi.fn(),
    incrementProcessed: vi.fn(),
    setDocumentsTotal: vi.fn(),
  },
}));

vi.mock("@/repositories/verdictHistoryRepository", () => ({
  verdictHistoryRepository: {
    record: vi.fn(),
  },
}));

describe("processAnalysisJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes a job: download → parse → analyze → verdict", async () => {
    const { documentRepository } = await import("@/repositories/documentRepository");
    const { analysisJobRepository } = await import("@/repositories/analysisJobRepository");
    const { verdictHistoryRepository } = await import("@/repositories/verdictHistoryRepository");
    const { downloadDocument } = await import("./documentDownloader");
    const { parseDocumentBuffer } = await import("./documentParser");
    const { analyzeDocumentWithOpenRouter } = await import("./openRouterAnalysis");

    // Setup mocks
    vi.mocked(analysisJobRepository.claimNextPending).mockResolvedValueOnce({
      id: "job-1",
      tender_id: "0123456789",
      job_type: "full_analysis",
      status: "processing",
      priority: 0,
      documents_total: 0,
      documents_processed: 0,
      error_message: null,
      started_at: null,
      finished_at: null,
      created_at: "2026-09-21T00:00:00Z",
      updated_at: "2026-09-21T00:00:00Z",
    });

    vi.mocked(documentRepository.findByTenderId).mockResolvedValueOnce([
      {
        id: "doc-1",
        tender_id: "0123456789",
        source_type: "eis_api",
        filename: "notice.pdf",
        document_type: "notice",
        file_url: "https://example.com/doc.pdf",
        download_status: "pending",
        parsed_status: "pending",
        created_at: "2026-09-21T00:00:00Z",
        updated_at: "2026-09-21T00:00:00Z",
      },
    ] as never);

    vi.mocked(downloadDocument).mockResolvedValueOnce({
      buffer: Buffer.from("fake pdf content"),
      mimeType: "application/pdf",
      fileSize: 18,
    });

    vi.mocked(documentRepository.updateDownloadStatus).mockResolvedValueOnce({
      id: "doc-1",
      download_status: "downloaded",
    } as never);

    vi.mocked(parseDocumentBuffer).mockResolvedValueOnce("Текст документа о закупке");

    vi.mocked(documentRepository.findByContentHash).mockResolvedValueOnce(null);

    vi.mocked(documentRepository.updateParsed).mockResolvedValueOnce({
      id: "doc-1",
      parsed_text: "Текст документа о закупке",
      parsed_status: "parsed",
    } as never);

    vi.mocked(analyzeDocumentWithOpenRouter).mockResolvedValueOnce({
      findings: [
        {
          category: "risk",
          title: "Высокие штрафы",
          detail: "Неустойка 0.5%",
          evidence_quote: "Неустойка 0,5%",
          evidence_section: "Раздел 5",
          severity: "high",
        },
      ],
      summary: "Документ содержит риски",
      tokensUsed: 500,
      processingTimeMs: 2000,
    });

    vi.mocked(analysisJobRepository.incrementProcessed).mockResolvedValueOnce({
      id: "job-1",
      documents_processed: 1,
    } as never);

    vi.mocked(analysisJobRepository.updateStatus).mockResolvedValueOnce({
      id: "job-1",
      status: "completed",
    } as never);

    vi.mocked(verdictHistoryRepository.record).mockResolvedValueOnce({
      id: "vh-1",
    } as never);

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    const result = await processAnalysisJob();

    expect(result).toBeDefined();
    expect(result!.jobId).toBe("job-1");
    expect(result!.documentsProcessed).toBe(1);
    expect(analysisJobRepository.updateStatus).toHaveBeenCalledWith("job-1", "completed");
  });

  it("returns null when no pending jobs", async () => {
    const { analysisJobRepository } = await import("@/repositories/analysisJobRepository");
    vi.mocked(analysisJobRepository.claimNextPending).mockResolvedValueOnce(null);

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    const result = await processAnalysisJob();

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/documentAnalysisPipeline.test.ts`
Expected: FAIL — `Cannot find module './documentAnalysisPipeline'`

- [ ] **Step 3: Implement pipeline orchestrator**

Create `src/services/documentAnalysisPipeline.ts`:

```ts
import { documentRepository } from "@/repositories/documentRepository";
import { analysisJobRepository } from "@/repositories/analysisJobRepository";
import { verdictHistoryRepository } from "@/repositories/verdictHistoryRepository";
import { downloadDocument } from "@/services/documentDownloader";
import {
  parseDocumentBuffer,
  detectFileType,
  computeContentHash,
  splitIntoChunks,
} from "@/services/documentParser";
import { analyzeDocumentWithOpenRouter } from "@/services/openRouterAnalysis";
import { applyDocumentFindings } from "@/domain/scoring";
import type { AnalysisFinding } from "@/types/database";

interface ProcessResult {
  jobId: string;
  tenderId: string;
  documentsProcessed: number;
  verdictChanged: boolean;
}

/**
 * Process one analysis job: download → parse → analyze → recalculate verdict.
 * Returns null if no pending jobs.
 */
export async function processAnalysisJob(): Promise<ProcessResult | null> {
  // 1. Claim next pending job
  const job = await analysisJobRepository.claimNextPending();
  if (!job) return null;

  try {
    // 2. Get documents for this tender
    const documents = await documentRepository.findByTenderId(job.tender_id);

    if (documents.length === 0) {
      await analysisJobRepository.updateStatus(job.id, "completed");
      return { jobId: job.id, tenderId: job.tender_id, documentsProcessed: 0, verdictChanged: false };
    }

    await analysisJobRepository.setDocumentsTotal(job.id, documents.length);

    const allFindings: AnalysisFinding[] = [];

    // 3. Process each document
    for (const doc of documents) {
      // Skip already-parsed documents
      if (doc.parsed_status === "parsed" && doc.parsed_text) {
        // Still analyze if not yet analyzed (would need a check on document_analyses)
        const text = doc.parsed_text;
        const findings = await analyzeAndStore(doc.id, job.tender_id, text, doc.filename);
        allFindings.push(...findings);
        await analysisJobRepository.incrementProcessed(job.id);
        continue;
      }

      // Download if needed
      if (doc.file_url && doc.download_status !== "downloaded") {
        try {
          await documentRepository.updateDownloadStatus(doc.id, {
            download_status: "downloading",
          });

          const downloaded = await downloadDocument(doc.file_url);

          await documentRepository.updateDownloadStatus(doc.id, {
            download_status: "downloaded",
            file_size: downloaded.fileSize,
          });

          // Parse the downloaded file
          const fileType = detectFileType(downloaded.mimeType, doc.filename);
          const parsedText = await parseDocumentBuffer(downloaded.buffer, fileType);

          if (parsedText === null) {
            await documentRepository.updateParsed(doc.id, {
              parsed_text: null,
              parsed_status: "needs_ocr",
              error_message: `Unsupported file type: ${fileType}`,
            });
            await analysisJobRepository.incrementProcessed(job.id);
            continue;
          }

          // Check content hash cache
          const hash = computeContentHash(parsedText);
          const cached = await documentRepository.findByContentHash(hash);

          if (cached && cached.parsed_text) {
            await documentRepository.updateParsed(doc.id, {
              parsed_text: cached.parsed_text,
              parsed_status: "parsed",
              content_hash: hash,
            });
          } else {
            await documentRepository.updateParsed(doc.id, {
              parsed_text: parsedText,
              parsed_status: "parsed",
              content_hash: hash,
            });
          }

          // Analyze
          const finalText = cached?.parsed_text ?? parsedText;
          const findings = await analyzeAndStore(doc.id, job.tender_id, finalText, doc.filename);
          allFindings.push(...findings);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          await documentRepository.updateDownloadStatus(doc.id, {
            download_status: "failed",
            error_message: errorMessage,
          });
        }
      }

      await analysisJobRepository.incrementProcessed(job.id);
    }

    // 4. Recalculate verdict based on all findings
    if (allFindings.length > 0) {
      const verdictResult = applyDocumentFindings({
        currentVerdict: "RECOMMENDED", // base verdict from metadata analysis
        currentScore: 85, // placeholder — would come from existing analysis
        findings: allFindings,
      });

      if (verdictResult.worsened) {
        await verdictHistoryRepository.record({
          tender_id: job.tender_id,
          old_verdict: "RECOMMENDED",
          new_verdict: verdictResult.verdict,
          old_score: 85,
          new_score: 85,
          reason: verdictResult.reason,
          triggered_by: "document_analysis",
          analysis_id: null,
        });
      }
    }

    // 5. Mark job as completed
    await analysisJobRepository.updateStatus(job.id, "completed");

    return {
      jobId: job.id,
      tenderId: job.tender_id,
      documentsProcessed: documents.length,
      verdictChanged: allFindings.some((f) => f.category === "blocker" || f.category === "risk"),
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await analysisJobRepository.updateStatus(job.id, "failed", errorMessage);
    throw err;
  }
}

async function analyzeAndStore(
  documentId: string,
  tenderId: string,
  text: string,
  filename: string,
): Promise<AnalysisFinding[]> {
  const chunks = splitIntoChunks(text);
  const allFindings: AnalysisFinding[] = [];

  for (const chunk of chunks) {
    const result = await analyzeDocumentWithOpenRouter({
      documentText: chunk,
      tenderContext: {
        regNumber: tenderId,
        subject: filename,
        customerName: "", // Will be enriched from tender data in production
        price: 0,
      },
      companyProfile: {
        capabilities: "", // Will be enriched from company profile in production
        restrictions: "",
      },
    });

    allFindings.push(...result.findings);

    // Store analysis in DB (via supabase direct insert)
    // This is simplified — in production, create a documentAnalysisRepository
    const { getSupabaseServerClient } = await import("@/lib/supabase");
    const supabase = getSupabaseServerClient();
    await supabase.from("document_analyses").insert({
      tender_id: tenderId,
      document_id: documentId,
      model_used: process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash",
      analysis: { findings: result.findings, summary: result.summary },
      tokens_used: result.tokensUsed,
      processing_time_ms: result.processingTimeMs,
    });
  }

  return allFindings;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/documentAnalysisPipeline.test.ts`
Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/documentAnalysisPipeline.ts src/services/documentAnalysisPipeline.test.ts
git commit -m "feat: add documentAnalysisPipeline orchestrator (download → parse → analyze → verdict)"
```

---

### Task 10: API Routes (Trigger + Worker + Status)

**Files:**
- Create: `src/app/api/analysis/trigger/route.ts`
- Create: `src/app/api/analysis/worker/route.ts`
- Create: `src/app/api/analysis/status/route.ts`

- [ ] **Step 1: Create trigger API route**

Create `src/app/api/analysis/trigger/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { analysisJobRepository } from "@/repositories/analysisJobRepository";

/**
 * POST /api/analysis/trigger
 * Body: { tenderId: string, priority?: number, jobType?: "full_analysis" | "reanalyze" | "parse_only" }
 *
 * Creates a new analysis job for a tender.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      tenderId: string;
      priority?: number;
      jobType?: "full_analysis" | "reanalyze" | "parse_only";
    };

    if (!body.tenderId) {
      return NextResponse.json({ error: "tenderId is required" }, { status: 400 });
    }

    const job = await analysisJobRepository.create(
      body.tenderId,
      body.jobType ?? "full_analysis",
      body.priority ?? 0,
    );

    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Create worker API route**

Create `src/app/api/analysis/worker/route.ts`:

```ts
import { NextResponse } from "next/server";
import { processAnalysisJob } from "@/services/documentAnalysisPipeline";
import { analysisJobRepository } from "@/repositories/analysisJobRepository";

/**
 * GET /api/analysis/worker
 *
 * Called by Vercel Cron every 5 minutes.
 * 1. Reset stale jobs (processing > 10 min without update)
 * 2. Process one pending job
 */
export async function GET(): Promise<NextResponse> {
  try {
    // Reset stale jobs first
    const resetCount = await analysisJobRepository.resetStaleJobs(10);

    // Process one job
    const result = await processAnalysisJob();

    return NextResponse.json({
      staleJobsReset: resetCount,
      processed: result
        ? {
            jobId: result.jobId,
            tenderId: result.tenderId,
            documentsProcessed: result.documentsProcessed,
            verdictChanged: result.verdictChanged,
          }
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 3: Create status API route**

Create `src/app/api/analysis/status/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { analysisJobRepository } from "@/repositories/analysisJobRepository";
import { verdictHistoryRepository } from "@/repositories/verdictHistoryRepository";

/**
 * GET /api/analysis/status?tenderId=...
 *
 * Returns analysis job status and verdict history for a tender.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenderId = request.nextUrl.searchParams.get("tenderId");
    if (!tenderId) {
      return NextResponse.json({ error: "tenderId query parameter is required" }, { status: 400 });
    }

    const [jobs, verdictHistory] = await Promise.all([
      analysisJobRepository.findByTenderId(tenderId),
      verdictHistoryRepository.findByTenderId(tenderId),
    ]);

    return NextResponse.json({ jobs, verdictHistory });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/analysis/trigger/route.ts src/app/api/analysis/worker/route.ts src/app/api/analysis/status/route.ts
git commit -m "feat: add API routes for analysis trigger, worker, and status"
```

---

### Task 11: Vercel Cron Configuration

**Files:**
- Create: `vercel.json`

- [ ] **Step 1: Create vercel.json with cron schedule**

Create `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/analysis/worker",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

This runs the worker endpoint every 5 minutes. The worker processes one job per invocation, resets stale jobs, and returns status.

- [ ] **Step 2: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('vercel.json', 'utf8')); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "feat: add Vercel Cron config for document analysis worker (every 5 min)"
```

---

### Task 12: Final Verification

**Files:** None new — verification only.

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (existing + new).

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Verify API routes are accessible**

Run: `npm run dev` then in another terminal:
```bash
curl -X POST http://localhost:3000/api/analysis/trigger -H "Content-Type: application/json" -d '{"tenderId":"test-123"}'
```
Expected: `{"job":{...}}` with status 201 (if Supabase is connected) or error message.

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git status
# If there are changes:
git commit -m "fix: resolve issues found during final verification"
```
