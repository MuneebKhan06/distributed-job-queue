import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches an error thrown while a page renders.
 *
 * Without it React unmounts the whole tree, so one bad response shape on one
 * page left a blank white window with no sidebar and no way back except a
 * reload. The boundary sits inside the layout, so navigation keeps working,
 * and App keys it by path so moving to another page starts clean.
 */
export default class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console for whoever opens dev tools to report it.
    console.error("Page failed to render", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <section className="card notice-card" role="alert">
        <p>This page hit an error and could not be shown.</p>
        <p className="muted mono">{error.message}</p>
        <div className="notice-actions">
          <button type="button" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <a href="#/">Go to the overview</a>
        </div>
      </section>
    );
  }
}
