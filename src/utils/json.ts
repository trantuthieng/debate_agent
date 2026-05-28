import { JsonParseError } from './errors';

/**
 * Safely parse JSON, returning null on failure instead of throwing.
 */
export function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Extract a JSON object or array from text that may contain markdown, prose, etc.
 * Tries multiple strategies in order.
 */
export function extractJsonFromText(text: string): string | null {
  // Strategy 1: JSON inside a markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    const candidate = codeBlockMatch[1].trim();
    if (isValidJson(candidate)) {
      return candidate;
    }
  }

  // Strategy 2: Find outermost { } JSON object
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.substring(firstBrace, lastBrace + 1);
    if (isValidJson(candidate)) {
      return candidate;
    }
  }

  // Strategy 3: Find outermost [ ] JSON array
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const candidate = text.substring(firstBracket, lastBracket + 1);
    if (isValidJson(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Parse JSON from a model response, handling markdown code blocks and embedded JSON.
 * Throws JsonParseError if no valid JSON is found.
 */
export function parseJsonResponse<T>(raw: string): T {
  // Try direct parse first (response may already be pure JSON)
  const direct = safeJsonParse<T>(raw.trim());
  if (direct !== null) {
    return direct;
  }

  // Try extracting JSON from the text
  const extracted = extractJsonFromText(raw);
  if (extracted) {
    const parsed = safeJsonParse<T>(extracted);
    if (parsed !== null) {
      return parsed;
    }
  }

  throw new JsonParseError(raw);
}

/**
 * Check if a string is valid JSON.
 */
export function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pretty-print JSON with 2-space indentation.
 */
export function prettyJson(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

/**
 * Safely stringify, returning empty string on circular reference.
 */
export function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return '';
  }
}
