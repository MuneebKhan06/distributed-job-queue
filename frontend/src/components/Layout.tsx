import { type ReactNode, useEffect, useRef } from "react";

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
  // Hash navigation never reloads the page, so after a click in the sidebar
  // focus stayed on the link and a screen reader announced nothing: the new
  // page arrived silently. Focus moves to the heading instead, which reads
  // out the page's name, and Tab carries on from the top of its content.
  // Skipped on first load, where taking focus would only get in the way.
  const heading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    heading.current?.focus();
  }, [title]);

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
          <h1 ref={heading} tabIndex={-1}>
            {title}
          </h1>
          {status}
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
