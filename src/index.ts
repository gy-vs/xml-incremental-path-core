export { NamespaceStack } from './namespaces.js';
export type { QName } from './namespaces.js';
export { compilePath, PathSyntaxError } from './path.js';
export type { CompiledPath, Step, NodeTest, Predicate, PathNamespaces, PositionClass } from './path.js';
export {
  PathProcessor,
  MatchedElement,
  BackpressureError,
  attrKey,
} from './engine.js';
export type {
  XmlHandler,
  QueryHandle,
  QueryOptions,
  QueryStats,
  OverflowStrategy,
  ExpandedAttribute,
} from './engine.js';
export { XmlStreamReader, XmlParseError, decodeEntities } from './xml-reader.js';
