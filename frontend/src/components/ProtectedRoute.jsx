import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function ProtectedRoute({ children }) {
  const { agent, loading } = useAuth();

  if (loading) {
    return <p style={{ padding: 24 }}>Loading…</p>;
  }

  if (!agent) {
    return <Navigate to="/login" replace />;
  }

  return children;
}
