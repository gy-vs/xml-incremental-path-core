/**
 * Incremental multi-query path matching engine.
 *
 * The parser drives three SAX-style events:
 *   startElement / text / endElement
 *
 * For every query a frame keeps two small integer sets:
 *   - `active`: indices of path steps whose element is currently OPEN on the
 *     chain ending at this frame;
 *   - `seek`:   indices of descendant-axis steps still being searched for
 *     inside this frame.
 *
 * State is created on element entry and discarded wholesale on element exit,
 * so live state is O(depth x queries x path length) and never grows with the
 * number of nodes already consumed.
 *
 * Each query owns a private bounded result queue; overflow and cancellation
 * tear down only that query's threads — the parse and every other query keep
 * running.
 */

import type { CompiledPath, NodeTest, PositionClass } from './path.js';

export interface ExpandedAttribute {
  uri: string;
  local: string;
  value: string;
}

/** NUL byte used so a composite key can never collide with a real name. */
const NUL = String.fromCharCode(0);
/** Composite key used by the internal attribute maps: namespace NUL local. */
export const attrKey = (uri: string, local: string): string => `${uri}${NUL}${local}`;

const splitAttrKey = (key: string): { uri: string; local: string } => {
  const sep = key.indexOf(NUL);
  return { uri: key.slice(0, sep), local: key.slice(sep + 1) };
};

export type OverflowStrategy = 'error' | 'drop-oldest' | 'drop-newest';

export interface QueryOptions {
  /** Maximum buffered, undelivered matches. Default: unbounded. */
  capacity?: number;
  /** What happens when a match is produced at full capacity. */
  overflow?: OverflowStrategy;
  /** Accumulate the matched element's text content (freed on delivery). */
  collectText?: boolean;
}

export interface QueryStats {
  /** Matches handed to the queue. */
  enqueued: number;
  /** Matches discarded by an overflow policy. */
  dropped: number;
}

/** Snapshot delivered when the matched element's closing tag is consumed. */
export class MatchedElement {
  constructor(
    readonly queryId: number,
    readonly path: CompiledPath,
    readonly uri: string,
    readonly local: string,
    readonly depth: number,
    /** Document-wide order in which the closing tag was seen. */
    readonly sequence: number,
    private readonly attrs: ReadonlyMap<string, string>,
    readonly text: string | undefined,
  ) {}

  getAttribute(uri: string, local: string): string | undefined {
    return this.attrs.get(attrKey(uri, local));
  }

  /** Expanded attributes as `{uri, local, value}` triples (no xmlns nodes). */
  attributeList(): ReadonlyArray<ExpandedAttribute> {
    const out: ExpandedAttribute[] = [];
    for (const [key, value] of this.attrs) {
      const { uri, local } = splitAttrKey(key);
      out.push({ uri, local, value });
    }
    return out;
  }
}

export class BackpressureError extends Error {
  constructor(readonly queryId: number, readonly capacity: number) {
    super(`query ${queryId} result queue overflowed its capacity of ${capacity}`);
    this.name = 'BackpressureError';
  }
}

type IteratorCallback = (result: IteratorResult<MatchedElement>) => void;

/** Per-query promise/FIFO queue. Owned solely by its query. */
class ResultStream {
  private buffered: MatchedElement[] = [];
  private waiters: IteratorCallback[] = [];
  private error: Error | undefined;
  private closed = false;

  constructor(
    private readonly capacity: number,
    private readonly overflow: OverflowStrategy,
  ) {}

  /**
   * Push a match.
   *  - 'ok':      buffered or handed straight to a parked consumer
   *  - 'dropped': discarded (or replaced) by an overflow policy
   *  - 'failed':  overflow strategy "error" faulted the stream
   */
  enqueue(match: MatchedElement): 'ok' | 'dropped' | 'failed' {
    if (this.closed) return 'failed';
    if (this.waiters.length > 0) {
      this.waiters.shift()!({ value: match, done: false });
      return 'ok';
    }
    if (this.buffered.length >= this.capacity) {
      switch (this.overflow) {
        case 'drop-newest':
          return 'dropped';
        case 'drop-oldest':
          this.buffered.shift();
          this.buffered.push(match);
          return 'dropped';
        case 'error':
          this.error = new BackpressureError(match.queryId, this.capacity);
          this.closed = true;
          return 'failed';
      }
    }
    this.buffered.push(match);
    return 'ok';
  }

  tryTake(): MatchedElement | undefined {
    return this.buffered.shift();
  }

