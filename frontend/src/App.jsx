import { Routes, Route } from "react-router-dom";
import LoginPage from "./pages/LoginPage";
import LandingPage from "./pages/LandingPage";
import CampaignSelectPage from "./pages/CampaignSelectPage";
import DialerPage from "./pages/DialerPage";
import AdminPage from "./pages/AdminPage";
import LiveStatusDashboard from "./pages/LiveStatusDashboard";
import ReportsPage from "./pages/ReportsPage";
import RecordingsPage from "./pages/RecordingsPage";
import VoicemailsPage from "./pages/VoicemailsPage";
import VoicemailPlayerPage from "./pages/VoicemailPlayerPage";
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
      <Route
        path="/voicemails"
        element={
          <ProtectedRoute>
            <VoicemailsPage />
          </ProtectedRoute>
        }
      />
      {/* Standalone single-voicemail player — this is what the email
          notification's "Listen to Voicemail" link actually points
          at, per explicit request ("send a link... which they can
          directly play on a browser, new page"). A real route (not a
          modal opened from a list), since the recipient is landing
          here directly from their email client, not navigating from
          within the app. Still fully access-controlled — the page's
          own load calls the same session-authenticated
          playback-url endpoint the list page uses, re-validating this
          viewer's role/campaign access at open-time regardless of
          whether they arrived via the list or via this direct link. */}
      <Route
        path="/voicemails/:voicemailLogId"
        element={
          <ProtectedRoute>
            <VoicemailPlayerPage />
          </ProtectedRoute>
        }
      />
    </Routes>
    </>
  );
}
