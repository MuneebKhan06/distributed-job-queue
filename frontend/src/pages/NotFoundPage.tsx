export default function NotFoundPage({ path }: { path: string }) {
  return (
    <section className="card notice-card">
      <p>
        Nothing lives at <span className="mono">#{path}</span>
      </p>
      <p className="muted">
        The address may have a typo, or come from an older version of the dashboard.
      </p>
      <div className="notice-actions">
        <a href="#/">Go to the overview</a>
        <a href="#/jobs">Browse jobs</a>
      </div>
    </section>
  );
}
