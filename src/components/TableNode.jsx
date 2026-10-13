import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { TABLE_HANDLE_IN, TABLE_HANDLE_OUT, visibleColumns } from '../lib/layout.js';

const TYPE_BADGE = {
  VIEW: 'view',
  MATERIALIZED_VIEW: 'mv',
  STREAMING_TABLE: 'st',
  EXTERNAL: 'ext',
  FOREIGN: 'foreign',
  EXTERNAL_REFERENCE: 'ref',
};

function TableNode({ data }) {
  const { table, columnMode, highlightColumns } = data;
  const columns = visibleColumns(table, columnMode);
  const hidden = table.columns.length - columns.length;
  const badge = TYPE_BADGE[table.type];

  return (
    <div className={`table-node${table.external ? ' external' : ''}`}>
      <div className="table-node__header" title={table.comment || table.id}>
        <Handle type="target" position={Position.Left} id={TABLE_HANDLE_IN} className="erd-handle" />
        <span className="table-node__name">{table.name}</span>
        {badge && <span className="table-node__badge">{badge}</span>}
        {table.external && <span className="table-node__schema">{table.schema}</span>}
        <Handle type="source" position={Position.Right} id={TABLE_HANDLE_OUT} className="erd-handle" />
      </div>
      {columns.map((c) => (
        <div
          key={c.name}
          className={`table-node__row${highlightColumns?.has(c.name) ? ' highlight' : ''}`}
          title={c.comment || undefined}
        >
          <Handle type="target" position={Position.Left} id={`${c.name}-in`} className="erd-handle" />
          <span className="table-node__keys">
            {c.pk && <span className="key pk" title="Primary key">PK</span>}
            {c.fk && <span className="key fk" title="Foreign key">FK</span>}
          </span>
          <span className={`table-node__col${c.nullable ? '' : ' required'}`}>{c.name}</span>
          <span className="table-node__type">{c.type}</span>
          <Handle type="source" position={Position.Right} id={`${c.name}-out`} className="erd-handle" />
        </div>
      ))}
      {hidden > 0 && columnMode !== 'none' && (
        <div className="table-node__more">+{hidden} more column{hidden === 1 ? '' : 's'}</div>
      )}
    </div>
  );
}

export default memo(TableNode);
