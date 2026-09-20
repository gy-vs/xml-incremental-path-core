import {
  compilePath,
  type CompiledPath,
  type CompiledStep,
  type NameTest,
  type PrefixMap,
} from './path.js';
import { ResultQueue, type OverflowPolicy } from './queue.js';
import type { ElementInfo, Match, XmlEvent } from './events.js';

/**
 * Incremental restricted-path selector.
 *
 * Each registered path is compiled into an NFA of `steps.length + 1` states,
 * represented at runtime as an integer bit mask stored per open element
 * (frame). State `k` means "the first k steps have matched along the path to
 * this element". On startElement every live query's mask is advanced one
 * frame:
 *
 *   - a descendant step's state *lingers* (bit stays set at any depth);
 *   - a state advances by one bit when the new element passes the next
 *     step's name test and predicates;
 *
 * on endElement the frame is dropped, releasing every state that only existed
 * inside that subtree. Active work is therefore O(depth x queries x
 * path-length), never O(number of nodes read): a million finished siblings
 * leave nothing behind.
 */

export interface RegisterOptions {
  /** Path expression, e.g. `/ns:root//item[@kind="x"][2]`. */
  path: string;
  /** Prefix -> URI bindings used while compiling the path. */
  prefixes?: PrefixMap;
  /** Maximum buffered matches before `policy` applies. Default 256. */
  highWatermark?: number;
  /** What happens at the high watermark. Default 'drop-oldest'. */
  overflowPolicy?: OverflowPolicy;
}

export interface Query extends AsyncIterable<Match> {
  readonly id: number;
  readonly expression: string;
  /** Matches buffered but not yet consumed. */
  readonly pending: number;
  /** False once cancelled, failed (overflow), or the traversal finished. */
  readonly alive: boolean;
  /** Stop participating in the traversal. Other queries are unaffected. */
  cancel(): void;
  [Symbol.asyncIterator](): AsyncIterator<Match>;
}

interface InternalQuery {
  id: number;
  path: CompiledPath;
  lingerMask: number;
  finalBit: number;
  queue: ResultQueue;
  alive: boolean;
}

interface MatchBuilder {
  query: InternalQuery;
  match: Match;
}

interface Frame {
  /** query id -> NFA state mask held by THIS element. */
  masks: Map<number, number>;
  /**
   * Same-named sibling counters for positional predicates, keyed by
   * `(queryId << 16) | (stepIndex << 8) | predicateIndex`. A positional
   * predicate at index j counts only siblings that passed predicates
   * 0..j-1 (XPath chained-filter semantics), so every positional predicate
   * owns an independent counter. Map size is bounded by registered queries
   * and path length, never by the number of siblings read.
   */
  counters: Map<number, number>;
  /** Length of the global open-builders list when this frame was pushed. */
  builderTail: number;
}

const STEP_BITS = 8; // supports up to 255 steps/predicates; compilePath caps at 30

