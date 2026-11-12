import { clipText, flattenMessageText, normalizeWhitespace, uniqueStrings } from "./helpers.js";
import type { AgentMessage, StructuredSessionState } from "./types.js";

/**
 * Post-compaction cleanup options
 */
export type CleanupOptions = {
  /** Remove items already present in recent messages */
  deduplicateWithRecent: boolean;
  /** Remove stale items that haven't been updated for many turns */
  removeStaleItems: boolean;
  staleItemThreshold: number; // Number of compactions before an item is considered stale
  /** Merge similar items */
  mergeSimilarItems: boolean;
  similarityThreshold: number; // 0-1 similarity score threshold
  /** Enforce max items per category */
  enforceLimits: boolean;
  maxItemsPerCategory: number;
  /** Update timestamp tracking */
  trackItemAge: boolean;
};

export const DEFAULT_CLEANUP_OPTIONS: CleanupOptions = {
  deduplicateWithRecent: true,
  removeStaleItems: false,
  staleItemThreshold: 3,
  mergeSimilarItems: true,
  similarityThreshold: 0.7,
  enforceLimits: true,
  maxItemsPerCategory: 12,
  trackItemAge: false,
};

function filterRepeatedItems(
  items: string[],
  recentText: string,
): { next: string[]; removed: number } {
  let removed = 0;
  const next = items.filter((item) => {
    const keep = !recentText.includes(item.toLowerCase());
    if (!keep) {
      removed += 1;
    }
    return keep;
  });
  return {
    next: uniqueStrings(next, items.length),
    removed,
  };
}

/**
 * Calculate simple similarity between two strings
 * Returns a value between 0 (completely different) and 1 (identical)
 */
function calculateSimilarity(a: string, b: string): number {
  const aLower = a.toLowerCase().trim();
  const bLower = b.toLowerCase().trim();

  if (aLower === bLower) return 1;
  if (aLower.includes(bLower) || bLower.includes(aLower)) return 0.9;

  const aWords = new Set(aLower.split(/\s+/));
  const bWords = new Set(bLower.split(/\s+/));

  const intersection = new Set([...aWords].filter((x) => bWords.has(x)));
  const union = new Set([...aWords, ...bWords]);

  return intersection.size / union.size;
}

/**
 * Merge similar items, keeping the most detailed one
 */
function mergeSimilarItems(items: string[], threshold: number): string[] {
  const merged: string[] = [];
  const used = new Set<number>();

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;

    let bestItem = items[i];
    const similar: string[] = [items[i]];

    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;

      const similarity = calculateSimilarity(items[i], items[j]);
      if (similarity >= threshold) {
        similar.push(items[j]);
        used.add(j);

        // Keep the longer/more detailed item
        if (items[j].length > bestItem.length) {
          bestItem = items[j];
        }
      }
    }

    merged.push(bestItem);
  }

  return merged;
}

/**
 * Remove stale items that are likely outdated
 * Heuristic: items containing temporal markers that indicate they're old
 */
function removeStaleItems(items: string[], threshold: number): { next: string[]; removed: number } {
  const stalePatterns = [
    /\b(yesterday|last week|previous|earlier|before)\b/i,
    /\b(already|finished|completed)\s+(?:done|fixed|implemented)\b/i,
    /\b(?:no longer|not|doesn't)\s+(?:needed|relevant|apply)\b/i,
    /\b(temp|temporary|test|draft)\b/i,
    /\b(?:TODO|FIXME|XXX|HACK)\b.*\b(done|fixed)\b/i,
  ];

  let removed = 0;
  const next = items.filter((item) => {
    const isStale = stalePatterns.some((pattern) => pattern.test(item));
    if (isStale) {
      removed += 1;
    }
    return !isStale;
  });

  return { next: uniqueStrings(next, items.length), removed };
}

/**
 * Enforce maximum items per category with smart selection
 * Prioritize: more recent items, longer items (more detail), items with unique words
 */
function enforceLimits(items: string[], maxItems: number): string[] {
  if (items.length <= maxItems) {
    return items;
  }

  // Score items based on various factors
  const scored = items.map((item, index) => {
    const recencyScore = (items.length - index) / items.length; // More recent = higher score
    const detailScore = Math.min(item.length / 100, 1); // Longer items get higher score, capped at 100 chars
    const uniquenessScore =
      new Set(item.toLowerCase().split(/\s+/)).size / Math.max(1, item.split(/\s+/).length);

    const totalScore = recencyScore * 0.4 + detailScore * 0.3 + uniquenessScore * 0.3;
    return { item, score: totalScore };
  });

  // Sort by score and take top items
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)
    .map((s) => s.item);
}

