interface PlaceholderProps {
  description: string;
}

export default function Placeholder({ description }: PlaceholderProps) {
  return (
    <section className="card">
      <p className="muted">{description}</p>
    </section>
  );
}
