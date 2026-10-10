import { hasDocumentedBoundary } from "../shared/documented-boundary.mjs";
function isRuntimeFunction(node) {
  return node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration" || node.type === "FunctionExpression";
}
function isInsideTypeGuard(node) {
  let current = node.parent;
  while (current !== null && current.type !== "Program") {
    if (isRuntimeFunction(current)) {
      return current.returnType?.typeAnnotation.type === "TSTypePredicate";
    }
    current = current.parent;
  }
  return false;
}
function isExistenceProbe(node) {
  const parent = node.parent;
  if (parent.type !== "BinaryExpression")
    return false;
  if (!["===", "!==", "==", "!="].includes(parent.operator))
    return false;
  const other = parent.left === node ? parent.right : parent.left;
  return other.type === "Literal" && other.value === "undefined";
}
export const noRuntimeTypeofRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary."
    },
    messages: {
      runtimeTypeof: "A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value."
    },
    schema: [
      {
        type: "object",
        properties: {
          allowInTypeGuards: { type: "boolean" },
          allowDocumentedBoundaries: { type: "boolean" }
        },
        additionalProperties: false
      }
    ],
    defaultOptions: [{ allowInTypeGuards: false }]
  },
  create(context) {
    return {
      UnaryExpression(node) {
        if (hasDocumentedBoundary(context, node)) return;
        const option = context.options?.[0];
        const allowInTypeGuards = typeof option === "object" && option !== null && !Array.isArray(option) && option.allowInTypeGuards === true;
        if (node.operator === "typeof" && !isExistenceProbe(node) && (!allowInTypeGuards || !isInsideTypeGuard(node))) {
          context.report({ node, messageId: "runtimeTypeof" });
        }
      }
    };
  }
};
