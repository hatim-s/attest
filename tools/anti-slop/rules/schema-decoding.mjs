import { resolveVariable } from '../shared/scope.mjs';

// Installed Effect 4.1.2 Schema and SchemaParser execution adapters. decode/decodeTo
// construct transformations; Standard Schema adapters belong to foreign integrations.
const nativeDecoders = new Set([
  'is',
  'asserts',
  ...['Effect', 'Exit', 'Option', 'Result', 'Promise', 'Sync'].flatMap((suffix) => [
    `decode${suffix}`,
    `decodeUnknown${suffix}`,
  ]),
]);

const legacyMethods = new Set([
  'parse',
  'safeParse',
  'parseAsync',
  'safeParseAsync',
  'spa',
  'decode',
  'safeDecode',
  'decodeAsync',
  'safeDecodeAsync',
  'encode',
  'safeEncode',
  'encodeAsync',
  'safeEncodeAsync',
]);

const nativeModule = (source) => /^effect\/(Schema|SchemaParser)$/.test(source);

const legacyModule = (source) => /^zod(?:\/|$)/.test(source);

const nativeFile = (file) =>
  /[/\\]effect[/\\](?:src|dist(?:[/\\](?:dts|esm))?)[/\\]Schema(?:Parser)?\.(?:d\.ts|ts|js)$/.test(
    file,
  );

