export function unwrapArrayExpression(node) {
  while (node.type === "ParenthesizedExpression" || node.type === "ChainExpression" || node.type === "TSAsExpression" || node.type === "TSTypeAssertion" || node.type === "TSNonNullExpression" || node.type === "TSSatisfiesExpression") {
    node = node.expression;
  }
  return node;
}
export function resolveArrayBinding(sourceCode, node) {
  node = unwrapArrayExpression(node);
  if (node.type !== "Identifier")
    return null;
  let scope = sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(node.name);
    if (variable !== undefined)
      return variable;
    scope = scope.upper;
  }
  return null;
}
export function arrayMethodTarget(node) {
  node = unwrapArrayExpression(node);
  if (node.type !== "MemberExpression")
    return null;
  const property = node.property;
  if (!node.computed && property.type === "Identifier") {
    return { name: property.name, object: node.object };
  }
  if (node.computed && property.type === "Literal" && typeof property.value === "string") {
    return { name: property.value, object: node.object };
  }
  return null;
}
function isArrayAnnotation(type) {
  if (type.type === "TSArrayType" || type.type === "TSTupleType")
    return true;
  if (type.type === "TSParenthesizedType")
    return isArrayAnnotation(type.typeAnnotation);
  if (type.type === "TSTypeOperator" && type.operator === "readonly") {
    return isArrayAnnotation(type.typeAnnotation);
  }
  return type.type === "TSTypeReference" && type.typeName.type === "Identifier" && (type.typeName.name === "Array" || type.typeName.name === "ReadonlyArray");
}
export function isKnownArrayExpression(sourceCode, node, visited = new Set) {
  node = unwrapArrayExpression(node);
  if (node.type === "ArrayExpression")
    return true;
  if (node.type === "CallExpression") {
    const method = arrayMethodTarget(node.callee);
    return method !== null && ["map", "filter", "flatMap", "slice", "concat", "toSorted", "toReversed", "toSpliced"].includes(method.name) && isKnownArrayExpression(sourceCode, method.object, visited);
  }
  if (node.type !== "Identifier")
    return false;
  const variable = resolveArrayBinding(sourceCode, node);
  if (variable === null || visited.has(variable))
    return false;
  visited.add(variable);
  if (variable.references.some((reference) => reference.isWrite() && !reference.init))
    return false;
  for (const identifier of variable.identifiers) {
    const annotation = identifier.typeAnnotation?.typeAnnotation;
    if (annotation !== undefined)
      return isArrayAnnotation(annotation);
  }
  for (const definition of variable.defs) {
    if (definition.type === "Variable" && definition.node.type === "VariableDeclarator" && definition.node.id.type === "Identifier" && definition.node.init !== null && definition.node.parent.type === "VariableDeclaration" && definition.node.parent.kind === "const") {
      return isKnownArrayExpression(sourceCode, definition.node.init, visited);
    }
  }
  return false;
}
