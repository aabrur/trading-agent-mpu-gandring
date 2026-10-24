/** Bounds local model subprocesses without serializing independent teammate work. */
export class AgentWorkQueue {
  private active = 0;
  private waiting: Array<{ signal?: AbortSignal; start: () => void; cancel: () => void }> = [];
  constructor(private capacity: number) { if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid model process capacity'); }
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Model request cancelled')); return; }
      const entry = {
        signal,
        start: () => {
          signal?.removeEventListener('abort', entry.cancel);
          this.active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true; this.active--;
            this.waiting.shift()?.start();
          });
        },
        cancel: () => {
          this.waiting = this.waiting.filter(item => item !== entry);
          signal?.removeEventListener('abort', entry.cancel);
          reject(new Error('Model request cancelled'));
        }
      };
      if (this.active < this.capacity) entry.start();
      else { this.waiting.push(entry); signal?.addEventListener('abort', entry.cancel, { once: true }); }
    });
  }
}
