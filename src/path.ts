/**
 * Compiler for the restricted path language.
 *
 * Grammar (whitespace is allowed around tokens outside string literals):
 *
 *   Path       ::= ("/" | "//") Step ("/" | "//" Step)*
 *   Step       ::= NodeTest Predicate*
 *   NodeTest   ::= "*" | Name | "*:" LocalName
 *   Name       ::= LocalName | Prefix ":" LocalName
 *   Predicate  ::= "[" Number "]"
 *                | "[" "@" Name "]"
 *                | "[" "@" Name "=" Literal "]"
 *   Literal    ::= '"' [^"]* '"' | "'" [^']* "'"
 *
 * Prefixes are resolved at compile time against the query's own namespace
 * bindings, so running state never depends on prefix strings.
 */

export interface QNameLike {
  prefix: string;
  local: string;
  uri: string;
}

export type NodeTestKind = 'wildcard' | 'wildcardLocal' | 'name';

/** Sibling count class required by a positional predicate. */
export type PositionClass = 'name' | 'local' | 'wildcard';

export interface NodeTest {
  kind: NodeTestKind;
  /** Expanded name for kind "name"; local name only for "wildcardLocal". */
  uri: string;
  local: string;
  /** Original prefix, kept for diagnostics only. */
  prefix: string;
}

export type Predicate =
  | { kind: 'position'; value: number }
  | { kind: 'attr'; qname: QNameLike; value?: string };

export interface Step {
  /** Axis that leads INTO this step (from its parent step / document node). */
  axis: 'child' | 'descendant';
  test: NodeTest;
  predicates: Predicate[];
  /**
   * Sibling count class this step needs when it carries a positional
   * predicate: 'name' (same expanded name), 'local' (same local name) or
   * '*' (all elements). Populated by the compiler.
   */
  posClass: PositionClass | null;
}

export interface CompiledPath {
  readonly source: string;
  readonly steps: Step[];
}

export interface PathNamespaces {
  /** Prefix -> namespace URI. Prefix "" is the default namespace. */
  prefixes?: Record<string, string>;
  /**
   * URI bound to unprefixed element node tests. Unprefixed attribute names
   * always resolve to no namespace (XPath semantics), regardless of this.
   */
  defaultNamespace?: string;
}

export class PathSyntaxError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly position?: number,
  ) {
    super(position === undefined ? `${message} (in "${source}")` : `${message} at position ${position} (in "${source}")`);
    this.name = 'PathSyntaxError';
  }
}

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[\w.\-]/;
const DIGIT = /[0-9]/;

export function compilePath(source: string, bindings: PathNamespaces = {}): CompiledPath {
  const parser = new Parser(source, bindings.prefixes ?? {}, bindings.defaultNamespace ?? '');
  return parser.parse();
}

class Parser {
  private pos = 0;

  constructor(
    private readonly source: string,
    private readonly prefixes: Record<string, string>,
    private readonly defaultNamespace: string,
  ) {}

  private get ch(): string {
    return this.source[this.pos] ?? '';
  }

  private error(message: string): never {
    throw new PathSyntaxError(message, this.source, this.pos);
  }

  private expect(c: string): void {
    this.skipWhitespace();
    if (this.ch !== c) this.error(`expected "${c}"`);
    this.pos++;
  }

