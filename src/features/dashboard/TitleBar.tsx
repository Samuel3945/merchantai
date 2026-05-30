export const TitleBar = (props: {
  title: React.ReactNode;
  description?: React.ReactNode;
}) => (
  <div className="mb-8">
    <div className="font-display text-3xl font-medium tracking-tight">
      {props.title}
    </div>

    {props.description && (
      <div className="mt-1 text-sm text-muted-foreground">
        {props.description}
      </div>
    )}
  </div>
);
