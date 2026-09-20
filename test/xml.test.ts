import { describe, expect, it } from 'vitest';
import { scanXml } from '../src/index.js';

describe('scanXml', () => {
  it('resolves namespace declarations and unprefixed attributes', () => {
    const xml =
      '<?xml version="1.0"?><r xmlns="urn:d" xmlns:p="urn:p" a="1" p:b="2"><!-- c --><x p:z="&lt;"/><![CDATA[a<b]]></r>';
    const events = [...scanXml(xml)];
    const start = events[0]!;
    expect(start.type).toBe('start');
    if (start.type !== 'start') throw new Error('narrow');
    expect(start.element.uri).toBe('urn:d');
    expect(start.element.attributes.map((a) => [a.uri, a.local, a.value])).toEqual([
      ['', 'a', '1'],
      ['urn:p', 'b', '2'],
    ]);

    const x = events.find(
      (e) => e.type === 'start' && (e as { element: { local: string } }).element.local === 'x',
    );
    expect(x && x.type === 'start' ? x.element.attributes[0] : null).toMatchObject({
      uri: 'urn:p',
      local: 'z',
      value: '<',
    });
    expect(events.some((e) => e.type === 'text' && e.type === 'text' && (e as { value: string }).value === 'a<b')).toBe(
      true,
    );
  });

  it('handles self-closing elements and default-namespace undeclaration', () => {
    const events = [
      ...scanXml(`<a xmlns="urn:a"><b xmlns=""/></a>`),
    ];
    const kinds = events.map((e) => (e.type === 'start' ? `s:${e.element.uri}` : e.type));
    expect(kinds).toEqual(['s:urn:a', 's:', 'end', 'end']);
  });
});
