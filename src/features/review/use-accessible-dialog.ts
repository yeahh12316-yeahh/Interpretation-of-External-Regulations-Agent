import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

const focusableSelector =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const useAccessibleDialog = <T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
): {
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<T | null>;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
} => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<T>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    initialFocusRef.current?.focus();
    return () => openerRef.current?.focus();
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [
      ...dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector),
    ];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return { dialogRef, initialFocusRef, onKeyDown };
};
