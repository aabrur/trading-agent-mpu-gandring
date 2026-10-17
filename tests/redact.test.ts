import { describe, it, expect } from 'vitest';
import { redact } from '../server/redact.js';

describe('redaction', () => {
  it('removes key-shaped strings', () => {
    const text = 'xai-abcdefghijklmnop1234 sk-proj-ABCDEFGHIJKLMNOPQRSTUV sk-ant-api03-zzzzzzzzzzzzzz AIzaSyA1234567890abcdefghijk Bearer abc.def.ghijklmnop api_key=supersecretvalue';
    const out = redact(text);
    expect(out).not.toMatch(/abcdefghijklmnop1234|ABCDEFGHIJKLMNOPQRSTUV|zzzzzzzzzzzzzz|AIzaSy|abc\.def|supersecretvalue/);
    expect(out).toContain('[REDACTED]');
  });
  it('removes explicitly known secrets anywhere', () => {
    expect(redact('the key is hunter2hunter2!', ['hunter2hunter2'])).toBe('the key is [REDACTED]!');
  });
  it('leaves normal prices alone', () => {
    expect(redact('BTCUSDT 67250.5 stop 66241.2')).toBe('BTCUSDT 67250.5 stop 66241.2');
  });
});
