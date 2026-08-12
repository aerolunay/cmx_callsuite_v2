import { createContext, useContext, useEffect, useState } from "react";
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

  return (
    <AuthContext.Provider value={{ agent, loading, login, logout, setTotpEnabled }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
