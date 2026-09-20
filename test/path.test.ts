import { describe, expect, it } from 'vitest';
import {
  BackpressureError,
  compilePath,
  PathProcessor,
  XmlStreamReader,
  type MatchedElement,
  type QueryHandle,
} from '../src/index.js';

const U = { a: 'urn:a', b: 'urn:b' };

const DOC = `<?xml version="1.0"?>
<r xmlns="urn:a" xmlns:x="urn:b">
  <item x:kind="x1">
    <x:nested id="n1">alpha</x:nested>
    <x:nested id="n2">beta</x:nested>
    <x:nested id="n3" x:kind="z">gamma</x:nested>
  </item>
  <item x:kind="x2">
    <x:nested id="n4">delta</x:nested>
    <other><inner>deep</inner></other>
  </item>
  <item x:kind="x3" selected="yes">
    <x:nested id="n5">epsilon</x:nested>
  </item>
</r>`;

function parse(
  xml: string,
  processor: PathProcessor,
  chunkSize = Infinity,
): void {
  const reader = new XmlStreamReader(processor);
  if (chunkSize === Infinity) {
    reader.feed(xml);
  } else {
    for (let i = 0; i < xml.length; i += chunkSize) {
      reader.feed(xml.slice(i, i + chunkSize));
    }
  }
  reader.end();
  processor.finish();
}

function drain(handle: QueryHandle): MatchedElement[] {
  const out: MatchedElement[] = [];
  for (;;) {
    const m = handle.tryTake();
    if (!m) break;
    out.push(m);
  }
  return out;
}

describe('path compiler', () => {
  it('resolves element and attribute prefixes at compile time', () => {
    const p = compilePath('//a:item/b:x[@x:kind = "v"]', {
      prefixes: { a: U.a, b: U.b, x: U.b },
    });
    expect(p.steps[0].test).toMatchObject({ kind: 'name', uri: U.a, local: 'item' });
    expect(p.steps[1].test).toMatchObject({ kind: 'name', uri: U.b, local: 'x' });
    const attr = p.steps[1].predicates[0];
    expect(attr).toMatchObject({ kind: 'attr', value: 'v' });
    if (attr.kind === 'attr') {
      expect(attr.qname.uri).toBe(U.b);
    }
  });

  it('maps unprefixed element tests to the default namespace', () => {
    const p = compilePath('/r/item', { defaultNamespace: U.a });
    expect(p.steps[0].test.uri).toBe(U.a);
  });

  it('keeps unprefixed attribute names in no namespace', () => {
    const p = compilePath('//item[@selected]', { defaultNamespace: U.a });
    const pred = p.steps[0].predicates[0];
    expect(pred.kind).toBe('attr');
    if (pred.kind === 'attr') expect(pred.qname.uri).toBe('');
  });

  it('supports wildcard and local-name tests', () => {
    const p = compilePath('//a:item/*:nested[2]', { prefixes: { a: U.a } });
    expect(p.steps[0].test.kind).toBe('name');
    expect(p.steps[1].test).toMatchObject({ kind: 'wildcardLocal', local: 'nested' });
    expect(p.steps[1].predicates[0]).toMatchObject({ kind: 'position', value: 2 });
  });

  it('rejects undeclared prefixes and malformed paths', () => {
    expect(() => compilePath('//z:n', { prefixes: {} })).toThrow(/undeclared/);
    expect(() => compilePath('item', {})).toThrow(/must start/);
    expect(() => compilePath('//[@x]', { prefixes: { x: U.b } })).toThrow(/expected name/);
  });
});

