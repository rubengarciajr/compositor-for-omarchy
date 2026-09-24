/** Identity of the Linux build, shown in Help › About and used by Report a Bug. */
export const APP_NAME = "Compositor for Omarchy";
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

/** The original app and its creator: the Linux port is a rebuild of Robbie Tilton's Compositor for macOS. */
export const ORIGINAL_AUTHOR = "Robbie Tilton";
export const ORIGINAL_COMPANY = "Wonder Assembly LLC";
export const ORIGINAL_SITE_URL = "https://robbietilton.com/compositor";
export const ORIGINAL_REPO_URL = "https://github.com/robbietilton/Compositor";

/** The Linux port's home. Change these when the port moves to its own repository. */
export const PROJECT_URL: string = "https://github.com/rubengarciajr/compositor-for-omarchy";
export const ISSUES_URL = `${PROJECT_URL}/issues/new`;

/** "Chromium 153" from the user agent, for bug reports. */
export function rendererName(): string {
  const m = navigator.userAgent.match(/(Chrome|Chromium)\/(\d+)/);
  return m ? `Chromium ${m[2]}` : "unknown renderer";
}
