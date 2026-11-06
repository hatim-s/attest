import { useEffect, useState } from 'react';
import type { ShellTarget } from './navigation.js';
import {
  browserStorage,
  contextualRecents,
  readRecents,
  rememberTarget,
  writeRecents,
} from './preferences.js';

/** Record completed navigation supplied by the router, never speculative clicks. */
const useRecents = (current: ShellTarget) => {
  const [recents, setRecents] = useState(() => readRecents(browserStorage()));
  useEffect(() => {
    setRecents((previous) => {
      const next = rememberTarget(previous, current);
      writeRecents(browserStorage(), next);

      return next;
    });
  }, [current]);

  return contextualRecents(recents, current);
};

export { useRecents };
