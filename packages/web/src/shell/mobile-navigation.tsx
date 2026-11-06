import { useEffect, useRef, type ReactNode } from 'react';

type MobileNavigationProps = { children: ReactNode; onClose: () => void };

/** Native modal isolates the background and traps focus; close restores the opener. */
const MobileNavigation = ({ children, onClose }: MobileNavigationProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    const breakpoint = window.matchMedia('(min-width: 761px)');

    const closeOnDesktop = () => {
      if (breakpoint.matches) onClose();
    };

    breakpoint.addEventListener('change', closeOnDesktop);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      breakpoint.removeEventListener('change', closeOnDesktop);
      document.body.style.overflow = previousOverflow;
      dialog?.close();

      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      className="attest-mobile-dialog"
      aria-label="Navigation"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="attest-mobile-panel">
        <div className="attest-side-head">
          <span className="attest-wordmark">attest</span>
          <button type="button" onClick={onClose} aria-label="Close navigation">
            Close
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
};

export { MobileNavigation };
