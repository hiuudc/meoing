import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isWorkspaceRoute } from "./appRoute";
import { AuthGate } from "./auth/AuthGate";
import { AuthProvider } from "./auth/AuthProvider";
import { LandingPage } from "./components/LandingPage";
import { removeLegacyApplicationData } from "./integration/legacyCleanup";
import "./styles.css";

const workspaceRoute = isWorkspaceRoute(window.location.pathname);

if (workspaceRoute) {
  try {
    removeLegacyApplicationData(window.localStorage);
  } catch {
    // Accessing localStorage itself may throw in locked-down browser contexts.
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {workspaceRoute ? (
      <AuthProvider>
        <AuthGate>
          <App />
        </AuthGate>
      </AuthProvider>
    ) : <LandingPage />}
  </StrictMode>,
);
