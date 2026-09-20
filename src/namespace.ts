export interface QName {
  prefix: string;
  local: string;
  uri: string;
}

/**
 * Incremental in-scope namespace stack. One frame per open element; a frame
 * copies its parent's declarations so a `pop()` is a single array pop.
 */
export class NamespaceStack {
  #frames: Record<string, string>[] = [{}];

  start(declarations: Record<string, string>): void {
    this.#frames.push({ ...this.#frames.at(-1), ...declarations });
  }

  end(): void {
    if (this.#frames.length > 1) this.#frames.pop();
  }

  /** Resolve an element (or prefixed attribute) name against the top frame. */
  resolve(name: string): QName {
    const colon = name.indexOf(':');
    const prefix = colon === -1 ? '' : name.slice(0, colon);
    const local = colon === -1 ? name : name.slice(colon + 1);
    const uri = this.#frames.at(-1)?.[prefix] ?? '';
    return { prefix, local, uri };
  }

  /**
   * Resolve an attribute name. Unlike elements, an unprefixed attribute is
   * _never_ bound to the default namespace (Namespaces in XML 1.0, §6.2).
   */
  resolveAttribute(name: string): QName {
    const q = this.resolve(name);
    return q.prefix === '' ? { ...q, uri: '' } : q;
  }

  /** Prefix -> URI mappings visible at the current depth (a live copy). */
  declarations(): Record<string, string> {
    return { ...this.#frames.at(-1) };
  }
}
