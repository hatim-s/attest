/** Lets the crash subprocess follow emitted `.js` specifiers back to TypeScript source files. */
const resolve = async (specifier, context, nextResolve) => {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code === 'ERR_MODULE_NOT_FOUND' &&
      specifier.startsWith('.') &&
      specifier.endsWith('.js')
    ) {
      try {
        return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        throw error;
      }
    }

    throw error;
  }
};

export { resolve };