export function cleanupStateAfterCompaction(
  params: {
    state: StructuredSessionState;
    recentMessages: AgentMessage[];
  },
  options: Partial<CleanupOptions> = {},
): { state: StructuredSessionState; notes: string[] } {
  const opts = { ...DEFAULT_CLEANUP_OPTIONS, ...options };
  const notes: string[] = [];
  let state = { ...params.state };

  // Step 1: Deduplicate with recent messages
  if (opts.deduplicateWithRecent && params.recentMessages.length > 0) {
    const recentText = params.recentMessages
      .map((message) => normalizeWhitespace(flattenMessageText(message)).toLowerCase())
      .filter(Boolean)
      .join("\n");

    if (recentText) {
      const done = filterRepeatedItems(state.done, recentText);
      const todos = filterRepeatedItems(state.open_todos, recentText);
      const files = filterRepeatedItems(state.changed_files, recentText);
      const outputs = filterRepeatedItems(state.important_outputs, recentText);
      const constraints = filterRepeatedItems(state.constraints, recentText);
      const decisions = filterRepeatedItems(state.decisions, recentText);
      const blockers = filterRepeatedItems(state.blockers, recentText);

      const dedupeRemoved =
        done.removed +
        todos.removed +
        files.removed +
        outputs.removed +
        constraints.removed +
        decisions.removed +
        blockers.removed;

      if (dedupeRemoved > 0) {
        notes.push(`Deduplicated ${dedupeRemoved} item(s) already present in recent messages.`);
      }

      state = {
        ...state,
        done: done.next,
        open_todos: todos.next,
        changed_files: files.next,
        important_outputs: outputs.next,
        constraints: constraints.next,
        decisions: decisions.next,
        blockers: blockers.next,
      };
    }
  }

  // Step 2: Remove stale items
  if (opts.removeStaleItems) {
    const staleResults = {
      done: removeStaleItems(state.done, opts.staleItemThreshold),
      todos: removeStaleItems(state.open_todos, opts.staleItemThreshold),
      decisions: removeStaleItems(state.decisions, opts.staleItemThreshold),
      blockers: removeStaleItems(state.blockers, opts.staleItemThreshold),
    };

    const staleRemoved =
      staleResults.done.removed +
      staleResults.todos.removed +
      staleResults.decisions.removed +
      staleResults.blockers.removed;

    if (staleRemoved > 0) {
      notes.push(`Removed ${staleRemoved} stale item(s).`);
      state = {
        ...state,
        done: staleResults.done.next,
        open_todos: staleResults.todos.next,
        decisions: staleResults.decisions.next,
        blockers: staleResults.blockers.next,
      };
    }
  }

  // Step 3: Merge similar items
  if (opts.mergeSimilarItems) {
    const beforeCount =
      state.done.length + state.open_todos.length + state.blockers.length + state.decisions.length;

    state = {
      ...state,
      done: mergeSimilarItems(state.done, opts.similarityThreshold),
      open_todos: mergeSimilarItems(state.open_todos, opts.similarityThreshold),
      blockers: mergeSimilarItems(state.blockers, opts.similarityThreshold),
      decisions: mergeSimilarItems(state.decisions, opts.similarityThreshold),
      important_outputs: mergeSimilarItems(state.important_outputs, opts.similarityThreshold),
    };

    const afterCount =
      state.done.length + state.open_todos.length + state.blockers.length + state.decisions.length;
    const mergedCount = beforeCount - afterCount;

    if (mergedCount > 0) {
      notes.push(`Merged ${mergedCount} similar item(s).`);
    }
  }

  // Step 4: Enforce limits
  if (opts.enforceLimits) {
    const beforeCount = Object.values(state).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0,
    );

    state = {
      ...state,
      done: enforceLimits(state.done, opts.maxItemsPerCategory),
      open_todos: enforceLimits(state.open_todos, opts.maxItemsPerCategory),
      changed_files: enforceLimits(state.changed_files, opts.maxItemsPerCategory),
      important_outputs: enforceLimits(state.important_outputs, opts.maxItemsPerCategory),
      constraints: enforceLimits(state.constraints, opts.maxItemsPerCategory),
      decisions: enforceLimits(state.decisions, opts.maxItemsPerCategory),
      blockers: enforceLimits(state.blockers, opts.maxItemsPerCategory),
    };

    const afterCount = Object.values(state).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0,
    );
    const trimmedCount = beforeCount - afterCount;

    if (trimmedCount > 0) {
      notes.push(
        `Trimmed to max ${opts.maxItemsPerCategory} items per category (${trimmedCount} removed).`,
      );
    }
  }

  // Step 5: Update goal if needed (truncate if too long)
  if (state.goal && state.goal.length > 240) {
    state.goal = clipText(state.goal, 240);
    notes.push("Truncated goal to 240 characters.");
  }

  return {
    state,
    notes: notes.length > 0 ? notes : ["Post-compaction cleanup completed with no changes."],
  };
}