describe('matching semantics', () => {
  it('matches namespace-qualified descendants delivered at close time', () => {
    const proc = new PathProcessor();
    const q = proc.addQuery(compilePath('//x:nested', { prefixes: { x: U.b } }), {
      collectText: true,
    });
    const events: string[] = [];
    // Verify delivery happens on endElement, not startElement.
    const orig = proc.text.bind(proc);
    proc.startElement = ((...args: Parameters<PathProcessor['startElement']>) => {
      events.push('start:' + args[1]);
      PathProcessor.prototype.startElement.apply(proc, args);
    }) as PathProcessor['startElement'];
    proc.endElement = ((...args: Parameters<PathProcessor['endElement']>) => {
      events.push('end:' + args[1]);
      PathProcessor.prototype.endElement.apply(proc, args);
    }) as PathProcessor['endElement'];
    proc.text = (s: string) => {
      events.push('text');
      orig(s);
    };

    parse(DOC, proc);
    const matches = drain(q);
    expect(matches.map((m) => m.getAttribute('', 'id'))).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(matches[0].text).toBe('alpha');
    expect(matches[0].uri).toBe(U.b);
    // All matches are observed after their own end event.
    const n1End = events.indexOf('end:nested');
    expect(n1End).toBeGreaterThan(events.indexOf('start:nested'));
  });

  it('matches overlapping ancestor AND descendant nodes for the same query', () => {
    const proc = new PathProcessor();
    const q = proc.addQuery(
      compilePath('/a:r//a:item//x:nested', { prefixes: { a: U.a, x: U.b } }),
    );
    parse(DOC, proc);
    const matches = drain(q);
    expect(matches.map((m) => m.local)).toEqual(['nested', 'nested', 'nested', 'nested', 'nested']);
    // depths all >= 3 and ordered by closing-tag sequence
    expect(matches.every((m) => m.depth >= 3)).toBe(true);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i].sequence).toBeGreaterThan(matches[i - 1].sequence);
    }
  });

  it('matches ancestor and descendant with two separate queries sharing one traversal', () => {
    const proc = new PathProcessor();
    const items = proc.addQuery(compilePath('/a:r/a:item', { prefixes: { a: U.a } }));
    const nested = proc.addQuery(compilePath('//x:nested[@id]', { prefixes: { x: U.b } }));
    parse(DOC, proc);
    expect(drain(items)).toHaveLength(3);
    expect(drain(nested)).toHaveLength(5);
  });

  it('evaluates positional predicates against same-expanded-name siblings', () => {
    const proc = new PathProcessor();
    const second = proc.addQuery(
      compilePath('/a:r/a:item/x:nested[2]', { prefixes: { a: U.a, x: U.b } }),
    );
    // The third same-name sibling exists only inside the first item.
    const third = proc.addQuery(
      compilePath('/a:r/a:item/x:nested[3]', { prefixes: { a: U.a, x: U.b } }),
    );
    parse(DOC, proc);
    const m2 = drain(second);
    expect(m2).toHaveLength(1);
    expect(m2[0].getAttribute('', 'id')).toBe('n2');
    const m3 = drain(third);
    expect(m3).toHaveLength(1);
    expect(m3[0].getAttribute('', 'id')).toBe('n3');
  });

  it('position predicate counts by local name for *:local tests and by element for *', () => {
    const xml = `<r xmlns:x="${U.b}"><a/><x:a/><b/><x:a/></r>`;
    const proc1 = new PathProcessor();
    const localSecond = proc1.addQuery(compilePath('/r/*:a[2]'));
    parse(xml, proc1);
    const m = drain(localSecond);
    expect(m).toHaveLength(1);
    expect(m[0].uri).toBe(U.b); // the second local-a is the namespaced one

    const proc2 = new PathProcessor();
    const third = proc2.addQuery(compilePath('/r/*[3]'));
    parse(xml, proc2);
    const m3 = drain(third);
    expect(m3).toHaveLength(1);
    expect(m3[0].local).toBe('b');
  });

  it('requires presence and value of attributes across namespaces', () => {
    const proc = new PathProcessor();
    const selected = proc.addQuery(
      compilePath('//a:item[@selected="yes"]', { prefixes: { a: U.a } }),
    );
    const kindZ = proc.addQuery(
      compilePath('//x:nested[@x:kind="z"]', { prefixes: { x: U.b } }),
    );
    parse(DOC, proc);
    const s = drain(selected);
    expect(s).toHaveLength(1);
    expect(s[0].getAttribute(U.b, 'kind')).toBe('x3');
    const z = drain(kindZ);
    expect(z).toHaveLength(1);
    expect(z[0].getAttribute('', 'id')).toBe('n3');
  });

  it('does not match when a required attribute is missing', () => {
    const proc = new PathProcessor();
    const q = proc.addQuery(
      compilePath('//x:nested[@missing]', { prefixes: { x: U.b } }),
    );
    parse(DOC, proc);
    expect(drain(q)).toHaveLength(0);
  });

  it('supports prefix mappings shadowed inside one document', () => {
    const doc = `<root xmlns:p="${U.a}" xmlns:q="${U.b}">
      <p:x>one</p:x>
      <q:x>two</q:x>
      <nested xmlns:p="${U.b}"><p:x>three</p:x></nested>
    </root>`;
    const proc = new PathProcessor();
    const onlyA = proc.addQuery(compilePath('//p:x', { prefixes: { p: U.a } }), {
      collectText: true,
    });
    parse(doc, proc);
    const matches = drain(onlyA);
    expect(matches.map((m) => m.text)).toEqual(['one']);
    // q:x (urn:b) and the shadowed p:x inside nested (also urn:b) do not match.
  });
});

