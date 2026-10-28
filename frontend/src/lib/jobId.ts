// The API types job_id as a UUID, so anything else in the address bar is a
// typo or a truncated paste. Checking here gives a plain answer instead of
// FastAPI's 422 wording, and saves a request that can only fail.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isJobId(value: string): boolean {
  return UUID.test(value);
}
