export const APP_TITLE = "Yurumeet";

/** Build a consistent browser tab title for Yurumeet routes and talks. */
export function formatYurumeetTitle(section?: string | null): string {
  const clean = section?.trim();
  return clean ? `${clean} — ${APP_TITLE}` : APP_TITLE;
}
