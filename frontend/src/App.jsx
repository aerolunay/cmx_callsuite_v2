import { Routes, Route } from "react-router-dom";
import LoginPage from "./pages/LoginPage";
import LandingPage from "./pages/LandingPage";
import CampaignSelectPage from "./pages/CampaignSelectPage";
import DialerPage from "./pages/DialerPage";
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
    </Routes>
  );
}
