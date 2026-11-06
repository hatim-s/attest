import { builtinModules } from 'node:module';
import { resolveVariable } from '../shared/scope.mjs';

// Frozen from effect 4.1.2's root module exports; platform groups are excluded.
const coreModules = new Set([
  'Arbitrary',
  'Array',
  'BigDecimal',
  'BigInt',
  'Boolean',
  'Brand',
  'Bytes',
  'ByteSize',
  'Cache',
  'Cause',
  'Channel',
  'ChannelSchema',
  'Chunk',
  'Clock',
  'Combiner',
  'Config',
  'ConfigProvider',
  'Console',
  'Context',
  'Cron',
  'Data',
  'DateTime',
  'Deferred',
  'Differ',
  'Duration',
  'Effect',
  'Effectable',
  'Equal',
  'Equivalence',
  'ErrorReporter',
  'ExecutionPlan',
  'Exit',
  'Fiber',
  'FiberHandle',
  'FiberMap',
  'FiberSet',
  'FileSystem',
  'Filter',
  'Formatter',
  'Function',
  'Glob',
  'Graph',
  'Hash',
  'HashMap',
  'HashRing',
  'HashSet',
  'HKT',
  'Inspectable',
  'Iterable',
  'JsonPatch',
  'JsonPointer',
  'JsonSchema',
  'Latch',
  'Layer',
  'LayerMap',
  'LayerRef',
  'Logger',
  'LogLevel',
  'ManagedRuntime',
  'Match',
  'Metric',
  'MutableHashMap',
  'MutableHashSet',
  'MutableList',
  'MutableRef',
  'Newtype',
  'NonEmptyIterable',
  'Number',
  'Optic',
  'Option',
  'Order',
  'Ordering',
  'PartitionedSemaphore',
  'Path',
  'Pipeable',
  'PlatformError',
  'Pool',
  'Predicate',
  'PrimaryKey',
  'PubSub',
  'Pull',
  'Queue',
  'Random',
  'RcMap',
  'RcRef',
  'Record',
  'Redactable',
  'Redacted',
  'Reducer',
  'Ref',
  'References',
  'RegExp',
  'Request',
  'RequestResolver',
  'Resource',
  'Result',
  'Runtime',
  'Schedule',
  'Scheduler',
  'Schema',
  'SchemaAST',
  'SchemaGetter',
  'SchemaIssue',
  'SchemaParser',
  'SchemaRepresentation',
  'SchemaTransformation',
  'Scope',
  'ScopedCache',
  'ScopedRef',
  'Semaphore',
  'SemVer',
  'SemVerRange',
  'Sink',
  'StandardSchema',
  'Stdio',
  'Stream',
  'String',
  'Struct',
  'SubscriptionRef',
  'Symbol',
  'SynchronizedRef',
  'Take',
  'Terminal',
  'TextDiff',
  'Tracer',
  'Trie',
  'Tuple',
  'TxChunk',
  'TxDeferred',
  'TxHashMap',
  'TxHashSet',
  'TxPriorityQueue',
  'TxPubSub',
  'TxQueue',
  'TxReentrantLock',
  'TxRef',
  'TxSemaphore',
  'TxSubscriptionRef',
  'Types',
  'UndefinedOr',
  'Unify',
  'Utils',
  'Version',
]);
const dataModules = new Set(['Schema', 'SchemaIssue', 'SchemaAST', 'JsonSchema']);
const execution = (module, name) =>
  (module === 'Effect' && name.startsWith('run')) ||
  (module === 'ManagedRuntime' && name === 'make') ||
  (module === 'Runtime' && name === 'makeRunMain') ||
  (['FiberSet', 'FiberMap', 'FiberHandle'].includes(module) && /^runtime(Promise)?$/.test(name)) ||
  (module === 'Stream' && /^to(ReadableStream|AsyncIterable)/.test(name));
const memberName = (node) => (node.computed ? node.property.value : node.property.name);

