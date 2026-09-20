export { NamespaceStack, type QName } from './namespace.js';
export {
  compilePath,
  evaluatePredicates,
  PathCompileError,
  type CompiledPath,
  type CompiledStep,
  type NameTest,
  type Predicate,
  type PrefixMap,
  type AttrName,
} from './path.js';
export {
  StreamingPathSelector,
  type RegisterOptions,
  type Query,
} from './selector.js';
export { ResultQueue, BackpressureError, type OverflowPolicy } from './queue.js';
export {
  scanXml,
  run,
} from './xml.js';
export type {
  XmlEvent,
  ElementInfo,
  ResolvedAttribute,
  Match,
} from './events.js';
