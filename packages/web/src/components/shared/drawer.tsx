import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './ui.js';

type DrawerProps = {
  /** Names the dialog for assistive technology. */
  label: string;
  eyebrow: ReactNode;
  title: ReactNode;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
};

/**
 * Modal side panel. Escape, a click on the backdrop and the Close button all call `onClose`; the
 * caller decides what closing means, so a routed drawer can navigate and a form can unmount.
 */
const Drawer = ({ label, eyebrow, title, closeLabel, onClose, children }: DrawerProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef(document.activeElement);
  useEffect(() => {
    const dialog = dialogRef.current;
    // The native dialog traps focus and restores it when the panel closes.
    dialog?.showModal();

    return () => {
      dialog?.close();

      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, []);

  return (
    <dialog
      className="drawer-backdrop"
      aria-label={label}
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        aria-label={label}
        className="case-drawer"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-header">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h3>{title}</h3>
          </div>
          <Button aria-label={closeLabel} onClick={onClose} tone="ghost">
            Close
          </Button>
        </header>
        {children}
      </aside>
    </dialog>
  );
};

export { Drawer };
