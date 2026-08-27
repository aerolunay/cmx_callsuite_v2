import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { AuthProvider } from "./context/AuthContext.jsx";
import { DialerSocketProvider } from "./context/DialerSocketContext.jsx";
import { PhoneProvider } from "./context/PhoneContext.jsx";
import "./styles/theme.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <DialerSocketProvider>
          <PhoneProvider>
            <App />
          </PhoneProvider>
        </DialerSocketProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
