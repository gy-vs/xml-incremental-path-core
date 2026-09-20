/** Attribute as produced by the pull parser, already namespace-resolved. */
export interface ResolvedAttribute {
  prefix: string;
  local: string;
  uri: string;
  value: string;
}

export interface ElementInfo {
  prefix: string;
  local: string;
  uri: string;
  attributes: ResolvedAttribute[];
}

export type XmlEvent =
  | { type: 'start'; element: ElementInfo }
  | { type: 'end'; prefix: string; local: string; uri: string }
  | { type: 'text'; value: string };

/** Delivered when the matched element's end tag is consumed. */
export interface Match {
  /** Compiled path that matched. */
  path: string;
  /** Match depth: 1 = document element, 2 = its child, ... */
  depth: number;
  uri: string;
  local: string;
  prefix: string;
  attributes: ResolvedAttribute[];
  /** Concatenated text nodes inside the matched element (subtree text). */
  text: string;
  /** Namespace-sensitive attribute lookup; returns null when absent. */
  attr(uri: string, local: string): string | null;
}
