import { hasDocumentedBoundary, documentedBoundarySchema } from "../shared/documented-boundary.mjs";
import {
  containsUnknownType,
  functionParameterBindingName,
  functionParameterTypeAnnotation
} from "../shared/function-parameters.mjs";
function isTypePredicateSubject(owner, parameterName) {
  const predicate = owner.returnType?.typeAnnotation;
  return predicate?.type === "TSTypePredicate" && predicate.parameterName.type === "Identifier" && predicate.parameterName.name === parameterName;
}
export const noUnknownParametersRule = {
  meta: {
    type: "problem",
    schema: documentedBoundarySchema,
    docs: {
      description: "Disallow explicitly unknown function parameters except `cause` and type-predicate subjects; decode unknown input at its I/O boundary instead."
    },
    messages: {
      unknownParameter: "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function."
    }
  },
  create(context) {
    const checkParameters = (node) => {
      if (hasDocumentedBoundary(context, node)) return;
      for (const parameter of node.params) {
        const annotation = functionParameterTypeAnnotation(parameter);
        if (annotation === null || annotation === undefined)
          continue;
        if (!containsUnknownType(annotation.typeAnnotation))
          continue;
        const name = functionParameterBindingName(parameter, context.sourceCode);
        if (name === "cause" || isTypePredicateSubject(node, name))
          continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name }
        });
      }
    };
    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters
    };
  }
};
