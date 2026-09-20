import { describe, expect, it } from 'vitest';
import {
  StreamingPathSelector,
  run,
  scanXml,
  type Match,
  type Query,
  type XmlEvent,
} from '../src/index.js';

const NS = {
  '': 'urn:a',
  a: 'urn:a',
  b: 'urn:b',
};

async function drain(query: Query): Promise<Match[]> {
  const out: Match[] = [];
  for await (const m of query) out.push(m);
  return out;
}

async function traverse(selector: StreamingPathSelector, xml: string): Promise<void> {
  await run(selector, scanXml(xml));
}

describe('namespace-qualified matching', () => {
  const xml = `<root xmlns="urn:a" xmlns:b="urn:b">
    <item>one</item>
    <b:item>two</b:item>
    <item xmlns="">three</item>
  </root>`;

  it('matches the default namespace and distinguishes unprefixed no-namespace elements', async () => {
    const sel = new StreamingPathSelector();
    const inA = sel.register({ path: '//item', prefixes: { '': 'urn:a' } });
    const anyNs = sel.register({ path: '//*:item', prefixes: NS });
    const bOnly = sel.register({ path: '//b:item', prefixes: NS });
    await traverse(sel, xml);

    const a = await drain(inA);
    expect(a.map((m) => m.text)).toEqual(['one']);

    const all = await drain(anyNs);
    expect(all.map((m) => m.text)).toEqual(['one', 'two', 'three']);

    const b = await drain(bOnly);
    expect(b.map((m) => m.text)).toEqual(['two']);
  });

  it('unprefixed attributes do not inherit the default namespace', async () => {
    const doc = `<root xmlns="urn:a"><x kind="k"/></root>`;
    const sel = new StreamingPathSelector();
    // unprefixed attr lives in the empty namespace
    const q1 = sel.register({ path: '//*:x[@kind="k"]' });
    // a namespaced lookup must miss
    const q2 = sel.register({ path: '//*:x[@a:kind="k"]', prefixes: NS });
    await traverse(sel, doc);
    expect(await drain(q1)).toHaveLength(1);
    expect(await drain(q2)).toHaveLength(0);
  });
});

describe('overlapping ancestor and descendant matches', () => {
  const xml = `<a:a xmlns:a="urn:a">
    <a:b>
      <a:c>deep1</a:c>
      <a:c>deep2</a:c>
    </a:b>
    <a:b><a:c>deep3</a:c></a:b>
  </a:a>`;

  it('delivers ancestors, descendants and the same element via several paths', async () => {
    const sel = new StreamingPathSelector();
    const root = sel.register({ path: '/a:a', prefixes: NS });
    const bs = sel.register({ path: '/a:a/a:b', prefixes: NS });
    const anyC = sel.register({ path: '/a:a//a:c', prefixes: NS });
    const directC = sel.register({ path: '/a:a/a:b/a:c', prefixes: NS });
    const overlap = sel.register({ path: '//a:b//a:c', prefixes: NS });

    await traverse(sel, xml);

    expect(await drain(root)).toHaveLength(1);
    expect(await drain(bs)).toHaveLength(2);
    const allC = await drain(anyC);
    expect(allC.map((m) => m.text)).toEqual(['deep1', 'deep2', 'deep3']);
    const direct = await drain(directC);
    expect(direct.map((m) => m.text)).toEqual(['deep1', 'deep2', 'deep3']);
    const ov = await drain(overlap);
    expect(ov.map((m) => m.text)).toEqual(['deep1', 'deep2', 'deep3']);
  });

  it('matches nested elements of the same name repeatedly (lingering descendant state)', async () => {
    const doc = `<x xmlns="urn:d"><x><x>bottom</x></x></x>`;
    const sel = new StreamingPathSelector();
    const every = sel.register({ path: '//x', prefixes: { '': 'urn:d' } });
    await traverse(sel, doc);
    const ms = await drain(every);
    expect(ms).toHaveLength(3);
    expect(ms[2].text).toBe('bottom');
    // ancestor match contains the nested text of its subtree
    expect(ms[0].text).toContain('bottom');
  });
});

