// Crow's foot notation markers, referenced by id from edge markerStart/markerEnd
// (see `parentEnd` / `childEnd` in lib/modelLevels.js):
//   erd-one       exactly one          ─┼┼
//   erd-zero-one  zero or one          ─○┼
//   erd-many      zero or many         ─○<
//   erd-one-many  one or many          ─┼<
// orient="auto-start-reverse" lets the same shape work at either end of a path.
const MARKERS = {
  'erd-one': <path d="M0 10 H24 M16 3 V17 M20 3 V17" className="erd-marker" />,
  'erd-zero-one': (
    <>
      <path d="M0 10 H24 M20 3 V17" className="erd-marker" />
      <circle cx="11" cy="10" r="4" className="erd-marker erd-marker--hollow" />
    </>
  ),
  'erd-one-many': <path d="M0 10 H24 M16 10 L24 2 M16 10 L24 18 M11 3 V17" className="erd-marker" />,
  'erd-many': (
    <>
      <path d="M0 10 H24 M16 10 L24 2 M16 10 L24 18" className="erd-marker" />
      <circle cx="10" cy="10" r="4" className="erd-marker erd-marker--hollow" />
    </>
  ),
};

export default function ErdMarkers() {
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden="true">
      <defs>
        {Object.entries(MARKERS).map(([id, shape]) => (
          <marker
            key={id}
            id={id}
            viewBox="0 0 24 20"
            refX="24"
            refY="10"
            markerWidth="18"
            markerHeight="15"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            {shape}
          </marker>
        ))}
      </defs>
    </svg>
  );
}
