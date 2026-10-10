export const LINEBREAKS = new Set([`\r
`, "\r", `
`, "\u2028", "\u2029"]);
export const isClosingBraceToken = (token) => token.type === "Punctuator" && token.value === "}";
export const isSemicolonToken = (token) => token.type === "Punctuator" && token.value === ";";
export const isNotSemicolonToken = (token) => !isSemicolonToken(token);
export const isTokenOnSameLine = (left, right) => left.loc.end.line === right.loc.start.line;
export const isFunction = (node) => node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
export const isSingleLine = (node) => node.loc.start.line === node.loc.end.line;
export const skipChainExpression = (node) => node.type === "ChainExpression" ? node.expression : node;
export const isTopLevelExpressionStatement = (node) => node.type === "ExpressionStatement" && (node.parent.type === "Program" || node.parent.type === "BlockStatement" && isFunction(node.parent.parent));
export function isParenthesized(node, sourceCode) {
  const before = sourceCode.getTokenBefore(node);
  const after = sourceCode.getTokenAfter(node);
  return before?.value === "(" && after?.value === ")";
}