describe('positional predicates', () => {
  it('counts same-named siblings per parent, resetting across parents', async () => {
    const xml = `<root xmlns="urn:a">
      <item><v>1</v></item><item><v>2</v></item><item><v>3</v></item>
      <other><item><v>4</v></item></other>
    </root>`;
    const sel = new StreamingPathSelector();
    const second = sel.register({ path: '/root/item[2]', prefixes: { '': 'urn:a' } });
    const everySecondNested = sel.register({
      path: '//item[2]',
      prefixes: { '': 'urn:a' },
    });
    const wildcardPos = sel.register({ path: '/root/*[2]', prefixes: { '': 'urn:a' } });

    await traverse(sel, xml);
    const s = await drain(second);
    expect(s.map((m) => m.attr('', 'v'))).toEqual([null]);
    expect(s[0].text.trim()).toBe('2');
    // the item inside <other> is the 1st item there -> only one //item[2]
    expect(await drain(everySecondNested)).toHaveLength(1);
    // wildcard counts every element sibling regardless of name
    const w = await drain(wildcardPos);
    expect(w.map((m) => m.local)).toEqual(['item']);
    expect(w[0].text.trim()).toBe('2');
  });

  it('combines position with attribute predicates', async () => {
    const xml = `<root xmlns="urn:a">
      <item kind="x">1</item>
      <item kind="y">2</item>
      <item kind="x">3</item>
    </root>`;
    const sel = new StreamingPathSelector();
    const secondX = sel.register({
      path: '/root/item[@kind="x"][2]',
      prefixes: { '': 'urn:a' },
    });
    await traverse(sel, xml);
    const ms = await drain(secondX);
    expect(ms).toHaveLength(1);
    expect(ms[0].text.trim()).toBe('3');
  });
});

describe('missing attributes and namespaced attributes', () => {
  const xml = `<root xmlns="urn:a" xmlns:b="urn:b">
    <x id="1" b:tag="yes"/>
    <x id="2"/>
    <x b:tag="no"/>
  </root>`;

  it('exists / equality / inequality behave correctly when attributes are absent', async () => {
    const sel = new StreamingPathSelector();
    const hasId = sel.register({ path: '/root/x[@id]', prefixes: { '': 'urn:a', b: 'urn:b' } });
    const tagYes = sel.register({
      path: '/root/x[@b:tag="yes"]',
      prefixes: NS,
    });
    const idNotTwo = sel.register({
      path: '/root/x[@id!="2"]',
      prefixes: { '': 'urn:a', b: 'urn:b' },
    });
    await traverse(sel, xml);
    expect(await drain(hasId)).toHaveLength(2);
    expect(await drain(tagYes)).toHaveLength(1);
    // missing @id means the != test does NOT match (SQL-style three-valued logic)
    expect(await drain(idNotTwo)).toHaveLength(1);
  });
});

describe('state release and bounded active state', () => {
  it('does not grow with the number of already-read siblings (wide document)', async () => {
    const N = 20_000;
    const events: XmlEvent[] = [
      start('root', 'urn:a'),
    ];
    for (let i = 0; i < N; i++) {
      events.push(start('leaf', 'urn:a'));
      events.push({ type: 'text', value: `v${i}` });
      events.push(end('leaf', 'urn:a'));
    }
    events.push(end('root', 'urn:a'));

    const sel = new StreamingPathSelector();
    const q = sel.register({ path: '/root/leaf[1]', prefixes: { '': 'urn:a' } });
    const qLast = sel.register({
      path: '/root/leaf',
      prefixes: { '': 'urn:a' },
      highWatermark: N,
      overflowPolicy: 'drop-oldest',
    });

    let observedActive = 0;
    for await (const ev of events) {
      await sel.feed(ev);
      observedActive = Math.max(observedActive, sel.activeStateCount());
    }
    await sel.finish();

    // Active states are bounded by depth (max 2) and query count, not N.
    expect(observedActive).toBeLessThan(12);
    const first = await drain(q);
    expect(first).toHaveLength(1);
    expect(first[0].text).toBe('v0');
    expect(await drain(qLast)).toHaveLength(N);
  });

  it('handles a deeply nested document with constant active-state slope', async () => {
    const depth = 5_000;
    async function* gen(): AsyncGenerator<XmlEvent> {
      yield start('d', 'urn:x');
      for (let i = 1; i < depth; i++) yield start('d', 'urn:x');
      yield { type: 'text', value: 'core' };
      for (let i = 0; i < depth; i++) yield end('d', 'urn:x');
    }

    const sel = new StreamingPathSelector();
    const shallow = sel.register({ path: '/d/d', prefixes: { '': 'urn:x' } });
    const deepest = sel.register({ path: '//d', prefixes: { '': 'urn:x' }, highWatermark: depth });
    await run(sel, gen());

    const s = await drain(shallow);
    expect(s).toHaveLength(1);
    const all = await drain(deepest);
    expect(all).toHaveLength(depth);
    expect(all[depth - 1].text).toBe('core');
  });
});

