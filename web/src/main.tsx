import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

// Capture auth token from URL (?token=...) and persist to localStorage
const params = new URLSearchParams(window.location.search);
const token = params.get("token");
if (token) {
  localStorage.setItem("grove-auth-token", token);
  // Clean token from URL to avoid accidental sharing
  params.delete("token");
  const clean = params.toString();
  window.history.replaceState({}, "", window.location.pathname + (clean ? `?${clean}` : ""));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