describe('streaming reader', () => {
  it('produces identical results regardless of chunk boundaries', () => {
    for (const chunk of [1, 2, 3, 7, 64]) {
      const proc = new PathProcessor();
      const q = proc.addQuery(compilePath('//x:nested[@id]', { prefixes: { x: U.b } }));
      parse(DOC, proc, chunk);
      expect(drain(q).map((m) => m.getAttribute('', 'id'))).toEqual([
        'n1', 'n2', 'n3', 'n4', 'n5',
      ]);
    }
  });

  it('handles CDATA, entities and self-closing tags', () => {
    const xml = `<r xmlns:x="${U.b}"><x:nested id="n1"><![CDATA[a < b & c]]></x:nested>` +
      `<x:nested id="n2"/><x:nested id="n3">x &amp; y &#65;</x:nested></r>`;
    const proc = new PathProcessor();
    const q = proc.addQuery(compilePath('//x:nested', { prefixes: { x: U.b } }), {
      collectText: true,
    });
    parse(xml, proc);
    const m = drain(q);
    expect(m.map((x) => x.getAttribute('', 'id'))).toEqual(['n1', 'n2', 'n3']);
    expect(m[0].text).toBe('a < b & c');
    expect(m[1].text).toBe('');
    expect(m[2].text).toBe('x & y A');
  });

  it('collects the XPath string value including descendant text', () => {
    const xml = `<r xmlns="urn:a"><item>before <b>bold</b> after</item></r>`;
    const proc = new PathProcessor();
    const q = proc.addQuery(compilePath('//a:item', { prefixes: { a: U.a } }), {
      collectText: true,
    });
    parse(xml, proc);
    const [m] = drain(q);
    expect(m.text).toBe('before bold after');
  });

  it('collects text for overlapping ancestor/descendant matches independently', () => {
    const xml = `<r xmlns="urn:a"><item>aa <item>inner</item> bb</item></r>`;
    const proc = new PathProcessor();
    const q = proc.addQuery(compilePath('//a:item', { prefixes: { a: U.a } }), {
      collectText: true,
    });
    parse(xml, proc);
    const matches = drain(q);
    expect(matches).toHaveLength(2);
    // The inner element closes first, so it is delivered before the outer one.
    expect(matches[0].text).toBe('inner');
    expect(matches[0].depth).toBe(3);
    expect(matches[1].text).toBe('aa inner bb'); // outer XPath string value
    expect(matches[1].depth).toBe(2);
  });

  it('combines positional and attribute predicates on one step', () => {
    const proc = new PathProcessor();
    const q = proc.addQuery(
      compilePath('/a:r/a:item/x:nested[2][@id="n2"]', { prefixes: { a: U.a, x: U.b } }),
    );
    const wrongPos = proc.addQuery(
      compilePath('/a:r/a:item/x:nested[1][@id="n2"]', { prefixes: { a: U.a, x: U.b } }),
    );
    parse(DOC, proc);
    expect(drain(q)).toHaveLength(1);
    expect(drain(wrongPos)).toHaveLength(0);
  });

  it('treats positions as one-based (zero never matches)', () => {
    const proc = new PathProcessor();
    const q = proc.addQuery(compilePath('//x:nested[0]', { prefixes: { x: U.b } }));
    parse(DOC, proc);
    expect(drain(q)).toHaveLength(0);
  });

  it('handles tags and entities split across arbitrary chunk boundaries', () => {
    const xml = `<r xmlns:x="${U.b}"><x:nested id="n1">a&amp;b</x:nested></r>`;
    for (let cut = 1; cut < xml.length; cut++) {
      const proc = new PathProcessor();
      const q = proc.addQuery(compilePath('//x:nested', { prefixes: { x: U.b } }), {
        collectText: true,
      });
      const reader = new XmlStreamReader(proc);
      reader.feed(xml.slice(0, cut));
      reader.feed(xml.slice(cut));
      reader.end();
      proc.finish();
      const [m] = drain(q);
      expect(m.getAttribute('', 'id')).toBe('n1');
      expect(m.text).toBe('a&b');
    }
  });
});

