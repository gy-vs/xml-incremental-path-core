export type QName = { prefix: string; local: string; uri: string };

export class NamespaceStack {
  #frames: Record<string, string>[] = [{}];

  start(declarations: Record<string, string>): void {
    this.#frames.push({ ...this.#frames.at(-1), ...declarations });
  }

  end(): void {
    if (this.#frames.length > 1) this.#frames.pop();
  }

  resolve(name: string, attribute = false): QName {
    const [prefix = '', local = name] = name.includes(':') ? name.split(':', 2) : ['', name];
    // Unprefixed attribute names live in no namespace (XPath/XML semantics).
    const uri = attribute && prefix === '' ? '' : (this.#frames.at(-1)?.[prefix] ?? '');
    return { prefix, local, uri };
  }
}