/** Keep decoder references in contracts while allowing constructors and unrelated parsers. */
const schemaDecodingRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      owner:
        'Decode schemas through @attest/contracts parseWithSchema, parseWithSchemaEffect or parseWithSchemaSync.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    const services = source.parserServices;
    const checker = services?.program?.getTypeChecker();
    const typeOf = (node) => checker?.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
    const reported = new WeakSet();

    const report = (node) => {
      if (reported.has(node)) return;
      reported.add(node);
      context.report({ node, messageId: 'owner' });
    };

    /** Resolve only imported namespaces and their simple aliases in untyped files. */
    function namespace(node, seen = new Set()) {
      if (node?.type === 'ChainExpression') return namespace(node.expression, seen);

      if (node?.type === 'MemberExpression') {
        const name = node.computed ? node.property.value : node.property.name;

        return namespace(node.object, seen) === 'effect' &&
          ['Schema', 'SchemaParser'].includes(name)
          ? 'native'
          : null;
      }

      if (node?.type !== 'Identifier') return null;
      const variable = resolveVariable(source, node);

      if (!variable || seen.has(variable)) return null;
      seen.add(variable);

      for (const definition of variable.defs) {
        const specifier = definition.node;

        if (definition.type === 'ImportBinding') {
          const module = definition.parent.source.value;

          if (specifier.type === 'ImportNamespaceSpecifier') {
            if (nativeModule(module)) return 'native';

            if (module === 'effect') return 'effect';

            if (legacyModule(module)) return 'legacy';
          }

          if (specifier.type === 'ImportSpecifier') {
            const name = specifier.imported.name ?? specifier.imported.value;

            if (module === 'effect' && ['Schema', 'SchemaParser'].includes(name)) return 'native';

            if (legacyModule(module) && ['z', 'default'].includes(name)) return 'legacy';
          }
        }

        if (definition.type === 'Variable' && specifier.init)
          return namespace(specifier.init, seen);
      }

      return null;
    }

    function propertyNames(key, computed) {
      if (!computed) return [key.name ?? key.value];

      if (key.type === 'Literal') return [key.value];
      const type = typeOf(key);

      return (type?.isUnion() ? type.types : [type])
        .filter((part) => part?.isStringLiteral())
        .map((part) => part.value);
    }

    /** Function type symbols retain the declaring API through aliases and object fields. */
    function nativeFunction(type) {
      if (!type || !checker) return false;

      if (type.isUnionOrIntersection()) return type.types.some(nativeFunction);
      const symbol = type.getSymbol();

      return (
        symbol?.declarations?.some(
          (declaration) =>
            nativeFile(declaration.getSourceFile().fileName) &&
            nativeDecoders.has(declaration.name?.text),
        ) ?? false
      );
    }

    function forbiddenProperty(type, name) {
      if (!type || !checker) return false;
      type = checker.getNonNullableType(type);

      if (type.isUnionOrIntersection())
        return type.types.some((part) => forbiddenProperty(part, name));
      const property = type.getProperty(name);

      if (!property) return false;

      if (
        property.declarations?.some((declaration) => {
          const file = declaration.getSourceFile().fileName;

          return (
            (nativeFile(file) && nativeDecoders.has(declaration.name?.text)) ||
            (legacyMethods.has(name) && /[/\\]zod[/\\]/.test(file))
          );
        })
      )
        return true;

      return nativeFunction(
        checker.getTypeOfSymbolAtLocation(
          property,
          property.valueDeclaration ??
            property.declarations?.[0] ??
            services.esTreeNodeToTSNodeMap.get(source.ast),
        ),
      );
    }

    /** Read the yielded value for assignment loops whose targets have no type yet. */
    function iteratorElements(node) {
      if (!checker) return [];
      const type = typeOf(node);
      const indexed = checker.getIndexTypeOfType(type, 1);

      if (indexed) return [indexed];
      const location = services.esTreeNodeToTSNodeMap.get(node);

      const iterator = type
        .getProperties()
        .find((property) => property.name.startsWith('__@iterator@'));

      if (!iterator) return [];
      const method = checker.getTypeOfSymbolAtLocation(iterator, location).getCallSignatures()[0];
      const next = method?.getReturnType().getProperty('next');

      if (!next) return [];
      const signature = checker.getTypeOfSymbolAtLocation(next, location).getCallSignatures()[0];
      const result = signature?.getReturnType();

      if (!result) return [];

      // IteratorResult's completed branch may return any. Only yielded values
      // reach a for-of binding, so keep the yield branch before reading value.
      return (result.isUnion() ? result.types : [result]).flatMap((part) => {
        const done = part.getProperty('done');

        if (
          done &&
          checker.typeToString(checker.getTypeOfSymbolAtLocation(done, location)) === 'true'
        )
          return [];
        const value = part.getProperty('value');

        return value ? [checker.getTypeOfSymbolAtLocation(value, location)] : [];
      });
    }

    /** Patterns carry contextual types even in parameters, loops and nested bindings. */
    function checkPattern(pattern, type, origin) {
      if (pattern.type === 'AssignmentPattern') return checkPattern(pattern.left, type, origin);

      if (pattern.type === 'ArrayPattern') {
        for (const element of pattern.elements) if (element) checkPattern(element, typeOf(element));
      }

      if (pattern.type !== 'ObjectPattern') return;

      for (const property of pattern.properties) {
        if (property.type !== 'Property') continue;
        const names = propertyNames(property.key, property.computed);

        if (
          names.some(
            (name) =>
              forbiddenProperty(type, name) ||
              (namespace(origin) === 'native' && nativeDecoders.has(name)) ||
              (namespace(origin) === 'legacy' && legacyMethods.has(name)),
          )
        )
          report(property);
        // Nested bindings have their own contextual type; assignments instead use
        // the RHS property because an unannotated target may still be any.
        const child = type && checker?.getNonNullableType(type).getProperty(names[0]);

        const childType = child
          ? checker.getTypeOfSymbolAtLocation(child, services.esTreeNodeToTSNodeMap.get(property))
          : typeOf(property.value);

        checkPattern(property.value, childType);
      }
    }

    return {
      ImportSpecifier(node) {
        if (node.importKind === 'type' || node.parent.importKind === 'type') return;
        const name = node.imported.name ?? node.imported.value;
        const module = node.parent.source.value;

        if (
          (nativeModule(module) && nativeDecoders.has(name)) ||
          (legacyModule(module) && legacyMethods.has(name))
        )
          report(node);
      },
      ExportSpecifier(node) {
        if (node.exportKind === 'type' || node.parent.exportKind === 'type') return;
        const module = node.parent.source?.value;
        const name = node.local.name ?? node.local.value;

        if (
          (nativeModule(module) && nativeDecoders.has(name)) ||
          (module && legacyModule(module) && legacyMethods.has(name)) ||
          (!module && nativeFunction(typeOf(node.local)))
        )
          report(node);
      },
      ExportAllDeclaration(node) {
        const module = node.source.value;

        if (
          node.exportKind !== 'type' &&
          (nativeModule(module) || module === 'effect' || legacyModule(module))
        )
          report(node);
      },
      VariableDeclarator(node) {
        if (node.id.type.endsWith('Pattern')) checkPattern(node.id, typeOf(node.id), node.init);
      },
      AssignmentExpression(node) {
        if (node.left.type.endsWith('Pattern'))
          checkPattern(node.left, typeOf(node.right), node.right);
      },
      ForOfStatement(node) {
        if (node.left.type === 'ObjectPattern') {
          for (const element of iteratorElements(node.right)) checkPattern(node.left, element);
        }
      },
      AssignmentPattern(node) {
        if (node.left.type === 'ObjectPattern' && node.parent.type !== 'Property')
          checkPattern(node.left, typeOf(node.left), node.right);
      },
      ObjectPattern(node) {
        // Declarations/assignments above supply the RHS for syntax-only checks.
        if (
          ![
            'VariableDeclarator',
            'AssignmentExpression',
            'Property',
            'AssignmentPattern',
            'ForOfStatement',
          ].includes(node.parent.type)
        )
          checkPattern(node, typeOf(node));
      },
      MemberExpression(node) {
        const names = propertyNames(node.property, node.computed);
        const module = namespace(node.object);

        if (
          names.some(
            (name) =>
              forbiddenProperty(typeOf(node.object), name) ||
              (module === 'native' && nativeDecoders.has(name)) ||
              (module === 'legacy' && legacyMethods.has(name)),
          )
        )
          report(node);
      },
    };
  },
};

export { schemaDecodingRule };