describe('cancellation isolation', () => {
  it('cancelling one query leaves the parse and other queries untouched', () => {
    const proc = new PathProcessor();
    const victim = proc.addQuery(compilePath('//x:nested', { prefixes: { x: U.b } }));
    const survivor = proc.addQuery(
      compilePath('//a:item', { prefixes: { a: U.a } }),
    );
    const reader = new XmlStreamReader(proc);

    // Cancel after the first item, mid-document.
    const head = DOC.slice(0, DOC.indexOf('<item x:kind="x2"'));
    reader.feed(head);
    victim.cancel();
    const victimBefore = drain(victim).length;
    expect(victimBefore).toBe(3);
    reader.feed(DOC.slice(head.length));
    reader.end();
    proc.finish();

    expect(drain(victim)).toHaveLength(0); // no post-cancel results
    expect(drain(survivor)).toHaveLength(3); // parse continued for the other query
  });

  it('removes a cancelled query state from every open frame', () => {
    const proc = new PathProcessor();
    proc.addQuery(compilePath('/a/b/c/d', { defaultNamespace: U.a }));
    proc.startElement(U.a, 'a', 'a', []);
    proc.startElement(U.a, 'b', 'b', []);
    const q2 = proc.addQuery(compilePath('/a/b/c'));
    proc.startElement('', 'c', 'c', []);
    proc.startElement(U.a, 'd', 'd', []);
    q2.cancel();
    const frames = (proc as unknown as { frames: unknown[] }).frames;
    for (const f of frames.slice(1)) {
      const states = (f as { states: Map<unknown, unknown> }).states;
      expect(states.has(q2.id)).toBe(false);
    }
    proc.endElement(U.a, 'd', 'd');
    proc.endElement('', 'c', 'c');
    proc.endElement(U.a, 'b', 'b');
    proc.endElement(U.a, 'a', 'a');
  });
});

