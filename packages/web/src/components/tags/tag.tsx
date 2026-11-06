import '../../styles/compact/tags.css';

const hues = ['blue', 'teal', 'violet', 'moss', 'plum', 'steel', 'cyan'] as const;

/** Stable name-based colours, independent of row order or filter selection. */
const tagHue = (name: string) => {
  let hash = 2166136261;

  for (const character of name) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;

  return hues[hash % hues.length] ?? 'blue';
};

/** Colour supplements the visible label and never conveys a verdict. */
const Tag = ({ name }: { name: string }) => (
  <span className="attest-tag" data-hue={tagHue(name)}>
    {name}
  </span>
);

/** Preserve domain order while suppressing duplicate labels. */
const Tags = ({ names }: { names: readonly string[] }) => (
  <span className="attest-tags">
    {[...new Set(names)].map((name) => (
      <Tag key={name} name={name} />
    ))}
  </span>
);

export { Tag, Tags, tagHue };
