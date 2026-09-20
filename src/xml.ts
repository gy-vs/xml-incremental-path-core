import { NamespaceStack } from './namespace.js';
import type { ElementInfo, ResolvedAttribute, XmlEvent } from './events.js';
import type { StreamingPathSelector } from './selector.js';

const ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

const NAME_START = /[A-Za-z_]/;

/**
 * Minimal namespace-aware XML pull scanner. Covers the subset exercised by a
 * streaming pipeline (elements, attributes, namespace declarations, text,
 * CDATA, comments, processing instructions, the xml declaration, self
 * closing). It is intentionally not a conformant full XML parser: the
 * selector consumes any XmlEvent source, so a hardened SAX parser can be
 * plugged in instead.
 */
export function* scanXml(xml: string): Generator<XmlEvent> {
  const ns = new NamespaceStack();
  let i = 0;
  const n = xml.length;

  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      if (i < n) yield { type: 'text', value: decodeEntities(xml.slice(i)) };
      break;
    }
    if (lt > i) yield { type: 'text', value: decodeEntities(xml.slice(i, lt)) };

    const c = xml[lt + 1];
    if (c === '?') {
      i = xml.indexOf('?>', lt + 2);
      if (i === -1) throw new Error('unterminated processing instruction');
      i += 2;
      continue;
    }
    if (c === '!') {
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4);
        if (end === -1) throw new Error('unterminated comment');
        i = end + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt + 9);
        if (end === -1) throw new Error('unterminated CDATA section');
        yield { type: 'text', value: xml.slice(lt + 9, end) };
        i = end + 3;
        continue;
      }
      if (xml.startsWith('<!DOCTYPE', lt)) {
        // Skip internal DTD minimally (bracket nesting).
        let j = lt + 9;
        let depth = 0;
        while (j < n) {
          if (xml[j] === '[') depth += 1;
          else if (xml[j] === ']') depth -= 1;
          else if (xml[j] === '>' && depth === 0) break;
          j += 1;
        }
        i = j + 1;
        continue;
      }
      throw new Error(`unsupported markup at offset ${lt}`);
    }
    if (c === '/') {
      const end = xml.indexOf('>', lt);
      if (end === -1) throw new Error('unterminated end tag');
      ns.end();
      const raw = xml.slice(lt + 2, end);
      const { prefix, local, uri } = ns.resolve(raw);
      yield { type: 'end', prefix, local, uri };
      i = end + 1;
      continue;
    }
    if (NAME_START.test(c ?? '')) {
      const tagStart = lt + 1;
      let j = tagStart;
      while (j < n && isNameByte(xml[j])) j += 1;
      const rawName = xml.slice(tagStart, j);

      const declarations: Record<string, string> = {};
      const rawAttrs: { name: string; value: string }[] = [];

      for (;;) {
        while (j < n && (xml[j] === ' ' || xml[j] === '\t' || xml[j] === '\n' || xml[j] === '\r')) j += 1;
        if (xml[j] === '>' || xml.startsWith('/>', j)) break;
        if (j >= n) throw new Error('unterminated start tag');
        const aNameStart = j;
        while (j < n && isNameByte(xml[j])) j += 1;
        const aName = xml.slice(aNameStart, j);
        while (j < n && xml[j] !== '=') {
          if (xml[j] === '>' || xml.startsWith('/>', j)) break;
          j += 1;
        }
        if (xml[j] !== '=') throw new Error(`malformed attribute ${aName}`);
        j += 1;
        const quote = xml[j];
        if (quote !== '"' && quote !== "'") throw new Error('attribute value must be quoted');
        j += 1;
        const vStart = j;
        while (j < n && xml[j] !== quote) j += 1;
        const value = decodeEntities(xml.slice(vStart, j));
        j += 1;
        if (aName === 'xmlns' || aName.startsWith('xmlns:')) {
          const prefix = aName === 'xmlns' ? '' : aName.slice(6);
          declarations[prefix] = value;
        } else {
          rawAttrs.push({ name: aName, value });
        }
      }

      ns.start(declarations);
      const name = ns.resolve(rawName);
      const attributes: ResolvedAttribute[] = rawAttrs.map((a) => {
        const q = ns.resolveAttribute(a.name);
        return { prefix: q.prefix, local: q.local, uri: q.uri, value: a.value };
      });
      const element: ElementInfo = {
        prefix: name.prefix,
        local: name.local,
        uri: name.uri,
        attributes,
      };
      yield { type: 'start', element };

      const selfClosing = xml[j] === '/';
      if (selfClosing) j += 1;
      j += 1; // '>'
      if (selfClosing) {
        ns.end();
        yield { type: 'end', prefix: name.prefix, local: name.local, uri: name.uri };
      }
      i = j;
      continue;
    }
    throw new Error(`unexpected markup at offset ${lt}`);
  }
}

function isNameByte(c: string): boolean {
  return (
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    (c >= '0' && c <= '9') ||
    c === '_' ||
    c === '-' ||
    c === '.' ||
    c === ':'
  );
}

/**
 * Drive a single traversal shared by all registered queries. Backpressure of
 * an individual queue is applied here without touching the other queues.
 */
export async function run(
  selector: StreamingPathSelector,
  events: Iterable<XmlEvent> | AsyncIterable<XmlEvent>,
): Promise<void> {
  for await (const event of events) {
    await selector.feed(event);
  }
  await selector.finish();
}
