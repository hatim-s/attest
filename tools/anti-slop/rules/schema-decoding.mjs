const decodingMethods = new Set([
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

/** Keep schema execution in contracts while allowing unrelated parsers. */
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
    const services = context.sourceCode.parserServices;
    const checker = services?.program?.getTypeChecker();
    const typeOf = (node) => checker?.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
    function propertyNames(key, computed) {
      if (!computed) return [key.name ?? key.value];
      if (typeof key.value === 'string') return [key.value];
      const type = typeOf(key);
      const types = type?.isUnion() ? type.types : [type];
      return types.filter((part) => part?.isStringLiteral()).map((part) => part.value);
    }
    function checkProperty(node, object, key, computed) {
      if (!checker || !services.esTreeNodeToTSNodeMap) return;
      const names = propertyNames(key, computed).filter((name) => decodingMethods.has(name));
      if (names.length === 0) return;
      const type = checker.getNonNullableType(typeOf(object));
      const zodMethod = names.some((name) =>
        type
          .getProperty(name)
          ?.declarations?.some((declaration) =>
            /[/\\]zod[/\\]/.test(declaration.getSourceFile().fileName),
          ),
      );
      if (type.getProperty('_zod') || zodMethod) context.report({ node, messageId: 'owner' });
    }
    return {
      ImportSpecifier(node) {
        const name = node.imported.name ?? node.imported.value;
        const source = node.parent.source.value;
        if (/^zod(?:\/|$)/.test(source) && decodingMethods.has(name))
          context.report({ node, messageId: 'owner' });
      },
      ExportSpecifier(node) {
        const source = node.parent.source?.value;
        const name = node.local.name ?? node.local.value;
        if (typeof source === 'string' && /^zod(?:\/|$)/.test(source) && decodingMethods.has(name))
          context.report({ node, messageId: 'owner' });
      },
      VariableDeclarator(node) {
        if (node.id.type !== 'ObjectPattern' || !node.init) return;
        for (const property of node.id.properties) {
          if (property.type === 'Property')
            checkProperty(property, node.init, property.key, property.computed);
        }
      },
      MemberExpression(node) {
        checkProperty(node, node.object, node.property, node.computed);
      },
    };
  },
};

export { schemaDecodingRule };
