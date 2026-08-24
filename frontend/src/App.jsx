import { Routes, Route } from "react-router-dom";
import LoginPage from "./pages/LoginPage";
import LandingPage from "./pages/LandingPage";
import CampaignSelectPage from "./pages/CampaignSelectPage";
import DialerPage from "./pages/DialerPage";
import AdminPage from "./pages/AdminPage";
import LiveStatusDashboard from "./pages/LiveStatusDashboard";
import ReportsPage from "./pages/ReportsPage";
import RecordingsPage from "./pages/RecordingsPage";
import ProtectedRoute from "./components/ProtectedRoute";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <LandingPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/select-campaign"
        element={
          <ProtectedRoute>
            <CampaignSelectPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/dialer"
        element={
          <ProtectedRoute>
            <DialerPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AdminPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/live-status"
        element={
          <ProtectedRoute>
            <LiveStatusDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/reports"
        element={
          <ProtectedRoute>
            <ReportsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/recordings"
        element={
          <ProtectedRoute>
            <RecordingsPage />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
