interface PagerProps {
  page: number;
  pageSize: number;
  shown: number;
  hasNext: boolean;
  onPage: (page: number) => void;
}

export default function Pager({ page, pageSize, shown, hasNext, onPage }: PagerProps) {
  if (page === 0 && !hasNext) {
    return null;
  }

  const first = page * pageSize + 1;
  const last = page * pageSize + shown;

  return (
    <div className="pager">
      <span className="muted">{shown > 0 ? `Showing ${first} to ${last}` : "Nothing on this page"}</span>
      <div className="pager-buttons">
        <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)}>
          Newer
        </button>
        <button type="button" disabled={!hasNext} onClick={() => onPage(page + 1)}>
          Older
        </button>
      </div>
    </div>
  );
}
