import { createContext, useContext, type Accessor } from "solid-js";
import type { Actor } from "@takosjp/yurucommu-api";

export type ToastTone = "info" | "error";

export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export type AppContextValue = {
  /** The signed-in actor (guaranteed non-null inside the provider). */
  actor: Accessor<Actor>;
  /** The resolved server origin. */
  origin: Accessor<string>;
  /** Re-fetch the signed-in actor (e.g. after editing own profile). */
  refetchActor: () => void;
  /** Show a transient toast message. */
  toast: (message: string, tone?: ToastTone) => void;
  /** Ask the user to confirm an action with a styled in-app dialog. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Unread DM/community message count (nav badge). */
  unreadTalk: Accessor<number>;
  /** Unread notification count (nav badge). */
  unreadNotifications: Accessor<number>;
  /** Re-fetch both unread badge counts (call after read/mark-read actions). */
  refreshBadges: () => void;
};

const AppContext = createContext<AppContextValue>();

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("[yurume] useApp must be used within <AppProvider>");
  }
  return ctx;
}

export const AppProvider = AppContext.Provider;
