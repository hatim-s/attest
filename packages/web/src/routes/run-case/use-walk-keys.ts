import { useEffect, useEffectEvent } from 'react';

/**
 * `j` opens the next case and `k` the previous one. Like the shell's own shortcut, it leaves
 * editors, modifiers, composition and repeats alone.
 */
const useWalkKeys = (onNext: () => void, onPrevious: () => void) => {
  const shortcut = useEffectEvent((event: KeyboardEvent) => {
    const editable =
      event.target instanceof Element &&
      event.target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]',
      );

    if (
      event.defaultPrevented ||
      event.repeat ||
      editable ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.isComposing
    )
      return;

    if (event.key === 'j') {
      event.preventDefault();
      onNext();
    }

    if (event.key === 'k') {
      event.preventDefault();
      onPrevious();
    }
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => shortcut(event);
    document.addEventListener('keydown', onKeyDown);

    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
};

export { useWalkKeys };
