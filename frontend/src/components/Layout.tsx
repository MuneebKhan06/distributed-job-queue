import type { ReactNode } from "react";

export interface NavItem {
  path: string;
  label: string;
}

interface LayoutProps {
  title: string;
  nav: NavItem[];
  activePath: string;
  status?: ReactNode;
  children: ReactNode;
}

export default function Layout({ title, nav, activePath, status, children }: LayoutProps) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Job Queue</div>
        <nav className="nav">
          {nav.map((item) => (
            <a
              key={item.path}
              href={`#${item.path}`}
              className={item.path === activePath ? "active" : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
          {status}
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
