import * as fs from 'fs';

// -----------------------------------------------------------------------
// ContextSection
// -----------------------------------------------------------------------

/**
 * A named section of text to be included in an agent prompt.
 * Sections are assembled in priority order within a character budget.
 */
export interface ContextSection {
  /**
   * Markdown heading for this section, e.g. `"# User Prompt"`.
   * Pass `''` when the content already contains its own heading.
   */
  heading: string;

  /** The actual content text. Sections with blank content are skipped. */
  content: string;

  /**
   * Budget priority (1 = highest).
   * High-priority sections are allocated first; low-priority sections are
   * truncated or dropped when the character budget is exhausted.
   */
  priority: number;

  /**
   * Optional upper bound on how large a fraction of the total budget this
   * section may consume (0–1).
   *
   * Default fractions by priority tier:
   *   priority 1–2  → 0.40   (critical context: task, user prompt)
   *   priority 3–5  → 0.25   (important reference: brief, arch)
   *   priority 6–8  → 0.15   (supporting context: toolchain, git)
   *   priority 9–10 → 0.08   (low-signal: assumptions, open questions)
   */
  maxFraction?: number;
}

// -----------------------------------------------------------------------
// Internal file-cache entry
// -----------------------------------------------------------------------

interface FileCacheEntry {
  content: string;
  mtimeMs: number;
}

// -----------------------------------------------------------------------
// ContextCache
// -----------------------------------------------------------------------

/**
 * ContextCache — two-in-one utility for efficient agent context management.
 *
 * **File cache** (`readFile`)
 *   Reads workspace files and caches their content keyed by absolute path
 *   + mtime. Subsequent reads of an unchanged file return the cached string
 *   without hitting the filesystem. Call `invalidate(path)` after writing,
 *   or `clear()` at the start of a new workflow.
 *
 * **Budget-aware assembler** (`buildContext`)
 *   Assembles an ordered list of `ContextSection`s into a single string that
 *   fits within a caller-supplied character budget.
 *
 *   The target budget is:
 *     `num_ctx  ×  4 chars/token  ×  0.60`
 *   which reserves ~40 % for the system prompt and model overhead, and keeps
 *   the user message at roughly 60 % of the model's context window.
 *
 *   Sections are consumed greedily in priority order:
 *     1. Sort by `priority` ascending (1 = first served).
 *     2. Allocate `min(content.length, maxFraction × budget, remaining)`.
 *     3. Middle-truncate oversized sections to fit their allocation.
 *     4. Stop when the budget is exhausted.
 */
export class ContextCache {
  /** Absolute path → cached file content + mtime */
  private readonly _fileCache = new Map<string, FileCacheEntry>();

  // ------------------------------------------------------------------
  // File cache
  // ------------------------------------------------------------------

  /**
   * Return the content of `absolutePath`, using the mtime-invalidated
   * cache.  Returns `null` when the file does not exist or is unreadable.
   */
  readFile(absolutePath: string): string | null {
    try {
      const stat = fs.statSync(absolutePath);
      const cached = this._fileCache.get(absolutePath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.content;
      }
      const content = fs.readFileSync(absolutePath, 'utf8');
      this._fileCache.set(absolutePath, { content, mtimeMs: stat.mtimeMs });
      return content;
    } catch {
      return null;
    }
  }

  /** Remove a single entry from the cache (e.g. immediately after writing). */
  invalidate(absolutePath: string): void {
    this._fileCache.delete(absolutePath);
  }

  /** Clear the entire file cache. Call at the start of each new workflow. */
  clear(): void {
    this._fileCache.clear();
  }

  // ------------------------------------------------------------------
  // Context assembly
  // ------------------------------------------------------------------

  /**
   * Assemble `sections` into a single context string within `totalBudget`
   * characters.
   *
   * Fast path: if the combined content already fits, all sections are joined
   * without any truncation.
   *
   * Slow path: sections are consumed in priority order; each section is
   * allocated `min(content.length, maxFraction × totalBudget, remaining)`
   * characters.  Oversized sections are middle-truncated so that the head
   * (requirements / task definition) and tail (latest error / code) are both
   * preserved.
   */
  buildContext(sections: ContextSection[], totalBudget: number): string {
    const active = sections
      .filter(s => s.content.trim().length > 0)
      .sort((a, b) => a.priority - b.priority);

    if (active.length === 0) { return ''; }

    // Fast path — everything fits without truncation.
    const totalLen = active.reduce(
      (n, s) => n + (s.heading ? s.heading.length + 4 : 0) + s.content.length,
      0,
    );
    if (totalLen <= totalBudget) {
      return active
        .map(s => s.heading ? `${s.heading}\n\n${s.content}` : s.content)
        .join('\n\n');
    }

    // Slow path — greedy allocation in priority order.
    const parts: string[] = [];
    let remaining = totalBudget;

    for (const section of active) {
      if (remaining <= 0) { break; }

      const headingOverhead = section.heading ? section.heading.length + 4 : 0;
      const contentBudget = remaining - headingOverhead;
      if (contentBudget <= 0) { break; }

      const maxFrac = section.maxFraction ?? this._defaultMaxFraction(section.priority);
      const alloc = Math.min(
        section.content.length,
        Math.floor(totalBudget * maxFrac),
        contentBudget,
      );
      if (alloc <= 0) { continue; }

      const body = alloc >= section.content.length
        ? section.content
        : this._truncateMiddle(section.content, alloc);

      parts.push(section.heading ? `${section.heading}\n\n${body}` : body);
      remaining -= headingOverhead + body.length + 4; // +4 for the '\n\n' separator
    }

    return parts.join('\n\n');
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private _defaultMaxFraction(priority: number): number {
    if (priority <= 2) { return 0.40; }
    if (priority <= 5) { return 0.25; }
    if (priority <= 8) { return 0.15; }
    return 0.08;
  }

  /**
   * Middle-truncation: keep the first `keep` chars and the last `keep` chars,
   * joined by a compact marker.  Preserves the leading task/requirement
   * definition and the trailing error/diff which are most useful to the model.
   */
  private _truncateMiddle(text: string, maxChars: number): string {
    if (text.length <= maxChars) { return text; }
    const MARKER = '\n\n[...middle truncated for token budget...]\n\n';
    const keep = Math.max(200, Math.floor((maxChars - MARKER.length) / 2));
    return `${text.slice(0, keep)}${MARKER}${text.slice(-keep)}`;
  }
}
