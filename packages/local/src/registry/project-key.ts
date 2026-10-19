const MAX_KEY_LENGTH = 64;

/** Used when a name has no ASCII letters or digits to slug, such as a name in another script. */
const FALLBACK_KEY = 'project';

/** Lowercases `name`, turns each run of other characters into one dash and trims to 64. */
const slugProjectName = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_KEY_LENGTH)
    .replaceAll(/^-+|-+$/g, '');

  return slug.length === 0 ? FALLBACK_KEY : slug;
};

/**
 * Derives a key from `name` that no entry in `taken` uses, suffixing `-2`, `-3` and so on.
 * The base is shortened so the suffixed key still fits in 64 characters.
 */
const uniqueProjectKey = (name: string, taken: ReadonlySet<string>): string => {
  const base = slugProjectName(name);

  if (!taken.has(base)) return base;

  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${String(suffix)}`;
    const key = `${base.slice(0, MAX_KEY_LENGTH - tail.length).replace(/-+$/, '')}${tail}`;

    if (!taken.has(key)) return key;
  }
};

export { slugProjectName, uniqueProjectKey };
