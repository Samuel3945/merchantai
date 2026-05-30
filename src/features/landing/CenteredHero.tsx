export const CenteredHero = (props: {
  banner: React.ReactNode;
  title: React.ReactNode;
  description: string;
  buttons: React.ReactNode;
}) => (
  <>
    <div className="text-center">{props.banner}</div>

    <div className="
      mt-4 text-center font-display text-5xl font-medium tracking-tight
      sm:text-6xl
    "
    >
      {props.title}
    </div>

    <div className="
      mx-auto mt-5 max-w-3xl text-center text-xl text-muted-foreground
    "
    >
      {props.description}
    </div>

    <div className="
      mt-8 flex justify-center gap-x-5 gap-y-3
      max-sm:flex-col
    "
    >
      {props.buttons}
    </div>
  </>
);