/** Enforce imports and execution ownership before any application slice adopts Effect. */
const effectBoundariesRule = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: {
          dataOnly: { type: 'boolean' },
          schemaConstructionModules: {
            type: 'array',
            items: { enum: ['Effect', 'SchemaGetter'] },
            uniqueItems: true,
          },
          browser: { type: 'boolean' },
          operations: { type: 'array', items: { type: 'string' } },
          removalSlice: { type: 'string' },
        },
        additionalProperties: false,
      },
    ],
    messages: { boundary: '{{reason}}' },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const allowedDataModules = new Set([...dataModules, ...(options.schemaConstructionModules ?? [])]);
    const bindings = [];
    const used = new Set();
    const taggedComments = new Set();
    const source = context.sourceCode;
    const bridgeComments = source
      .getAllComments()
      .map((comment) => ({
        comment,
        slices: [...comment.value.matchAll(/EFFECT-BRIDGE\(([^)]*)(?:\)|$)/g)].map(
          (match) => (match[0].endsWith(')') ? match[1] : null),
        ),
      }))
      .filter(({ slices }) => slices.length > 0);
    const report = (node, reason) =>
      context.report({ node, messageId: 'boundary', data: { reason } });
    function checkImport(node) {
      const value = node.source?.value;
      if (typeof value !== 'string') return;
      if (options.browser && (/^(node:|bun:)/.test(value) || builtinModules.includes(value)))
        report(node, 'Browser entries cannot import runtime built-ins.');
      if (value.startsWith('@effect/')) {
        report(node, 'Platform and companion Effect packages need an architecture decision.');
        return;
      }
      if (value !== 'effect' && !value.startsWith('effect/')) return;
      const module = value === 'effect' ? null : value.slice(7);
      if (module !== null && !(options.dataOnly ? allowedDataModules : coreModules).has(module)) {
        report(node, 'Only approved Effect core modules are allowed.');
      }
      if (node.type !== 'ImportDeclaration') {
        report(
          node,
          'Effect re-exports and dynamic loading hide execution ownership. Use static imports.',
        );
        return;
      }
      for (const specifier of node.specifiers) {
        const name = specifier.imported?.name ?? specifier.imported?.value;
        if (module === null && options.dataOnly && !allowedDataModules.has(name))
          report(
            specifier,
            'Data-only entries import schema modules and explicitly approved construction dependencies only.',
          );
        if (name && execution(module, name)) {
          const operation = `${module}.${name}`;
          if (options.operations?.includes(operation)) bindings.push({ specifier, operation });
          else checkExecution(specifier, operation);
        } else if (
          specifier.type === 'ImportNamespaceSpecifier' ||
          (module === null && coreModules.has(name))
        ) {
          bindings.push({ specifier, module: module ?? (name || 'root') });
        }
      }
    }
    function checkExecution(node, operation) {
      if (!options.operations?.includes(operation)) {
        report(node, `Execute ${operation} only in a declared Effect root or migration bridge.`);
        return;
      }
      if (node.parent.type !== 'CallExpression' || node.parent.callee !== node) {
        report(node, 'Invoke execution APIs directly so bridge tags identify the execution site.');
        return;
      }
      used.add(operation);
      if (options.removalSlice) {
        const adjacent = bridgeComments.filter(
          ({ comment, slices }) =>
            comment.loc.end.line === node.loc.start.line - 1 &&
            slices.includes(options.removalSlice),
        );
        if (adjacent.length === 0)
          report(node, 'Bridge execution needs an adjacent matching EFFECT-BRIDGE(Sx) tag.');
        for (const { comment } of adjacent) taggedComments.add(comment);
      }
    }
    function inspectReference(identifier, module) {
      const parent = identifier.parent;
      if (parent.type !== 'MemberExpression' || parent.object !== identifier) {
        // Type positions cannot execute code.
        if (
          ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression'].includes(parent.type)
        ) {
          inspectReference(parent, module);
          return;
        }
        if (['TSQualifiedName', 'TSTypeQuery', 'TSTypeReference'].includes(parent.type)) return;
        report(
          identifier,
          'Keep Effect namespace access explicit; do not alias, destructure or pass namespaces.',
        );
        return;
      }
      const name = memberName(parent);
      if (typeof name !== 'string') {
        report(parent, 'Effect namespace keys must be static.');
        return;
      }
      if (module === 'root') {
        if (options.dataOnly && !allowedDataModules.has(name))
          report(parent, 'Data-only entries cannot access this Effect module.');
        inspectReference(parent, name);
      } else if (execution(module, name)) checkExecution(parent, `${module}.${name}`);
    }
    return {
      ImportDeclaration: checkImport,
      ExportNamedDeclaration: checkImport,
      ExportAllDeclaration: checkImport,
      ImportExpression(node) {
        if (node.source.type !== 'Literal')
          report(node, 'Computed import paths are banned repo-wide so import boundaries can be checked.');
        else checkImport(node);
      },
      CallExpression(node) {
        if (node.callee.name === 'require') {
          const value = node.arguments[0]?.value;
          if (
            options.browser &&
            typeof value === 'string' &&
            (/^(node:|bun:)/.test(value) || builtinModules.includes(value))
          )
            report(node, 'Browser entries cannot require runtime built-ins.');
          if (typeof value !== 'string' || value === 'effect' || value.startsWith('effect/') || value.startsWith('@effect/'))
            report(node, typeof value !== 'string'
              ? 'Computed require paths are banned repo-wide so import boundaries can be checked.'
              : 'Use static imports for Effect ownership; companion packages need an architecture decision.');
        }
      },
      'Program:exit'(program) {
        for (const { specifier, module, operation } of bindings) {
          const variable = resolveVariable(source, specifier.local);
          for (const reference of variable?.references ?? [])
            operation
              ? checkExecution(reference.identifier, operation)
              : inspectReference(reference.identifier, module);
        }
        for (const operation of options.operations ?? []) {
          if (!used.has(operation))
            report(program, `Unused execution ledger operation: ${operation}.`);
        }
        for (const { comment, slices } of bridgeComments) {
          for (const slice of slices) {
            if (!options.removalSlice || slice !== options.removalSlice)
              report(comment, 'Bridge tag has no matching migration ledger entry.');
            else if (!taggedComments.has(comment))
              report(comment, 'Bridge tag has no adjacent execution operation.');
          }
        }
      },
    };
  },
};

export { coreModules, effectBoundariesRule };