export class StreamingPathSelector {
  #queries = new Map<number, InternalQuery>();
  #frames: Frame[] = [
    { masks: new Map(), counters: new Map(), builderTail: 0 },
  ];
  #builders: MatchBuilder[] = [];
  #nextId = 1;

  /** Current element depth (0 before the document element). */
  get depth(): number {
    return this.#frames.length - 1;
  }

  get queryCount(): number {
    let n = 0;
    for (const q of this.#queries.values()) if (q.alive) n += 1;
    return n;
  }

  /**
   * Total live NFA states across all open frames and queries. Stays bounded
   * by depth x registered-query size regardless of how many nodes have been
   * consumed.
   */
  activeStateCount(): number {
    let total = 0;
    for (const frame of this.#frames) {
      for (const mask of frame.masks.values()) total += popCount(mask);
    }
    return total;
  }

  register(options: RegisterOptions): Query {
    const path = compilePath(options.path, options.prefixes ?? {});
    const id = this.#nextId++;
    const lingerMask = path.steps.reduce(
      (mask, step, k) => (step.descendant ? mask | (1 << k) : mask),
      0,
    );
    const internal: InternalQuery = {
      id,
      path,
      lingerMask,
      finalBit: 1 << path.steps.length,
      queue: new ResultQueue(
        id,
        options.highWatermark ?? 256,
        options.overflowPolicy ?? 'drop-oldest',
      ),
      alive: true,
    };
    this.#queries.set(id, internal);
    // A query registered mid-traversal starts looking from the current
    // element downward; it cannot match ancestors already consumed.
    this.#frames.at(-1)!.masks.set(id, 1);

    const selector = this;
    return {
      id,
      expression: options.path,
      get pending() {
        return internal.queue.size;
      },
      get alive() {
        return internal.alive;
      },
      cancel() {
        selector.#cancel(id);
      },
      [Symbol.asyncIterator]() {
        return internal.queue;
      },
    };
  }

  // --- event surface ------------------------------------------------------

  startElement(element: ElementInfo): void {
    const parent = this.#frames.at(-1)!;
    const frame: Frame = {
      masks: new Map(),
      counters: new Map(),
      builderTail: this.#builders.length,
    };

    for (const [qid, q] of this.#queries) {
      if (!q.alive) continue;
      const parentMask = parent.masks.get(qid) ?? 0;
      if (parentMask === 0) continue;

      const childMask = this.#advance(q, parentMask, parent.counters, element);
      if (childMask !== 0) frame.masks.set(qid, childMask);

      if (childMask & q.finalBit) {
        this.#builders.push({ query: q, match: buildMatch(q, element, this.depth + 1) });
      }
    }

    this.#frames.push(frame);
  }

  text(value: string): void {
    for (const b of this.#builders) b.match.text += value;
  }

  /**
   * Close the current element. Matches completed on this element are handed
   * to their query queues. With the 'wait' overflow policy the returned
   * promise applies that query's backpressure to the producer; other queries
   * have already been enqueued independently.
   */
  async endElement(): Promise<void> {
    if (this.#frames.length === 1) return;
    const frame = this.#frames.pop()!;
    const finished = this.#builders.splice(frame.builderTail);

    const settled = await Promise.allSettled(
      finished.map(async (b) => {
        const accepted = await b.query.queue.push(b.match);
        if (!accepted) this.#cancel(b.query.id);
      }),
    );
    // Rejections from push are contained per query; a failed/cancelled queue
    // simply makes the query dead. Surface nothing that could kill siblings.
    void settled;
  }

  /** End the traversal: buffered matches are drained, then iterators close. */
  async finish(): Promise<void> {
    for (const q of this.#queries.values()) {
      q.alive = false;
      q.queue.close();
    }
    // Traversal is over: release every retained NFA state and any builder
    // that never received an endElement (malformed/abrupt streams).
    for (const frame of this.#frames) frame.masks.clear();
    this.#builders = [];
  }

  /** Feed a pre-parsed event. Resolves once end-of-element delivery settles. */
  async feed(event: XmlEvent): Promise<void> {
    if (event.type === 'start') this.startElement(event.element);
    else if (event.type === 'text') this.text(event.value);
    else await this.endElement();
  }

  // --- internals ----------------------------------------------------------

  #advance(
    q: InternalQuery,
    parentMask: number,
    parentCounters: Map<number, number>,
    element: ElementInfo,
  ): number {
    // Descendant states linger into the child regardless of its name.
    let mask = parentMask & q.lingerMask;

    // States that may match the new element as their next step.
    let candidates = parentMask & ~q.lingerMask & (q.finalBit - 1);
    // Lingering descendant states are also candidates on this element.
    candidates |= parentMask & q.lingerMask & (q.finalBit - 1);

    const steps = q.path.steps;
    while (candidates !== 0) {
      const k = countTrailingZeros(candidates);
      candidates &= candidates - 1;
      const step = steps[k];
      if (!nameMatches(step.name, element)) continue;
      if (this.#evalStep(q, k, step, parentCounters, element)) {
        mask |= 1 << (k + 1);
      }
    }
    return mask;
  }

  /**
   * Evaluate a step's predicate chain against one element. Predicates are
   * XPath-style filters: a positional predicate assigns a position inside the
   * sequence of same-named siblings that passed every preceding predicate,
   * and its counter advances even if a *later* predicate rejects the
   * element. The counter is materialised only on the parent frame and
   * dropped with it.
   */
  #evalStep(
    q: InternalQuery,
    stepIndex: number,
    step: CompiledStep,
    counters: Map<number, number>,
    element: ElementInfo,
  ): boolean {
    for (let j = 0; j < step.predicates.length; j += 1) {
      const p = step.predicates[j];
      if (p.kind === 'position') {
        const key = (q.id << 16) | (stepIndex << STEP_BITS) | j;
        const position = (counters.get(key) ?? 0) + 1;
        counters.set(key, position);
        if (position !== p.position) return false;
        continue;
      }
      const found = element.attributes.find(
        (a) => a.uri === p.attr.uri && a.local === p.attr.local,
      );
      if (p.op === 'exists') {
        if (!found) return false;
      } else if (!found) {
        return false; // missing attribute fails both '=' and '!='
      } else {
        const equal = found.value === p.value;
        if (p.op === '=' ? !equal : equal) return false;
      }
    }
    return true;
  }

  #cancel(qid: number): void {
    const q = this.#queries.get(qid);
    if (!q || !q.alive) return;
    q.alive = false;
    q.queue.cancel();
    // Drop this query's state from every open frame and its open builders.
    for (const frame of this.#frames) frame.masks.delete(qid);
    this.#builders = this.#builders.filter((b) => b.query.id !== qid);
  }
}

function buildMatch(q: InternalQuery, element: ElementInfo, depth: number): Match {
  const attributes = element.attributes;
  const match: Match = {
    path: q.path.source,
    depth,
    uri: element.uri,
    local: element.local,
    prefix: element.prefix,
    attributes,
    text: '',
    attr(uri, local) {
      const a = attributes.find((x) => x.uri === uri && x.local === local);
      return a ? a.value : null;
    },
  };
  return match;
}

function nameMatches(test: NameTest, element: ElementInfo): boolean {
  if (!test.anyNamespace && test.uri !== element.uri) return false;
  if (test.local !== '*' && test.local !== element.local) return false;
  return true;
}

function popCount(n: number): number {
  let c = 0;
  while (n !== 0) {
    n &= n - 1;
    c += 1;
  }
  return c;
}

function countTrailingZeros(n: number): number {
  const bit = n & -n;
  return Math.log2(bit);
}
