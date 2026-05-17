import type { ReactNode } from "react";

export function App({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="logo">Conduit</span>
        <span className="tag">browser lab</span>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
