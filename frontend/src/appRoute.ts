export function isWorkspaceRoute(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/") || pathname.startsWith("/auth/callback");
}
