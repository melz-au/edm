// Crow's foot notation markers, referenced by id from edge markerStart/markerEnd.
// orient="auto-start-reverse" lets the same shape work at either end of a path.
export default function ErdMarkers() {
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden="true">
      <defs>
        <marker
          id="erd-one"
          viewBox="0 0 20 20"
          refX="20"
          refY="10"
          markerWidth="20"
          markerHeight="20"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path d="M0 10 H20 M12 3 V17 M16 3 V17" className="erd-marker" />
        </marker>
        <marker
          id="erd-many"
          viewBox="0 0 20 20"
          refX="20"
          refY="10"
          markerWidth="20"
          markerHeight="20"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path d="M0 10 H20 M8 10 L20 2 M8 10 L20 18 M5 3 V17" className="erd-marker" />
        </marker>
      </defs>
    </svg>
  );
}
