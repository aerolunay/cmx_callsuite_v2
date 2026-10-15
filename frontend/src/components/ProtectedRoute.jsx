import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import LoadingSpinner from "./LoadingSpinner";

export default function ProtectedRoute({ children }) {
  const { agent, loading } = useAuth();

  if (loading) {
    return <LoadingSpinner />;
  }

  if (!agent) {
    return <Navigate to="/login" replace />;
  }

  return children;
}