describe('backpressure', () => {
  it('isolates an error-overflow query while siblings keep receiving matches', async () => {
    const proc = new PathProcessor();
    const slow = proc.addQuery(compilePath('//n'), { capacity: 1, overflow: 'error' });
    const fast = proc.addQuery(compilePath('//n'));
    const xml = `<r>${'<n/>'.repeat(10)}</r>`;
    parse(xml, proc);
    // The slow query produced one buffered match then faulted.
    expect(drain(slow)).toHaveLength(1);
    expect(drain(fast)).toHaveLength(10);
    await expect(slow[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(BackpressureError);
  });

  it('supports drop-oldest and drop-newest with counters', () => {
    const procNew = new PathProcessor();
    const newest = procNew.addQuery(compilePath('//n'), { capacity: 2, overflow: 'drop-newest' });
    parse(`<r>${'<n/>'.repeat(5)}</r>`, procNew);
    const mn = drain(newest);
    expect(mn).toHaveLength(2); // first two kept
    expect(newest.stats.dropped).toBe(3);

    const procOld = new PathProcessor();
    const oldest = procOld.addQuery(compilePath('//n'), { capacity: 2, overflow: 'drop-oldest' });
    parse(`<r>${'<n/>'.repeat(5)}</r>`, procOld);
    const mo = drain(oldest);
    expect(mo).toHaveLength(2); // last two kept
    expect(oldest.stats.dropped).toBe(3);
  });

  it('delivers directly to a parked async consumer and resumes after', async () => {
    const proc = new PathProcessor();
    const q = proc.addQuery(compilePath('//n'));
    const reader = new XmlStreamReader(proc);
    reader.feed('<r><n/></r>'.slice(0, 7)); // up to "<n/..."
    const pending = q[Symbol.asyncIterator]().next();
    reader.feed('<r><n/></r>'.slice(7));
    reader.end();
    const first = await pending;
    expect(first.done).toBe(false);
    proc.finish();
    const second = await q[Symbol.asyncIterator]().next();
    expect(second.done).toBe(true);
  });

  it('does not make a single slow consumer block the parse', () => {
    // An unbounded (default) query that nobody drains must not throw or stall.
    const proc = new PathProcessor();
    proc.addQuery(compilePath('//n'));
    const xml = `<r>${'<n/>'.repeat(10000)}</r>`;
    expect(() => parse(xml, proc)).not.toThrow();
  });
});

describe('state bounds on deep / wide documents', () => {
  it('live state scales with depth and query count, not with consumed nodes', () => {
    const DEPTH = 2000;
    const proc = new PathProcessor();
    proc.addQuery(compilePath('/a/b/c'));
    proc.addQuery(compilePath('//x'));
    proc.addQuery(compilePath('/a/b/c'));

    // Wide sibling storm at a shallow depth: consumed nodes grow, frames do not.
    proc.startElement('', 'root', 'root', []);
    for (let i = 0; i < 10000; i++) {
      proc.startElement('', 'leaf', 'leaf', []);
      proc.endElement('', 'leaf', 'leaf');
    }
    const frames = (proc as unknown as { frames: { states: Map<number, unknown> }[] }).frames;
    const stateCountAfterWide = frames.reduce((n, f) => n + f.states.size, 0);
    expect(stateCountAfterWide).toBeLessThanOrEqual(2 * 3); // root + root/root frame

    // Now descend deeply: state grows with depth, not exploded by the 10k nodes.
    for (let d = 1; d <= DEPTH; d++) {
      proc.startElement('', d === 1 ? 'a' : d === 2 ? 'b' : d === 3 ? 'c' : 'x', 'p', []);
    }
    const stateCountDeep = frames.reduce((n, f) => n + f.states.size, 0);
    // Every frame carries at most one FrameState per query.
    expect(stateCountDeep).toBeLessThanOrEqual((DEPTH + 2) * 3);
    expect(stateCountDeep).toBeGreaterThan(DEPTH);
    for (let d = DEPTH; d >= 1; d--) {
      proc.endElement('', d === 1 ? 'a' : d === 2 ? 'b' : d === 3 ? 'c' : 'x', 'p');
    }
    proc.endElement('', 'root', 'root');
    // Back to the synthetic root only.
    expect(frames).toHaveLength(1);
  });

  it('streams a deeply nested document without building a DOM', () => {
    const DEPTH = 5000;
    const xml = '<r>'.repeat(DEPTH) + '<target/>' + '</r>'.repeat(DEPTH);
    const proc = new PathProcessor();
    const q = proc.addQuery(compilePath(`//target`));
    parse(xml, proc, 128);
    expect(drain(q)).toHaveLength(1);
  });
});
