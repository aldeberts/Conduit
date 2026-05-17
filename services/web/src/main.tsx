import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { App } from "./App";
import { ConnectionPage } from "./pages/ConnectionPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App>
        <Routes>
          <Route path="/" element={<ConnectionPage />} />
          <Route path="/workspace/:connectionId" element={<WorkspacePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </App>
    </BrowserRouter>
  </StrictMode>,
);
