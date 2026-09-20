# XML incremental path core

Namespace-aware, multi-query path selection over a streaming XML parser.
No DOM is ever built: live matching state is `O(depth × queries × path
length)`, independent of how many nodes have already been consumed.

Run `npm install`, then `npm test` and `npm run build`.

## Path language

```
Path       ::= ("/" | "//") Step ("/" | "//" Step)*
Step       ::= NodeTest Predicate*
NodeTest   ::= "*" | Name | "*:" LocalName
Predicate  ::= "[" Number "]"            -- positional, 1-based same-name sibling
             | "[" "@" Name "]"          -- attribute presence
             | "[" "@" Name "=" Literal"]" -- attribute equality
```

- `/` is the child axis, `//` the descendant axis.
- Prefixes are resolved at **compile time** against each query's own
  `prefixes` map; unprefixed element tests may map to a `defaultNamespace`,
  while unprefixed attribute names always stay in no namespace (XPath rules).
- A match is delivered when the target element's **closing tag** is consumed.

## Usage

```ts
import { XmlStreamReader, PathProcessor, compilePath } from './dist/index.js';

const processor = new PathProcessor();

const items = processor.addQuery(
  compilePath('//a:item[@b:kind="x"]', { prefixes: { a: 'urn:a', b: 'urn:b' } }),
);
const nested = processor.addQuery(
  compilePath('//b:nested[2]', { prefixes: { b: 'urn:b' } }),
  { capacity: 1000, overflow: 'error', collectText: true },
);

const reader = new XmlStreamReader(processor);
reader.feed(chunk1);   // chunks may split any token; events fire synchronously
reader.feed(chunk2);
reader.end();          // verifies all elements are closed
processor.finish();    // closes every query's result stream

for (const match of nested) {
  match.uri; match.local; match.depth; match.sequence;
  match.getAttribute(uri, local);
  match.text;          // XPath string value (collectText), incl. descendants
}
```

`overflow` is one of `'error'` (the query faults with `BackpressureError`),
`'drop-oldest'` or `'drop-newest'` (see `handle.stats.dropped`). A default
capacity can be passed to the `PathProcessor` constructor.

## Isolation

Queries share one traversal but own private, bounded result queues:

- `handle.cancel()` removes only that query's threads from every open frame;
  the underlying parse and all other queries continue unaffected.
- A query that overflows under `'error'` is likewise isolated — the slow
  consumer never blocks the parser or its peers.

Results can be polled non-blockingly with `handle.tryTake()` or consumed with
the query's async iterator; a match produced while a consumer is parked is
handed over immediately.