  private skipWhitespace(): void {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos])) this.pos++;
  }

  parse(): CompiledPath {
    this.skipWhitespace();
    if (this.ch !== '/') this.error('path must start with "/" or "//"');
    this.pos++;
    const steps: Step[] = [];
    let axis: 'child' | 'descendant' = 'child';
    if (this.ch === '/') {
      axis = 'descendant';
      this.pos++;
    }
    steps.push(this.parseStep(axis));
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= this.source.length) break;
      if (this.ch !== '/') this.error('expected "/"');
      this.pos++;
      let nextAxis: 'child' | 'descendant' = 'child';
      if (this.ch === '/') {
        nextAxis = 'descendant';
        this.pos++;
      }
      steps.push(this.parseStep(nextAxis));
    }
    if (steps.length === 0) this.error('empty path');
    return { source: this.source, steps };
  }

  private parseStep(axis: 'child' | 'descendant'): Step {
    this.skipWhitespace();
    const test = this.parseNodeTest();
    const predicates: Predicate[] = [];
    for (;;) {
      this.skipWhitespace();
      if (this.ch !== '[') break;
      predicates.push(this.parsePredicate());
    }
    const posClass: PositionClass | null = predicates.some((p) => p.kind === 'position')
      ? test.kind === 'name'
        ? 'name'
        : test.kind === 'wildcardLocal'
          ? 'local'
          : 'wildcard'
      : null;
    return { axis, test, predicates, posClass };
  }

  private parseNodeTest(): NodeTest {
    this.skipWhitespace();
    if (this.ch === '*') {
      this.pos++;
      if ((this.ch as string) !== ':') {
        return { kind: 'wildcard', uri: '', local: '*', prefix: '' };
      }
      this.pos++; // consume ":"
      if (this.ch === '*') this.error('"*:*" is not supported; use "*" or "*:local"');
      const local = this.parseNamePart();
      return { kind: 'wildcardLocal', uri: '', local, prefix: '*' };
    }
    const first = this.parseNamePart();
    let prefix = '';
    let local = first;
    if (this.ch === ':') {
      // Must be a prefix:local pair, never "::".
      if (this.source[this.pos + 1] === ':') this.error('unexpected ":"');
      this.pos++;
      prefix = first;
      local = this.parseNamePart();
    }
    const uri = prefix === '' ? this.defaultNamespace : this.resolvePrefix(prefix);
    return { kind: 'name', uri, local, prefix };
  }

  private resolvePrefix(prefix: string): string {
    if (!(prefix in this.prefixes)) {
      this.error(`undeclared namespace prefix "${prefix}"`);
    }
    return this.prefixes[prefix];
  }

  private parseNamePart(): string {
    if (!NAME_START.test(this.ch)) this.error('expected name');
    let start = this.pos;
    while (this.pos < this.source.length && NAME_PART.test(this.source[this.pos])) this.pos++;
    return this.source.slice(start, this.pos);
  }

  private parsePredicate(): Predicate {
    this.expect('[');
    this.skipWhitespace();
    let predicate: Predicate;
    if (DIGIT.test(this.ch)) {
      let start = this.pos;
      while (DIGIT.test(this.ch)) this.pos++;
      predicate = { kind: 'position', value: Number(this.source.slice(start, this.pos)) };
    } else {
      if (this.ch !== '@') this.error('predicate must be a number or an attribute test');
      this.pos++;
      const attr = this.parseQNameAttribute();
      let value: string | undefined;
      this.skipWhitespace();
      if ((this.ch as string) === '=') {
        this.pos++;
        value = this.parseLiteral();
      }
      predicate = { kind: 'attr', qname: attr, value };
    }
    this.expect(']');
    return predicate;
  }

  private parseQNameAttribute(): QNameLike {
    const first = this.parseNamePart();
    let prefix = '';
    let local = first;
    if (this.ch === ':') {
      this.pos++;
      prefix = first;
      local = this.parseNamePart();
    }
    // XPath: unprefixed attribute names are in no namespace.
    const uri = prefix === '' ? '' : this.resolvePrefix(prefix);
    return { prefix, local, uri };
  }

  private parseLiteral(): string {
    this.skipWhitespace();
    const quote = this.ch;
    if (quote !== '"' && quote !== "'") this.error('expected string literal');
    this.pos++;
    let start = this.pos;
    while (this.pos < this.source.length && this.ch !== quote) this.pos++;
    if (this.pos >= this.source.length) this.error('unterminated string literal');
    const value = this.source.slice(start, this.pos);
    this.pos++; // closing quote
    return value;
  }
}
