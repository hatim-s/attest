const FORBIDDEN_SYMBOL_NAME = "shape";
function containsForbiddenSymbolName(name) {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}
function isBorrowedMemberName(node) {
  const parent = node.parent;
  if (parent === null || parent.type !== "MemberExpression")
    return false;
  return parent.property === node && parent.computed === false;
}
export const noForbiddenTermInSymbolNamesRule = {
  meta: {
    type: "problem",
    docs: {
      description: 'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.'
    },
    messages: {
      forbiddenSymbolName: 'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.'
    }
  },
  create(context) {
    const reportForbiddenSymbolName = (node) => {
      if (!containsForbiddenSymbolName(node.name) || isBorrowedMemberName(node))
        return;
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name }
      });
    };
    return {
      Identifier: reportForbiddenSymbolName,
      PrivateIdentifier: reportForbiddenSymbolName,
      JSXIdentifier: reportForbiddenSymbolName
    };
  }
};
