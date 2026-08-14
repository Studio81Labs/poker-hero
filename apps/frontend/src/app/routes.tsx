import { Navigate, Route, Routes } from "react-router-dom";

import AnalyzerPage from "../pages/analyzer/AnalyzerPage";

export const appPaths = {
  analyzer: "/",
} as const;

export function AppRoutes() {
  return (
    <Routes>
      <Route path={appPaths.analyzer} element={<AnalyzerPage />} />
      <Route path="*" element={<Navigate to={appPaths.analyzer} replace />} />
    </Routes>
  );
}
