import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { targetKey, type ShellTarget } from './navigation.js';
import { browserStorage, contextualRecents, readRecents, recordRecent } from './preferences.js';

/** Record committed deep locations once per semantic navigation, outside React updaters. */
const useRecents = (current: ShellTarget) => {
  const [recents, setRecents] = useState(() => readRecents(browserStorage()));
  const latest = useRef(recents);
  const lastRecorded = useRef<string | undefined>(undefined);
  const key = targetKey(current);

  const record = useEffectEvent(() => {
    if (lastRecorded.current === key) return;
    lastRecorded.current = key;

    const next = recordRecent(browserStorage(), latest.current, current);

    if (JSON.stringify(next) === JSON.stringify(latest.current)) return;
    latest.current = next;
    setRecents(next);
  });

  useEffect(() => {
    record();
  }, [key]);

  return contextualRecents(recents, current);
};

export { useRecents };
