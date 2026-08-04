import React from "react";
import ReactDOM from "react-dom/client";

import "./App.css";
import {
  AppErrorBoundary,
  captureBrowserException,
  configureBrowserErrorMonitoring,
  FatalError,
} from "./errorMonitoring";

async function bootstrap() {
  await configureBrowserErrorMonitoring();
  const root = ReactDOM.createRoot(document.getElementById("root")!);

  try {
    const { default: App } = await import("./App");
    root.render(
      <React.StrictMode>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </React.StrictMode>,
    );
  } catch (error) {
    captureBrowserException(error, "application_bootstrap");
    root.render(<FatalError />);
  }
}

void bootstrap();
