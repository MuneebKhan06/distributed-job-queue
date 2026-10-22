import HealthIndicator from "./components/HealthIndicator";
import Layout, { type NavItem } from "./components/Layout";
import { useHashRoute } from "./hooks/useHashRoute";
import JobDetailPage from "./pages/JobDetailPage";
import JobsPage from "./pages/JobsPage";
import Placeholder from "./pages/Placeholder";
import SubmitPage from "./pages/SubmitPage";

const NAV: NavItem[] = [
  { path: "/", label: "Overview" },
  { path: "/jobs", label: "Jobs" },
  { path: "/submit", label: "Submit job" },
  { path: "/dlq", label: "Dead letter queue" },
];

const DESCRIPTIONS: Record<string, string> = {
  "/": "Queue depth, throughput and failure rates at a glance.",
  "/jobs": "Every job with its status, priority and attempts.",
  "/submit": "Send a transform, validate or compute job to the queue.",
  "/dlq": "Jobs that ran out of retries, ready to inspect and replay.",
};

const JOB_DETAIL = /^\/jobs\/([^/]+)$/;

export default function App() {
  const { path, params } = useHashRoute();
  const detailMatch = JOB_DETAIL.exec(path);
  const jobId = detailMatch ? decodeURIComponent(detailMatch[1]) : null;

  // A job's own page sits under Jobs in the sidebar.
  const navPath = jobId ? "/jobs" : path;
  const active = NAV.find((item) => item.path === navPath) ?? NAV[0];
  const title = jobId ? `Job ${jobId.slice(0, 8)}` : active.label;

  let page;
  if (jobId) {
    // Keyed so moving between two jobs starts clean instead of briefly
    // showing the first job's details under the second one's URL.
    page = <JobDetailPage key={jobId} jobId={jobId} />;
  } else if (active.path === "/jobs") {
    page = <JobsPage params={params} />;
  } else if (active.path === "/submit") {
    page = <SubmitPage />;
  } else {
    page = <Placeholder description={DESCRIPTIONS[active.path]} />;
  }

  return (
    <Layout title={title} nav={NAV} activePath={active.path} status={<HealthIndicator />}>
      {page}
    </Layout>
  );
}
