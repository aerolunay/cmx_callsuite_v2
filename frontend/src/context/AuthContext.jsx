import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "../api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [agent, setAgent] = useState(null);
  const [loading, setLoading] = useState(true);

  // On first load, check for an existing session (e.g. page refresh)
  // rather than assuming the user is logged out.
  useEffect(() => {
    api
      .me()
      .then((data) => setAgent(data.agent))
      .catch(() => setAgent(null))
      .finally(() => setLoading(false));
  }, []);

  const login = (agentData) => setAgent(agentData);

  const logout = async () => {
    await api.logout().catch(() => {
      // Even if the server call fails, clear local state so the UI
      // doesn't strand the user in a logged-in-looking screen.
    });
    setAgent(null);
  };

  const setTotpEnabled = (enabled) => {
    setAgent((prev) => (prev ? { ...prev, totpEnabled: enabled } : prev));
  };

  // Per explicit request — picks up admin changes (phone login, access
  // level, ...) between calls without a browser refresh; the Dialer calls
  // this after every call. Keeps the same object when nothing changed, so
  // nothing keyed on `agent` (e.g. the phone registration) re-runs.
  const refreshAgent = useCallback(() => {
    return api
      .me()
      .then((data) => setAgent((prev) => (JSON.stringify(prev) === JSON.stringify(data.agent) ? prev : data.agent)))
      .catch((err) => {
        if (err.status === 401) setAgent(null); // deactivated / session gone — back to login
      });
  }, []);

  return (
    <AuthContext.Provider value={{ agent, loading, login, logout, setTotpEnabled, refreshAgent }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- useAuth deliberately lives alongside AuthProvider (same pattern as every other context in this app); splitting it into its own file would mean updating every import site across the whole codebase for a dev-only hot-reload warning with no production impact.
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
