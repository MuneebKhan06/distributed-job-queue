import HealthIndicator from "./components/HealthIndicator";
import Layout, { type NavItem } from "./components/Layout";
import { useHashRoute } from "./hooks/useHashRoute";
import JobsPage from "./pages/JobsPage";
import Placeholder from "./pages/Placeholder";

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

export default function App() {
  const path = useHashRoute();
  const active = NAV.find((item) => item.path === path) ?? NAV[0];

  return (
    <Layout
      title={active.label}
      nav={NAV}
      activePath={active.path}
      status={<HealthIndicator />}
    >
      {active.path === "/jobs" ? (
        <JobsPage />
      ) : (
        <Placeholder description={DESCRIPTIONS[active.path]} />
      )}
    </Layout>
  );
}
