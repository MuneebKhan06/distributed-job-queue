import HealthIndicator from "./components/HealthIndicator";
import Layout, { type NavItem } from "./components/Layout";
import { useDeadCount } from "./hooks/useDeadCount";
import { useHashRoute } from "./hooks/useHashRoute";
import DlqPage from "./pages/DlqPage";
import JobDetailPage from "./pages/JobDetailPage";
import JobsPage from "./pages/JobsPage";
import OverviewPage from "./pages/OverviewPage";
import SubmitPage from "./pages/SubmitPage";

const NAV: NavItem[] = [
  { path: "/", label: "Overview" },
  { path: "/jobs", label: "Jobs" },
  { path: "/submit", label: "Submit job" },
  { path: "/dlq", label: "Dead letter queue" },
];

const JOB_DETAIL = /^\/jobs\/([^/]+)$/;

export default function App() {
  const { path, params } = useHashRoute();
  const deadCount = useDeadCount();
  const nav = NAV.map((item) => (item.path === "/dlq" ? { ...item, badge: deadCount } : item));
  const detailMatch = JOB_DETAIL.exec(path);
  const jobId = detailMatch ? decodeURIComponent(detailMatch[1]) : null;

  // A job's own page sits under Jobs in the sidebar. An unknown path falls
  // back to the overview.
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
  } else if (active.path === "/dlq") {
    page = <DlqPage />;
  } else {
    page = <OverviewPage />;
  }

  return (
    <Layout title={title} nav={nav} activePath={active.path} status={<HealthIndicator />}>
      {page}
    </Layout>
  );
}
