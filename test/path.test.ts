import { describe, expect, it } from 'vitest';
import {
  compilePath,
  PathCompileError,
  evaluatePredicates,
} from '../src/index.js';

describe('compilePath', () => {
  it('compiles child and descendant steps', () => {
    const p = compilePath('/a//b/c', { '': 'urn:default' });
    expect(p.steps.map((s) => s.descendant)).toEqual([false, true, false]);
    expect(p.steps[0].name).toEqual({ anyNamespace: false, uri: 'urn:default', local: 'a' });
    expect(p.steps[1].name.local).toBe('b');
  });

  it('supports multiple prefix mappings and wildcard namespace', () => {
    const p = compilePath('/p:root/q:item/*:x/*', {
      p: 'urn:p',
      q: 'urn:q',
    });
    expect(p.steps[0].name.uri).toBe('urn:p');
    expect(p.steps[1].name.uri).toBe('urn:q');
    expect(p.steps[2].name).toMatchObject({ uri: '', local: 'x', anyNamespace: true });
    expect(p.steps[3].name).toEqual({ anyNamespace: true, uri: '', local: '*' });
  });

  it('parses positional and attribute predicates', () => {
    const p = compilePath('/a/item[2][@kind="x"][@id!="z"][@flag]', {
      p: 'urn:p',
    });
    const preds = p.steps[1].predicates;
    expect(preds).toHaveLength(4);
    expect(preds[0]).toEqual({ kind: 'position', position: 2 });
    expect(preds[1]).toMatchObject({ kind: 'attr', op: '=', value: 'x' });
    expect(preds[2]).toMatchObject({ kind: 'attr', op: '!=', value: 'z' });
    expect(preds[3]).toMatchObject({ kind: 'attr', op: 'exists' });
  });

  it('resolves prefixed attribute names', () => {
    const p = compilePath('/a[@p:id="1"]', { p: 'urn:p' });
    const pred = p.steps[0].predicates[0];
    expect(pred).toMatchObject({ attr: { uri: 'urn:p', local: 'id' } });
  });

  it('rejects unbound prefixes, malformed paths and predicates', () => {
    expect(() => compilePath('/a/b')).not.toThrow();
    expect(() => compilePath('a/b')).toThrow(PathCompileError);
    expect(() => compilePath('/a//')).toThrow(PathCompileError);
    expect(() => compilePath('/x:y', {})).toThrow(PathCompileError);
    expect(() => compilePath('/a[0]')).toThrow(PathCompileError);
    expect(() => compilePath('/a[text()="x"]')).toThrow(PathCompileError);
    expect(() => compilePath('/a[@x=1]')).toThrow(PathCompileError);
  });

  it('evaluates predicates including the missing-attribute case', () => {
    const attrs = [{ uri: 'u', local: 'id', value: '1' }];
    expect(
      evaluatePredicates(
        [{ kind: 'attr', attr: { uri: 'u', local: 'id' }, op: 'exists' }],
        attrs,
        1,
      ),
    ).toBe(true);
    expect(
      evaluatePredicates(
        [{ kind: 'attr', attr: { uri: 'u', local: 'missing' }, op: 'exists' }],
        attrs,
        1,
      ),
    ).toBe(false);
    expect(
      evaluatePredicates(
        [{ kind: 'attr', attr: { uri: 'u', local: 'id' }, op: '!=', value: '1' }],
        attrs,
        1,
      ),
    ).toBe(false);
  });
});
