/** Lets the crash subprocess follow emitted `.js` specifiers back to TypeScript source files. */
const resolve = async (specifier, context, nextResolve) => {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }

    throw error;
  }
};

export { resolve };
