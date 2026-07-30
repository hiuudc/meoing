import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGate } from "./auth/AuthGate";
import { AuthProvider } from "./auth/AuthProvider";
import { removeLegacyApplicationData } from "./integration/legacyCleanup";
import "./styles.css";

try {
  removeLegacyApplicationData(window.localStorage);
} catch {
  // Accessing localStorage itself may throw in locked-down browser contexts.
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </AuthProvider>
  </StrictMode>,
);
