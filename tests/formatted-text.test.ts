import { describe, expect, it } from 'vitest';
import { extractCleanText } from '../web/src/formatText';

describe('FormattedText clean unwrapping', () => {
  it('extracts reply string from raw json object', () => {
    const raw = JSON.stringify({
      reply: 'Aman dan terkendali, **Boss**.',
      confidence: 0.9,
      claimRefs: [],
      contraryRefs: []
    });
    expect(extractCleanText(raw)).toBe('Aman dan terkendali, **Boss**.');
  });

  it('extracts reply from fenced markdown code block', () => {
    const raw = '```json\n{"reply": "Meja trading aman **Boss**."}\n```';
    expect(extractCleanText(raw)).toBe('Meja trading aman **Boss**.');
  });

  it('extracts text or message property when reply is missing', () => {
    const raw1 = JSON.stringify({ text: 'Status normal.' });
    expect(extractCleanText(raw1)).toBe('Status normal.');

    const raw2 = JSON.stringify({ message: 'Posisi open.' });
    expect(extractCleanText(raw2)).toBe('Posisi open.');
  });

  it('keeps normal human text intact', () => {
    const raw = 'Halo Boss! Semua aman dan terkendali.';
    expect(extractCleanText(raw)).toBe('Halo Boss! Semua aman dan terkendali.');
  });
});
