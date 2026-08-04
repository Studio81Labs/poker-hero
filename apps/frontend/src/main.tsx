import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import {
  AppErrorBoundary,
  configureBrowserErrorMonitoring,
} from "./errorMonitoring";

configureBrowserErrorMonitoring();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
