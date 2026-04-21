import { Routes, Route } from "react-router-dom";
import { detectLocale, getApiBaseUrl } from "./lib/browser";
import { copy } from "./lib/content";
import { HomePage } from "./pages/HomePage";
import { SuccessPage } from "./pages/SuccessPage";
import { CancelPage } from "./pages/CancelPage";
import { AdminPage } from "./pages/AdminPage";

export default function App() {
  const locale = detectLocale();
  const selectedCopy = copy[locale];
  const apiBaseUrl = getApiBaseUrl();

  return (
    <div className="bg-background text-on-surface min-h-screen flex flex-col overflow-x-hidden">
      <Routes>
        <Route path="/" element={<HomePage apiBaseUrl={apiBaseUrl} copy={selectedCopy} locale={locale} />} />
        <Route path="/success" element={<SuccessPage copy={selectedCopy} />} />
        <Route path="/cancel" element={<CancelPage copy={selectedCopy} />} />
        <Route path="/admin" element={<AdminPage apiBaseUrl={apiBaseUrl} />} />
      </Routes>
    </div>
  );
}
