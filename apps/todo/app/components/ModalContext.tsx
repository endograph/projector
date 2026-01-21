"use client";

import {
  createContext,
  useContext,
  useRef,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { useRouter, usePathname } from "next/navigation";

// Define which path patterns are modal routes
const MODAL_PATTERNS = [/^\/dev(\/|$)/];

function isModalRoute(path: string): boolean {
  return MODAL_PATTERNS.some((pattern) => pattern.test(path));
}

interface ModalContextValue {
  closeModal: (fallback?: string) => void;
}

const ModalContext = createContext<ModalContextValue | null>(null);

export function ModalProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const lastNonModalPath = useRef<string>("/");
  const enteredViaInterception = useRef<boolean>(false);
  const prevPathname = useRef<string>(pathname);

  // Track navigation patterns
  useEffect(() => {
    const wasOnModal = isModalRoute(prevPathname.current);
    const isOnModal = isModalRoute(pathname);

    if (!wasOnModal && isOnModal) {
      // Entering modal from non-modal route = interception
      enteredViaInterception.current = true;
    } else if (!isOnModal) {
      // Left the modal
      enteredViaInterception.current = false;
      lastNonModalPath.current = pathname;
    }

    prevPathname.current = pathname;
  }, [pathname]);

  const closeModal = useCallback(
    (fallback: string = "/") => {
      if (enteredViaInterception.current) {
        // Came from within the app, safe to go back
        router.back();
      } else {
        // Direct navigation, go to fallback
        const returnPath = lastNonModalPath.current || fallback;
        router.replace(returnPath);
        router.refresh();
      }
    },
    [router]
  );

  return (
    <ModalContext.Provider value={{ closeModal }}>
      {children}
    </ModalContext.Provider>
  );
}

export function useModalClose() {
  const context = useContext(ModalContext);
  if (!context) {
    throw new Error("useModalClose must be used within ModalProvider");
  }
  return context.closeModal;
}
