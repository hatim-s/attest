import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { targetKey, type ShellTarget } from './navigation.js';
import {
  browserStorage,
  contextualRecents,
  readRecents,
  rememberTarget,
  writeRecents,
} from './preferences.js';

/** Record committed deep locations once per semantic navigation, outside React updaters. */
const useRecents = (current: ShellTarget) => {
  const [recents, setRecents] = useState(() => readRecents(browserStorage()));
  const latest = useRef(recents);
  const lastRecorded = useRef<string | undefined>(undefined);
  const key = targetKey(current);

  const record = useEffectEvent(() => {
    if (lastRecorded.current === key) return;
    lastRecorded.current = key;

    if (
      current.kind === 'projects' ||
      current.kind === 'project' ||
      current.kind === 'project-runs' ||
      current.kind === 'runs' ||
      current.kind === 'cases'
    )
      return;
    const next = rememberTarget(latest.current, current);

    if (JSON.stringify(next) === JSON.stringify(latest.current)) return;
    latest.current = next;
    writeRecents(browserStorage(), next);
    setRecents(next);
  });

  useEffect(() => {
    record();
  }, [key]);

  return contextualRecents(recents, current);
};

export { useRecents };
