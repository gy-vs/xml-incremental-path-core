/**
 * Minimal incremental XML reader.
 *
 * Data is fed in arbitrary chunks; complete tokens are dispatched as
 * namespace-resolved SAX events. No document object is retained — the only
 * bookkeeping is a namespace stack and a tag-name stack.
 */

import { NamespaceStack, type QName } from './namespaces.js';
import type { ExpandedAttribute, XmlHandler } from './engine.js';

export class XmlParseError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} at position ${position}`);
    this.name = 'XmlParseError';
  }
}

interface TagFrame {
  qname: QName;
}

export class XmlStreamReader {
  private buffer = '';
  private offset = 0;
  private readonly namespaces = new NamespaceStack();
  private readonly stack: TagFrame[] = [];
  private done = false;

  constructor(private readonly handler: XmlHandler) {}

  /** Feed a chunk; all fully contained events are emitted synchronously. */
  feed(chunk: string): void {
    if (this.done) throw new XmlParseError('document already closed', this.offset);
    this.buffer += chunk;
    this.pump();
  }

  /** Signal end of input; verifies every element is closed. */
  end(): void {
    if (this.done) return;
    this.pump(true);
    if (this.buffer.trim() !== '' || this.stack.length > 0) {
      throw new XmlParseError('unexpected end of input', this.offset + this.buffer.length);
    }
    this.done = true;
  }

  private pump(final = false): void {
    for (;;) {
      const lt = this.buffer.indexOf('<');
      if (lt < 0) {
        if (final) {
          if (this.buffer.trim() !== '') this.emitText(this.buffer);
          this.buffer = '';
        }
        // Otherwise retain: character data runs up to the next "<", and
        // waiting also heals entities split across chunk boundaries.
        return;
      }

      if (lt > 0) {
        const text = this.buffer.slice(0, lt);
        this.consume(lt);
        this.emitText(text);
      }

      // Determine tag type.
      if (this.buffer[1] === '?') {
        const close = this.buffer.indexOf('?>');
        if (close < 0) return;
        this.consume(close + 2);
        continue;
      }
      if (this.buffer[1] === '!') {
        if (this.buffer.startsWith('<!--')) {
          const close = this.buffer.indexOf('-->');
          if (close < 0) return;
          this.consume(close + 3);
          continue;
        }
        if (this.buffer.startsWith('<![CDATA[')) {
          const start = 9;
          const close = this.buffer.indexOf(']]>');
          if (close < 0) return;
          const content = this.buffer.slice(start, close);
          this.consume(close + 3);
          this.handler.text(content);
          continue;
        }
        if (this.buffer.startsWith('<!DOCTYPE') || this.buffer.startsWith('<!ENTITY')) {
          const close = this.buffer.indexOf('>');
          if (close < 0) return;
          this.consume(close + 1);
          continue;
        }
        // A declaration whose keyword is itself split across chunks: wait
        // for more data rather than declaring it unrecognisable.
        if (this.buffer.indexOf('>') < 0) return;
        throw new XmlParseError('unrecognised markup declaration', this.offset);
      }

      // Element tag: find its ">" respecting quoted attribute values.
      const tagEnd = this.findTagEnd();
      if (tagEnd < 0) return;
      const tagBody = this.buffer.slice(1, tagEnd);
      this.consume(tagEnd + 1);

      if (tagBody.startsWith('/')) {
        this.handleEndTag(tagBody.slice(1).trim());
      } else {
        this.handleStartTag(tagBody);
      }
    }
  }

  /** Locate ">" outside single/double quotes; -1 while the tag is truncated. */
  private findTagEnd(): number {
    let quote: '"' | "'" | '' = '';
    for (let i = 1; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        return i;
      }
    }
    return -1;
  }

  private handleStartTag(body: string): void {
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);
    const tokens = this.scanNameAndAttributes(body);
    const elementName = tokens.name;
    const declarations: Record<string, string> = {};
    const rawAttributes: { raw: string; value: string }[] = [];
    for (const attr of tokens.attributes) {
      const colon = attr.raw.indexOf(':');
      const isXmlns = attr.raw === 'xmlns' || (attr.raw.startsWith('xmlns:') && colon === 5);
      if (isXmlns) {
        const prefix = attr.raw === 'xmlns' ? '' : attr.raw.slice(6);
        declarations[prefix] = attr.value;
      } else {
        rawAttributes.push({ raw: attr.raw, value: attr.value });
      }
    }

    this.namespaces.start(declarations);
    const qname = this.namespaces.resolve(elementName);
    const attributes: ExpandedAttribute[] = rawAttributes.map(({ raw, value }) => {
      const resolved = this.namespaces.resolve(raw, true);
      return { uri: resolved.uri, local: resolved.local, value: decodeEntities(value) };
    });

    this.handler.startElement(qname.uri, qname.local, qname.prefix, attributes);
    if (selfClosing) {
      this.handler.endElement(qname.uri, qname.local, qname.prefix);
      this.namespaces.end();
    } else {
      this.stack.push({ qname });
    }
  }

  private handleEndTag(rawName: string): void {
    const qname = this.namespaces.resolve(rawName);
    const frame = this.stack.pop();
    if (!frame || frame.qname.uri !== qname.uri || frame.qname.local !== qname.local) {
      throw new XmlParseError(`closing tag </${rawName}> does not match open element`, this.offset);
    }
    this.handler.endElement(qname.uri, qname.local, qname.prefix);
    this.namespaces.end();
  }

  /** Split a start-tag body into its element name and attribute tokens. */
  private scanNameAndAttributes(body: string): { name: string; attributes: { raw: string; value: string }[] } {
    const attributes: { raw: string; value: string }[] = [];
    let i = 0;
    i = skipSpaces(body, i);
    const nameStart = i;
    while (i < body.length && !isSpace(body[i])) i++;
    const name = body.slice(nameStart, i);
    if (name === '') throw new XmlParseError('start tag missing element name', this.offset);

    for (;;) {
      i = skipSpaces(body, i);
      if (i >= body.length) break;
      const attrStart = i;
      while (i < body.length && body[i] !== '=' && !isSpace(body[i])) i++;
      const raw = body.slice(attrStart, i);
      i = skipSpaces(body, i);
      if (body[i] !== '=') throw new XmlParseError(`attribute "${raw}" missing value`, this.offset);
      i++;
      i = skipSpaces(body, i);
      const quote = body[i];
      if (quote !== '"' && quote !== "'") throw new XmlParseError(`attribute "${raw}" value must be quoted`, this.offset);
      i++;
      const valueStart = i;
      while (i < body.length && body[i] !== quote) i++;
      if (i >= body.length) throw new XmlParseError(`unterminated attribute "${raw}"`, this.offset);
      const value = body.slice(valueStart, i);
      i++; // closing quote
      attributes.push({ raw, value });
    }
    return { name, attributes };
  }

  private consume(n: number): void {
    this.buffer = this.buffer.slice(n);
    this.offset += n;
  }

  private emitText(raw: string): void {
    if (raw === '' || /^\s+$/.test(raw)) return;
    const decoded = decodeEntities(raw);
    if (decoded !== '') this.handler.text(decoded);
  }
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function skipSpaces(s: string, i: number): number {
  while (i < s.length && isSpace(s[i])) i++;
  return i;
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '&') {
      out += c;
      continue;
    }
    const semi = s.indexOf(';', i);
    if (semi < 0) {
      out += s.slice(i);
      break;
    }
    const body = s.slice(i + 1, semi);
    if (body.startsWith('#')) {
      const code =
        body.startsWith('#x') || body.startsWith('#X')
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code >= 0) {
        out += String.fromCodePoint(code);
        i = semi;
        continue;
      }
    } else if (body in NAMED_ENTITIES) {
      out += NAMED_ENTITIES[body];
      i = semi;
      continue;
    }
    out += s.slice(i, semi + 1);
    i = semi;
  }
  return out;
}