describe('query cancellation', () => {
  const xml = `<root xmlns="urn:a">
    ${Array.from({ length: 20 }, (_, i) => `<item>${i}</item>`).join('')}
  </root>`;

  it('stops delivering to a cancelled query while others continue', async () => {
    const sel = new StreamingPathSelector();
    const victim = sel.register({
      path: '//item',
      prefixes: { '': 'urn:a' },
      highWatermark: 4,
      overflowPolicy: 'drop-newest',
    });
    const survivor = sel.register({
      path: '//item',
      prefixes: { '': 'urn:a' },
      highWatermark: 100,
    });

    let cancelled = false;
    const victimDone = (async () => {
      let n = 0;
      for await (const _ of victim) {
        n += 1;
        if (n === 2) {
          victim.cancel();
          cancelled = true;
        }
      }
      return n;
    })();

    await traverse(sel, xml);
    const consumed = await victimDone;
    expect(cancelled).toBe(true);
    expect(consumed).toBe(2);
    expect(victim.alive).toBe(false);

    const rest = await drain(survivor);
    expect(rest).toHaveLength(20);
    // cancellation released the victim's NFA state on open frames
    expect(sel.activeStateCount()).toBe(0);
  });

  it('can be cancelled before traversal ends without breaking the parser', async () => {
    const sel = new StreamingPathSelector();
    const q = sel.register({ path: '//item', prefixes: { '': 'urn:a' } });
    q.cancel();
    await traverse(sel, xml);
    expect(await drain(q)).toEqual([]);
  });
});

describe('slow consumers / backpressure isolation', () => {
  const xml = `<root xmlns="urn:a">
    ${Array.from({ length: 50 }, (_, i) => `<item>${i}</item>`).join('')}
  </root>`;

  it('drop policies never block and keep bounded queues', async () => {
    const sel = new StreamingPathSelector();
    const oldest = sel.register({
      path: '//item',
      prefixes: { '': 'urn:a' },
      highWatermark: 5,
      overflowPolicy: 'drop-oldest',
    });
    const newest = sel.register({
      path: '//item',
      prefixes: { '': 'urn:a' },
      highWatermark: 3,
      overflowPolicy: 'drop-newest',
    });
    const normal = sel.register({
      path: '//item',
      prefixes: { '': 'urn:a' },
      highWatermark: 100,
    });
    await traverse(sel, xml);

    const o = await drain(oldest);
    expect(o.map((m) => m.text)).toEqual(['45', '46', '47', '48', '49']);
    const n = await drain(newest);
    expect(n.map((m) => m.text)).toEqual(['0', '1', '2']);
    expect(await drain(normal)).toHaveLength(50);
  });

  it('wait policy blocks the producer until the consumer catches up', async () => {
    const sel = new StreamingPathSelector();
    const slow = sel.register({
      path: '//item',
      prefixes: { '': 'urn:a' },
      highWatermark: 4,
      overflowPolicy: 'wait',
    });

    const consumed: number[] = [];
    const consume = (async () => {
      for await (const m of slow) {
        consumed.push(Number(m.text));
        await new Promise((r) => setTimeout(r, 1));
      }
    })();

    await traverse(sel, xml);
    await consume;
    expect(consumed).toHaveLength(50);
  });

  it('a slow/cancelled consumer under wait policy does not strand other queries', async () => {
    const sel = new StreamingPathSelector();
    const stuck = sel.register({
      path: '//item',
      prefixes: { '': 'urn:a' },
      highWatermark: 2,
      overflowPolicy: 'wait',
    });
    const fine = sel.register({
      path: '//item',
      prefixes: { '': 'urn:a' },
      highWatermark: 100,
    });

    // Consume exactly two matches (fills the watermark), then abandon the
    // iterator: `return()` cancels and releases the producer.
    const abandon = (async () => {
      const it = stuck[Symbol.asyncIterator]();
      await it.next();
      await it.next();
      await it.return?.();
    })();

    await traverse(sel, xml); // must resolve despite the abandoned query
    await abandon;
    expect(stuck.alive).toBe(false);
    expect(await drain(fine)).toHaveLength(50);
  });

  it('fail policy kills only the overflowing query and rejects its consumer', async () => {
    const sel = new StreamingPathSelector();
    const doomed = sel.register({
      path: '//item',
      prefixes: { '': 'urn:a' },
      highWatermark: 5,
      overflowPolicy: 'fail',
    });
    const healthy = sel.register({
      path: '//item',
      prefixes: { '': 'urn:a' },
      highWatermark: 100,
    });

    await traverse(sel, xml); // the overflowing query does not throw here
    expect(doomed.alive).toBe(false);
    const got = await drain(doomed).then(
      (m) => ({ m }),
      (err: unknown) => ({ err: (err as Error).name }),
    );
    expect(got).toEqual({ err: 'BackpressureError' });
    expect(await drain(healthy)).toHaveLength(50);
  });
});

function start(local: string, uri: string): XmlEvent {
  return { type: 'start', element: { prefix: '', local, uri, attributes: [] } };
}
function end(local: string, uri: string): XmlEvent {
  return { type: 'end', prefix: '', local, uri };
}
