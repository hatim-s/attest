import {
  createTypeAliasEnvironment,
  resolvedTypeMatches
} from "../shared/type-alias-resolution.mjs";
export const noUnknownTypeAliasesRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow type aliases whose resolved type is unknown; unknown must remain visible at an allowed boundary."
    },
    messages: {
      unknownAlias: "Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type."
    }
  },
  create(context) {
    let environment = null;
    const resolvesToUnknown = (type) => environment !== null && resolvedTypeMatches(type, environment, (resolved, matches) => {
      if (resolved.type === "TSUnknownKeyword")
        return true;
      if (resolved.type === "TSParenthesizedType") {
        return matches(resolved.typeAnnotation);
      }
      return resolved.type === "TSUnionType" && resolved.types.some(matches);
    });
    return {
      Program(node) {
        environment = createTypeAliasEnvironment(node, context.sourceCode.visitorKeys);
      },
      TSTypeAliasDeclaration(node) {
        if (!resolvesToUnknown(node.typeAnnotation))
          return;
        context.report({
          node: node.id,
          messageId: "unknownAlias",
          data: { alias: node.id.name }
        });
      }
    };
  }
};