  next(): Promise<IteratorResult<MatchedElement>> {
    const value = this.buffered.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<MatchedElement> {
    return { next: () => this.next() };
  }

  /** Stop delivery: queued results may still be drained, then `done`. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve({ value: undefined, done: true });
  }
}

export interface QueryHandle extends AsyncIterable<MatchedElement> {
  readonly id: number;
  readonly path: CompiledPath;
  readonly stats: QueryStats;
  /** Cancel this query only. The underlying parse and other queries continue. */
  cancel(): void;
  /** Non-blocking fetch; undefined when nothing is buffered yet. */
  tryTake(): MatchedElement | undefined;
  [Symbol.asyncIterator](): AsyncIterator<MatchedElement>;
}

interface FrameState {
  active: Set<number>;
  seek: Set<number>;
  /**
   * Open matched-terminal ancestors on this frame, innermost last. Present
   * only for queries with text capture. The state at the tip frame receives
   * character data, yielding the XPath string value (including descendants).
   */
  collectors: TextCollector[];
}

interface Frame {
  uri: string;
  local: string;
  depth: number;
  attrs: Map<string, string>;
  /**
   * Same-name sibling counters, stored on the PARENT frame. Keys:
   *   `n${NUL}<uri>${NUL}<local>` for expanded-name classes,
   *   `l${NUL}<local>`             for local-name classes,
   *   `*`                           for the any-element class.
   * Only classes some compiled step could need at this element are created.
   */
  counts: Map<string, number>;
  states: Map<number, FrameState>;
}

interface TextCollector {
  parts: string[];
}

interface Runtime {
  id: number;
  path: CompiledPath;
  collectText: boolean;
  stream: ResultStream;
  stats: QueryStats;
}

/** SAX sink the streaming reader is pointed at. */
export interface XmlHandler {
  startElement(uri: string, local: string, prefix: string, attributes: readonly ExpandedAttribute[]): void;
  endElement(uri: string, local: string, prefix: string): void;
  text(content: string): void;
}

const makeRootFrame = (): Frame => ({
  uri: '',
  local: '',
  depth: 0,
  attrs: new Map(),
  counts: new Map(),
  states: new Map<number, FrameState>(),
});

const EMPTY_SET: ReadonlySet<number> = new Set<number>();

export class PathProcessor implements XmlHandler {
  private readonly frames: Frame[] = [makeRootFrame()];
  private readonly runtimes = new Map<number, Runtime>();
  private nextId = 1;
  private sequence = 0;

  constructor(private readonly defaultCapacity = Infinity) {}

