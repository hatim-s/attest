const functionKinds = new Set([
  "ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression",
  "TSDeclareFunction", "TSFunctionType", "TSMethodSignature",
  "TSEmptyBodyFunctionExpression", "TSCallSignatureDeclaration",
]);

function commentOwner(node) {
  let owner = node;
  if (owner.parent?.type === "VariableDeclarator") owner = owner.parent;
  if (owner.type === "VariableDeclarator") owner = owner.parent;
  if (owner.parent?.type === "MethodDefinition" || owner.parent?.type === "Property") owner = owner.parent;
  if (owner.parent?.type === "ExportNamedDeclaration" || owner.parent?.type === "ExportDefaultDeclaration") owner = owner.parent;
  return owner;
}

/** Match an opt-in boundary declaration, never a file-level or inherited annotation. */
export function hasDocumentedBoundary(context, node) {
  if (context.options[0]?.allowDocumentedBoundaries !== true) return false;
  let owner = node;
  while (owner && owner.type !== "Program") {
    if (functionKinds.has(owner.type) || ["TSTypeAliasDeclaration", "TSInterfaceDeclaration", "VariableDeclarator"].includes(owner.type)) {
      owner = commentOwner(owner);
      return context.sourceCode.getCommentsBefore(owner).some((comment) =>
        comment.loc.end.line >= owner.loc.start.line - 1 && /\bBOUNDARY:\s*\S/u.test(comment.value),
      );
    }
    owner = owner.parent;
  }
  return false;
}

export const documentedBoundarySchema = [{
  type: "object",
  properties: { allowDocumentedBoundaries: { type: "boolean" } },
  additionalProperties: false,
}];
