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
import InboundCallRedirector from "./components/InboundCallRedirector";

export default function App() {
  return (
    <>
      {/* Per explicit request — auto-redirects to /dialer the instant
          a call starts ringing for this agent, regardless of which
          page they're currently on. Needs to be inside the Router
          (for useNavigate/useLocation) but not tied to any single
          route, so it sits alongside <Routes> rather than inside any
          one of them. */}
      <InboundCallRedirector />
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
    </>
  );
}
