import type { ReactNode } from "react";

export interface NavItem {
  path: string;
  label: string;
  badge?: string | null;
}

interface LayoutProps {
  title: string;
  nav: NavItem[];
  // Null on a page that is not in the sidebar, such as the not found page.
  activePath: string | null;
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
              <span>{item.label}</span>
              {item.badge && (
                <span className="nav-badge" aria-label={`${item.badge} dead jobs`}>
                  {item.badge}
                </span>
              )}
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
