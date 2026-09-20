# XML stream core

Namespace-aware, fully incremental XML path selection. Path expressions are
compiled to NFA state sets that are advanced on element entry and released on
element exit, so the selector never builds a DOM and its live state scales
with **open depth × registered-query size**, not with the number of nodes
read.

Run `npm install`, then `npm test` and `npm run build`.

## Path language

```
/a/b            children, namespace-qualified via a compile-time prefix map
/a//item        descendant axis (zero or more levels deep)
/p:root/q:item  multiple prefixes, each bound independently
//*:item        any namespace (including none), fixed local name
//*             any element
/item[2]        1-based position among same-named siblings
/item[@id]      attribute existence (missing attribute => no match)
/item[@k="x"]   attribute equality; @k!="v" needs the attribute to exist
```

Predicates form an XPath-style filter chain: `/item[@k="x"][2]` is the second
same-named sibling *among those passing `@k="x"`*. Unprefixed attributes are
matched in no namespace even when the path binds a default namespace
(XML-namespaces §6.2).

## Shared traversal, isolated queries

```ts
import { StreamingPathSelector, scanXml, run } from 'xml-incremental-path-core';

const selector = new StreamingPathSelector();

const items = selector.register({ path: '//doc:item', prefixes: { doc: 'urn:doc' } });
const second = selector.register({
  path: '/doc:root/doc:item[2][@kind="a"]',
  prefixes: { doc: 'urn:doc' },
  highWatermark: 64,          // bounded per-query result queue
  overflowPolicy: 'wait',     // 'drop-oldest' | 'drop-newest' | 'wait' | 'fail'
});

await run(selector, scanXml(xmlText)); // one pass drives every query

for await (const m of items) {
  m.uri; m.local; m.depth;      // resolved name and 1-based depth
  m.attr('urn:doc', 'kind');    // null when absent
  m.text;                       // subtree text, completed on the end tag
}
```

Results are delivered when the matched element's **end tag** is consumed, so
`text` always contains the full subtree text. `run`/`feed` accept any
`Iterable<XmlEvent>`/`AsyncIterable<XmlEvent>`; `scanXml` is a minimal
reference scanner and any SAX-style source can be plugged in.

## Backpressure and cancellation

Each query owns a bounded queue; a slow or cancelled consumer is contained to
that query and never stalls the others or the underlying parse:

- `drop-oldest` (default) / `drop-newest` — never block;
- `wait` — `feed` on a completing element awaits free capacity for that one
  query while every other query has already been enqueued;
- `fail` — the overflowing query dies with a `BackpressureError` on its
  iterator; other queries and traversal continue;
- `query.cancel()` (or abandoning a `for await`) removes the query's NFA
  states from all open frames immediately.

## Engine model

- A path with `L` steps compiles to `L + 1` NFA states held as an integer bit
  mask per open element, per query.
- A descendant step *lingers*: its bit is inherited unchanged at every depth
  and additionally acts as a transition candidate.
- On `endElement` the frame is dropped, releasing every state that lived only
  inside that subtree. Positional counters live on the parent frame and are
  dropped with it.
- `selector.activeStateCount()` exposes the total live states for assertions
  about the bounded-memory guarantee (a 20 000-sibling wide document and a
  5 000-level deep document are covered in `test/selector.test.ts`).