  /**
   * Register a compiled query. When called before the document is fed it is
   * anchored at the document node; called mid-stream it anchors at the
   * currently open element instead.
   */
  addQuery(path: CompiledPath, options: QueryOptions = {}): QueryHandle {
    const id = this.nextId++;
    const capacity = options.capacity ?? this.defaultCapacity;
    const stream = new ResultStream(capacity, options.overflow ?? 'error');
    const runtime: Runtime = {
      id,
      path,
      collectText: options.collectText ?? false,
      stream,
      stats: { enqueued: 0, dropped: 0 },
    };
    this.runtimes.set(id, runtime);
    // Seed the virtual "document/context node" state (-1) at the current tip.
    this.frames.at(-1)!.states.set(id, {
      active: new Set<number>([-1]),
      seek: new Set<number>(),
      collectors: [],
    });

    const processor = this;
    return {
      id,
      path,
      stats: runtime.stats,
      cancel: () => processor.cancel(id),
      tryTake: (): MatchedElement | undefined => stream.tryTake(),
      [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    };
  }

  /** Mark every live query's stream finished after the document closes. */
  finish(): void {
    for (const runtime of this.runtimes.values()) runtime.stream.close();
  }

  cancel(id: number): void {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    this.removeRuntime(runtime);
    runtime.stream.close();
  }

  startElement(uri: string, local: string, _prefix: string, attributes: readonly ExpandedAttribute[]): void {
    const parent = this.frames.at(-1)!;

    const attrs = new Map<string, string>();
    for (const a of attributes) attrs.set(attrKey(a.uri, a.local), a.value);

    // Positional predicates count preceding same-class siblings. A name-class
    // step only counts when this element shares its expanded name, a
    // local-class step on a shared local name, a wildcard step on any element.
    const { needName, needLocal, needAny } = this.neededCountClasses(uri, local);
    const namePos = needName ? this.bump(parent.counts, `n${NUL}${uri}${NUL}${local}`) : undefined;
    const localPos = needLocal ? this.bump(parent.counts, `l${NUL}${local}`) : undefined;
    const anyPos = needAny ? this.bump(parent.counts, '*') : undefined;

    const child: Frame = {
      uri,
      local,
      depth: parent.depth + 1,
      attrs,
      counts: new Map(),
      states: new Map(),
    };

    for (const [id, runtime] of this.runtimes) {
      const parentState = parent.states.get(id);
      const parentActive = parentState?.active ?? EMPTY_SET;
      const parentSeek = parentState?.seek ?? EMPTY_SET;
      const steps = runtime.path.steps;
      const last = steps.length - 1;

      const seek = new Set<number>();
      for (const stepIndex of parentSeek) seek.add(stepIndex);
      // An open predecessor with a descendant-axis successor starts a search.
      for (const pred of parentActive) {
        const k = pred + 1;
        if (k <= last && steps[k].axis === 'descendant') seek.add(k);
      }

      const active = new Set<number>();
      // Direct child advancement.
      for (const pred of parentActive) {
        const k = pred + 1;
        if (
          k <= last &&
          steps[k].axis === 'child' &&
          this.matches(steps[k], uri, local, attrs, namePos, localPos, anyPos)
        ) {
          active.add(k);
        }
      }
      // Descendant searches may land on this very element.
      for (const k of seek) {
        if (this.matches(steps[k], uri, local, attrs, namePos, localPos, anyPos)) active.add(k);
      }

      if (active.size > 0 || seek.size > 0) {
        // Descendants inherit the open terminal collectors of their ancestors.
        const collectors =
          runtime.collectText && parentState ? parentState.collectors.slice() : [];
        if (runtime.collectText && active.has(last)) collectors.push({ parts: [] });
        child.states.set(id, { active, seek, collectors });
      }
    }

    this.frames.push(child);
  }

  endElement(uri: string, local: string, _prefix: string): void {
    if (this.frames.length <= 1) throw new Error('unbalanced endElement event');
    const frame = this.frames.pop()!;
    if (frame.uri !== uri || frame.local !== local) {
      throw new Error(`mismatched close tag: expected ${frame.uri}:${frame.local}, got ${uri}:${local}`);
    }

    for (const [id, runtime] of this.runtimes) {
      const state = frame.states.get(id);
      if (!state) continue;
      const last = runtime.path.steps.length - 1;
      if (!state.active.has(last)) continue;

      // The innermost open collector on this chain is this element's own.
      const own = state.collectors.at(-1);
      const text = own ? own.parts.join('') : undefined;
      const match = new MatchedElement(
        id,
        runtime.path,
        frame.uri,
        frame.local,
        frame.depth,
        ++this.sequence,
        frame.attrs,
        text,
      );
      this.deliver(runtime, match);
    }
    // Dropping the frame frees every candidate state it carried.
  }

  text(content: string): void {
    if (content === '') return;
    // Character data belongs to every collecting terminal open at the tip.
    const tip = this.frames.at(-1)!;
    for (const [id, runtime] of this.runtimes) {
      if (!runtime.collectText) continue;
      const collectors = tip.states.get(id)?.collectors;
      if (collectors && collectors.length > 0) {
        for (const collector of collectors) collector.parts.push(content);
      }
    }
  }

  /** Union of positional-predicate count classes relevant to this element. */
  private neededCountClasses(uri: string, local: string): {
    needName: boolean;
    needLocal: boolean;
    needAny: boolean;
  } {
    let needName = false;
    let needLocal = false;
    let needAny = false;
    for (const runtime of this.runtimes.values()) {
      for (const step of runtime.path.steps) {
        const cls: PositionClass | null = step.posClass;
        if (cls === null) continue;
        if (cls === 'wildcard') {
          needAny = true;
        } else if (cls === 'local') {
          if (step.test.kind === 'wildcardLocal' && step.test.local === local) needLocal = true;
        } else if (this.testMatches(step.test, uri, local)) {
          needName = true;
        }
      }
    }
    return { needName, needLocal, needAny };
  }

  private bump(map: Map<string, number>, key: string): number {
    const next = (map.get(key) ?? 0) + 1;
    map.set(key, next);
    return next;
  }

  /** Remove every trace of a runtime from the live traversal state. */
  private removeRuntime(runtime: Runtime): void {
    this.runtimes.delete(runtime.id);
    for (const frame of this.frames) frame.states.delete(runtime.id);
  }

  private deliver(runtime: Runtime, match: MatchedElement): void {
    const outcome = runtime.stream.enqueue(match);
    if (outcome === 'ok') {
      runtime.stats.enqueued++;
      return;
    }
    if (outcome === 'dropped') {
      runtime.stats.dropped++;
      return;
    }
    // 'error' overflow: isolate this query; the parse and other queries continue.
    this.removeRuntime(runtime);
  }

  private matches(
    step: CompiledPath['steps'][number],
    uri: string,
    local: string,
    attrs: Map<string, string>,
    namePos: number | undefined,
    localPos: number | undefined,
    anyPos: number | undefined,
  ): boolean {
    if (!this.testMatches(step.test, uri, local)) return false;
    for (const predicate of step.predicates) {
      if (predicate.kind === 'position') {
        const pos =
          step.posClass === 'wildcard' ? anyPos : step.posClass === 'local' ? localPos : namePos;
        if (pos !== predicate.value) return false;
      } else {
        const actual = attrs.get(attrKey(predicate.qname.uri, predicate.qname.local));
        if (actual === undefined) return false;
        if (predicate.value !== undefined && actual !== predicate.value) return false;
      }
    }
    return true;
  }

  private testMatches(test: NodeTest, uri: string, local: string): boolean {
    switch (test.kind) {
      case 'wildcard':
        return true;
      case 'wildcardLocal':
        return test.local === local;
      case 'name':
        return test.uri === uri && test.local === local;
    }
  }
}
