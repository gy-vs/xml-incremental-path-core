import type { Match } from './events.js';

export type OverflowPolicy =
  /** Drop the oldest buffered match once the queue is full. Never blocks. */
  | 'drop-oldest'
  /** Drop the newest (current) match once the queue is full. Never blocks. */
  | 'drop-newest'
  /** Producer side: feed() returns a promise that resolves on free capacity. */
  | 'wait'
  /** Fail the producer feed() call (and the consumer) once the queue is full. */
  | 'fail';

export class BackpressureError extends Error {
  constructor(
    readonly queryId: number,
    readonly highWatermark: number,
  ) {
    super(`result queue for query ${queryId} exceeded ${highWatermark} matches`);
    this.name = 'BackpressureError';
  }
}

interface Waiter {
  kind: 'space' | 'data';
  resolve: (ready: boolean) => void;
  reject: (err: Error) => void;
}

/**
 * Bounded async-iterator queue for a single query. Each registered query owns
 * one of these, so a full queue (or a cancelled consumer) is contained to that
 * query: the shared traversal keeps feeding every other query.
 */
export class ResultQueue implements AsyncIterable<Match>, AsyncIterator<Match> {
  #buffer: Match[] = [];
  #waiters: Waiter[] = [];
  #closed = false;
  #error: Error | null = null;
  #capacity: number;
  #policy: OverflowPolicy;

  constructor(
    readonly queryId: number,
    highWatermark: number,
    policy: OverflowPolicy,
  ) {
    this.#capacity = highWatermark;
    this.#policy = policy;
  }

  get size(): number {
    return this.#buffer.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get failed(): boolean {
    return this.#error !== null;
  }

  /**
   * Deliver a match. With 'wait' resolves once capacity exists (or the queue
   * was cancelled). With 'fail' rejects once full; the match is not enqueued.
   * Drop policies resolve immediately. Returns false when the consumer is
   * gone (cancelled/errored/closed), so the producer can drop the query.
   */
  async push(match: Match): Promise<boolean> {
    if (this.#error || this.#closed) return false;

    if (this.#buffer.length < this.#capacity) {
      this.enqueue(match);
      return true;
    }

    switch (this.#policy) {
      case 'drop-oldest':
        if (this.#capacity > 0) this.#buffer.shift();
        this.enqueue(match);
        return true;
      case 'drop-newest':
        return true; // discard `match`
      case 'fail': {
        this.fail(new BackpressureError(this.queryId, this.#capacity));
        return false;
      }
      case 'wait': {
        while (this.#buffer.length >= this.#capacity && !this.#closed && !this.#error) {
          const ready = await new Promise<boolean>((resolve, reject) => {
            this.#waiters.push({ kind: 'space', resolve, reject });
          });
          if (!ready) return false;
        }
        if (this.#error || this.#closed) return false;
        this.enqueue(match);
        return true;
      }
    }
  }

  private enqueue(match: Match): void {
    this.#buffer.push(match);
    const at = this.#waiters.findIndex((w) => w.kind === 'data');
    if (at >= 0) this.#waiters.splice(at, 1)[0].resolve(true);
  }

  // --- AsyncIterator (consumer side) -------------------------------------

  next(): Promise<IteratorResult<Match>> {
    const m = this.#buffer.shift();
    if (m !== undefined) {
      this.wakeSpaceWaiter();
      return Promise.resolve({ value: m, done: false });
    }
    if (this.#error) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.#waiters.push({
        kind: 'data',
        reject,
        resolve: () => {
          const value = this.#buffer.shift();
          if (value === undefined) {
            resolve({ value: undefined, done: true });
          } else {
            this.wakeSpaceWaiter();
            resolve({ value, done: false });
          }
        },
      });
    });
  }

  return(): Promise<IteratorResult<Match>> {
    // Consumer abandoned the iterator (e.g. `break` in a for-await loop).
    this.cancel();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<Match> {
    return this;
  }

  /** Normal end-of-traversal; buffered matches are still delivered. */
  close(): void {
    this.#closed = true;
    this.finishWaiters();
  }

  /** Detach the consumer immediately; buffered matches are discarded. */
  cancel(): void {
    this.#closed = true;
    this.#buffer = [];
    this.finishWaiters();
  }

  fail(err: Error): void {
    this.#error = err;
    this.#closed = true;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) {
      if (w.kind === 'data') w.reject(err);
      else w.resolve(false);
    }
  }

  private wakeSpaceWaiter(): void {
    const at = this.#waiters.findIndex((w) => w.kind === 'space');
    if (at >= 0) this.#waiters.splice(at, 1)[0].resolve(true);
  }

  private finishWaiters(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w.resolve(false);
  }
}
