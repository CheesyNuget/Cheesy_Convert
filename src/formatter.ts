import { requestUrl } from 'obsidian';

/** Model used for the formatting/tagging pass (separate API call from the OCR step). */
export const FORMAT_MODEL = 'gemini-3.5-flash-lite';

/** Handwritten phrase that turns a line into a to-do checkbox. */
const TRIGGER_RE = /look(?:ing)?\s+into\s+this/i;

const SYSTEM_PROMPT = `You are a note formatter for Obsidian. You receive raw Markdown that was OCR-transcribed from handwritten notes. Return a cleaned-up version plus tags.

Formatting rules:
1. Do NOT add, remove, summarise or reword content. Only fix structure and formatting. You may fix obvious OCR typos and broken line wraps.
2. Add a clear heading hierarchy (#, ##, ###) where the notes imply sections. Do not invent a title that is not implied by the content.
3. Turn run-on or fragmented lines into proper bullet lists or numbered lists where the structure is clearly a list. Use consistent indentation for nested items.
4. Keep tables as Markdown tables.
5. Preserve all LaTeX exactly: $...$ inline and $$...$$ for blocks.
6. Remove stray page markers, duplicated blank lines and trailing whitespace.
7. Any item, line or section the author marked with the note "look into this" (or very close wording) must become a task checkbox: "- [ ] <the item text>". Keep the words "look into this" at the end of that item, in parentheses. Do not tick the box.
8. Do not wrap the output in code fences.

Tag rules:
- Return 3 to 6 tags describing the subject matter (topic, field, type of note).
- Lowercase, hyphen-separated, no spaces, no leading #. Example: control-theory, lecture-notes.`;

export interface FormatResult {
  markdown: string;
  tags: string[];
}

/**
 * Second, independent call to the Gemini API: formats the OCR output and suggests tags.
 * Uses Gemini's native generateContent endpoint with a JSON response schema.
 */
export async function formatMarkdown(
  rawMarkdown: string,
  apiKey: string,
  timeoutMs: number
): Promise<FormatResult> {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: rawMarkdown }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          markdown: { type: 'STRING' },
          tags: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['markdown', 'tags'],
      },
    },
  };

  const request = requestUrl({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${FORMAT_MODEL}:generateContent`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
    throw: false,
  });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Formatting request timeout')), timeoutMs)
  );
  const response = await Promise.race([request, timeout]);

  if (response.status >= 400) {
    throw new Error(`Gemini API Error ${response.status}: ${response.text.substring(0, 300)}`);
  }

  const parts: any[] = response.json?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter(p => !p.thought)
    .map(p => p.text ?? '')
    .join('')
    .trim();

  if (!text) {
    throw new Error('Gemini returned an empty formatting response');
  }

  try {
    const parsed = JSON.parse(text);
    return {
      markdown: String(parsed.markdown ?? '').trim() || rawMarkdown,
      tags: cleanTags(parsed.tags),
    };
  } catch {
    // Model ignored the schema: keep whatever it returned as the note body, no tags.
    return { markdown: text, tags: [] };
  }
}

function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  for (const t of tags) {
    const tag = String(t)
      .toLowerCase()
      .trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9/_-]/g, '');
    if (tag) seen.add(tag);
  }
  return Array.from(seen).slice(0, 6);
}

/** Safety net: make sure every "look into this" line is an unticked checkbox. */
export function checkboxLookIntoThis(markdown: string): string {
  return markdown
    .split('\n')
    .map(line => {
      if (!TRIGGER_RE.test(line)) return line;
      if (/^\s*[-*+]\s+\[[ xX]\]/.test(line)) return line; // already a checkbox
      if (/^#{1,6}\s/.test(line)) return line; // leave headings alone
      const item = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
      if (item) return `${item[1]}- [ ] ${item[2]}`;
      return `- [ ] ${line.trim()}`;
    })
    .join('\n');
}

/** Final note: YAML frontmatter (tags + source) followed by the formatted body. */
export function buildNote(markdown: string, tags: string[], sourceName: string): string {
  const lines = ['---'];
  if (tags.length) {
    lines.push('tags:');
    tags.forEach(t => lines.push(`  - ${t}`));
  }
  lines.push(`source: "[[${sourceName}]]"`, '---', '');
  return lines.join('\n') + checkboxLookIntoThis(markdown) + '\n';
}
