import type { ReactNode } from "react";
import { AppHeader } from "./components/AppHeader";

export function App({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">{children}</main>
    </div>
  );
}
