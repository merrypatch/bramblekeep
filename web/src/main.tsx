import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import "@fontsource/dancing-script/600.css"; // brand wordmark font (self-hosted, no CDN)
import "@fontsource/dancing-script/700.css";

import { Toaster } from "@/components/ui/sonner";
import { applyAccent, applyGrid, getAccent, getGrid } from "@/lib/appearance";
import { applyTheme, getTheme, watchSystem } from "@/lib/theme";
import "@/i18n"; // initialise i18next (side-effect) before first render
import App from "./App.tsx";
import "./index.css";

// Theme (light/dark/system) via the `.dark` class on <html>: our shadcn tokens
// AND BlockNote (`:where(.dark,*)` selectors) align to it.
applyTheme(getTheme());
watchSystem();
// Custom appearance (background grid + accent) via data-attrs on <html>.
applyGrid(getGrid());
applyAccent(getAccent());

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <Toaster richColors position="bottom-right" />
    </BrowserRouter>
  </StrictMode>,
);
