export function containsUnknownType(type) {
  if (type.type === "TSUnknownKeyword")
    return true;
  if (type.type === "TSParenthesizedType")
    return containsUnknownType(type.typeAnnotation);
  return type.type === "TSUnionType" && type.types.some(containsUnknownType);
}
export function functionParameterTypeAnnotation(parameter) {
  if (parameter.type === "TSParameterProperty") {
    return functionParameterTypeAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? functionParameterTypeAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? functionParameterTypeAnnotation(parameter.left);
  }
  return parameter.typeAnnotation;
}
export function functionParameterBindingName(parameter, sourceCode) {
  if (parameter.type === "TSParameterProperty") {
    return functionParameterBindingName(parameter.parameter, sourceCode);
  }
  if (parameter.type === "AssignmentPattern") {
    return functionParameterBindingName(parameter.left, sourceCode);
  }
  if (parameter.type === "RestElement") {
    return functionParameterBindingName(parameter.argument, sourceCode);
  }
  if (parameter.type === "Identifier")
    return parameter.name;
  const sourceText = sourceCode.getText(parameter);
  const annotationStart = parameter.typeAnnotation?.range[0];
  return annotationStart === undefined ? sourceText : sourceText.slice(0, annotationStart - parameter.range[0]).trimEnd();
}
