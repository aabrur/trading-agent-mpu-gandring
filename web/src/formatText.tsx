import React, { Fragment } from 'react';

/**
 * Extracts inner clean reply if the text is wrapped in JSON or markdown codeblocks.
 * Handles AI model raw JSON output like: {"reply": "...", "confidence": 0.9, ...}
 */
export function extractCleanText(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  let candidate = trimmed;
  if (candidate.startsWith('```')) {
    candidate = candidate.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.reply === 'string' && parsed.reply) return parsed.reply;
        if (typeof parsed.text === 'string' && parsed.text) return parsed.text;
        if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
        if (typeof parsed.content === 'string' && parsed.content) return parsed.content;
      }
    } catch {
      // Keep raw string if JSON parsing fails
    }
  }
  return raw;
}

/**
 * Renders formatted content with bold, italic, inline code, and line breaks.
 */
export function renderFormattedContent(text: string): React.ReactNode {
  const clean = extractCleanText(text);
  if (!clean) return null;

  const lines = clean.split('\n');
  return lines.map((line, lineIdx) => {
    // Regex splits into bold (**...** / __...__), inline code (`...`), and italic (*...* / _..._)
    const parts = line.split(/(\*\*[^*]+?\*\*|__[^_]+?__|`[^`]+?`|\*[^*]+?\*|_[^_]+?_)/g);
    const renderedLine = parts.map((part, partIdx) => {
      if (
        (part.startsWith('**') && part.endsWith('**') && part.length >= 4) ||
        (part.startsWith('__') && part.endsWith('__') && part.length >= 4)
      ) {
        return <strong key={partIdx}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
        return <code key={partIdx}>{part.slice(1, -1)}</code>;
      }
      if (
        (part.startsWith('*') && part.endsWith('*') && part.length >= 2) ||
        (part.startsWith('_') && part.endsWith('_') && part.length >= 2)
      ) {
        return <em key={partIdx}>{part.slice(1, -1)}</em>;
      }
      return part;
    });

    return (
      <Fragment key={lineIdx}>
        {lineIdx > 0 && <br />}
        {renderedLine}
      </Fragment>
    );
  });
}

export function FormattedText({ text, className }: { text: string; className?: string }) {
  return <span className={`formatted-text ${className ?? ''}`.trim()}>{renderFormattedContent(text)}</span>;
}
