/**
 * Restricted path language
 * ------------------------
 *
 *   path        := "/" [step ("/" step)*]
 *   step        := axis? nameTest predicate*
 *   axis        := "/"                  (child, default) | "//" (descendant)
 *   nameTest    := qname | "*" | "*:" local
 *   predicate   := "[" predicateExpr "]"
 *   predicateExpr := position
 *                  | "@" attrQname
 *                  | "@" attrQname ("=" | "!=") literal
 *   literal     := '"' ... '"' | "'" ... "'"
 *
 * Numeric positions are 1-based among same-named siblings (a wildcard name
 * test counts all element siblings). Attribute qnames are resolved against
 * the compile-time prefix map; an unmapped prefix is a compile error.
 */

export type PrefixMap = Record<string, string>;

export interface NameTest {
  /** '*' matches any namespace, including the empty (no-namespace) uri. */
  anyNamespace: boolean;
  uri: string;
  /** '*' matches any local name. */
  local: string;
}

export interface AttrName {
  uri: string;
  local: string;
}

export type Predicate =
  | { kind: 'position'; position: number }
  | { kind: 'attr'; attr: AttrName; op: 'exists' }
  | {
      kind: 'attr';
      attr: AttrName;
      op: '=' | '!=';
      value: string;
    };

export interface CompiledStep {
  descendant: boolean;
  name: NameTest;
  predicates: Predicate[];
}

export interface CompiledPath {
  steps: CompiledStep[];
  source: string;
}

export class PathCompileError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly offset?: number,
  ) {
    super(offset === undefined ? message : `${message} (at ${offset}) in "${source}"`);
    this.name = 'PathCompileError';
  }
}

const MAX_STEPS = 30;

export function compilePath(expression: string, prefixes: PrefixMap = {}): CompiledPath {
  const src = expression.trim();
  if (src.length === 0) throw new PathCompileError('empty path expression', expression);

  let i = 0;
  const expectRoot = (): void => {
    if (src[i] !== '/') {
      throw new PathCompileError('path must start with "/"', expression, i);
    }
  };
  expectRoot();

  const steps: CompiledStep[] = [];
  // Consume the (possibly doubled) separator before each step; the first one
  // may be `//step` as well.
  while (i < src.length) {
    // At this point src[i] === '/' separates this step from the previous one.
    let descendant = false;
    if (src[i] === '/' && src[i + 1] === '/') {
      descendant = true;
      i += 2;
    } else {
      i += 1;
    }
    if (i >= src.length || src[i] === '/') {
      throw new PathCompileError('expected a step after "/"', expression, i);
    }
    steps.push(parseStep(descendant));
    if (steps.length > MAX_STEPS) {
      throw new PathCompileError(`path exceeds ${MAX_STEPS} steps`, expression);
    }
  }

  if (steps.length === 0) throw new PathCompileError('path contains no steps', expression);
  return { steps, source: expression };

  function parseStep(descendant: boolean): CompiledStep {
    const name = parseNameTest();
    const predicates: Predicate[] = [];
    skipSpaces();
    while (src[i] === '[') {
      predicates.push(parsePredicate());
      skipSpaces();
    }
    return { descendant, name, predicates };
  }

  function parseNameTest(): NameTest {
    skipSpaces();
    if (src[i] === '*') {
      i += 1;
      if (src[i] === ':') {
        // "*:local" — XPath 2.0 wildcard: any namespace (including none),
        // fixed local name.
        i += 1;
        const local = readNamePart();
        return { anyNamespace: true, uri: '', local };
      }
      return { anyNamespace: true, uri: '', local: '*' };
    }
    let prefix = readNamePart();
    if (src[i] !== ':') {
      // Unqualified name: bind to the caller's default-namespace mapping.
      return { anyNamespace: false, uri: prefixes[''] ?? '', local: prefix };
    }
    i += 1;
    if (src[i] === '*') {
      i += 1;
      return { anyNamespace: false, uri: resolvePrefix(prefix, i), local: '*' };
    }
    const local = readNamePart();
    return { anyNamespace: false, uri: resolvePrefix(prefix, i), local };
  }

  function readNamePart(): string {
    const begin = i;
    while (i < src.length && isNameChar(src[i])) i += 1;
    if (i === begin) throw new PathCompileError('expected a name', expression, i);
    return src.slice(begin, i);
  }

  function parsePredicate(): Predicate {
    i += 1; // '['
    skipSpaces();
    let pred: Predicate;
    if (src[i] === '@') {
      i += 1;
      const attr = parseAttrName();
      skipSpaces();
      if (src[i] === ']') {
        pred = { kind: 'attr', attr, op: 'exists' };
      } else if (src[i] === '=' || (src[i] === '!' && src[i + 1] === '=')) {
        const op = src[i] === '=' ? '=' : '!=';
        i += op.length;
        skipSpaces();
        pred = { kind: 'attr', attr, op, value: readLiteral() };
      } else {
        throw new PathCompileError('expected "]", "=" or "!="', expression, i);
      }
    } else {
      const begin = i;
      while (i < src.length && isDigit(src[i])) i += 1;
      if (i === begin) {
        throw new PathCompileError('unsupported predicate; only positions and @attr tests are allowed', expression, i);
      }
      const position = Number(src.slice(begin, i));
      if (position < 1) throw new PathCompileError('position must be >= 1', expression, begin);
      pred = { kind: 'position', position };
    }
    skipSpaces();
    if (src[i] !== ']') throw new PathCompileError('expected "]"', expression, i);
    i += 1;
    skipSpaces();
    return pred;
  }

  function parseAttrName(): AttrName {
    const prefix = readNamePart();
    if (src[i] !== ':') {
      // Unprefixed attribute: always in no namespace, even when the path
      // binds a default namespace for elements (XML namespaces §6.2).
      return { uri: '', local: prefix };
    }
    i += 1;
    const local = readNamePart();
    return { uri: resolvePrefix(prefix, i), local };
  }

  function readLiteral(): string {
    const quote = src[i];
    if (quote !== '"' && quote !== "'") {
      throw new PathCompileError('expected a quoted string', expression, i);
    }
    i += 1;
    let value = '';
    while (i < src.length && src[i] !== quote) {
      value += src[i];
      i += 1;
    }
    if (src[i] !== quote) throw new PathCompileError('unterminated string literal', expression, i);
    i += 1;
    return value;
  }

  function resolvePrefix(prefix: string, at: number): string {
    if (!(prefix in prefixes)) {
      throw new PathCompileError(`unbound prefix "${prefix}"`, expression, at);
    }
    return prefixes[prefix];
  }

  function skipSpaces(): void {
    while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i += 1;
  }
}

function isNameChar(c: string): boolean {
  return (
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    isDigit(c) ||
    c === '-' ||
    c === '_' ||
    c === '.'
  );
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

/** Evaluate a compiled step's predicates against a candidate element. */
export function evaluatePredicates(
  predicates: Predicate[],
  attrs: { uri: string; local: string; value: string }[],
  positionOfSameName: number,
): boolean {
  for (const p of predicates) {
    if (p.kind === 'position') {
      if (positionOfSameName !== p.position) return false;
      continue;
    }
    const found = attrs.find((a) => a.uri === p.attr.uri && a.local === p.attr.local);
    if (p.op === 'exists') {
      if (!found) return false;
    } else {
      if (!found) return false;
      const equal = found.value === p.value;
      if (p.op === '=' ? !equal : equal) return false;
    }
  }
  return true;
}
